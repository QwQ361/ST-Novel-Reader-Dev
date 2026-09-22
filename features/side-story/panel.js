// features/side-story/panel.js
// 番外指令库浮动面板。
// 布局：单列流式（toolbar + 搜索/tag筛选 + 指令列表）。
// 交互：
//   - tag：管理弹窗（批量新增/全选/框选/反选/删除/重命名）、下拉筛选、指令行胶囊、批量设置标签
//   - 指令：新建（手写）、重命名、删除、从 txt 导入、收藏、批量操作（全选/框选/重命名/删除/设置标签）
//   - 点击指令 → 追加到输入框末尾（#send_textarea 已有内容则追加，空则直接填入）
// 面板挂 document.body 的 fixed 浮动层。

/**
 * 创建番外指令库浮动面板。
 * @param {object} deps 依赖注入
 * @param {object}   deps.commandLib  指令库核心（createCommandLibCore 返回）
 * @param {Function} deps.getEnabled  () => boolean 番外功能是否启用
 * @param {Function} deps.getTextarea () => HTMLElement|null 输入框 #send_textarea
 * @param {Function} deps.toast       (msg) => void 轻提示
 * @returns {object} 面板 API（toggle / open / close / refresh）
 */
export function createSideStoryPanel(deps) {
  const { commandLib, getEnabled, getTextarea, toast = () => {} } = deps;

  let panelEl = null;
  let mounted = false;
  // 搜索栏 tag 筛选下拉面板状态
  let tagFilterDropdown = null;
  // 搜索框文本是唯一事实来源：tag 筛选 / 模糊词均从文本解析得出（"，"或","分隔）
  let searchQuery = "";
  // 批量操作状态
  let batchMode = false;
  let batchSelected = new Set();
  let batchLastClicked = null;
  let batchRangeMode = false;

  // ---------------- 工具 ----------------

  function escapeHtml(str) {
    const el = document.createElement("span");
    el.textContent = String(str ?? "");
    return el.innerHTML;
  }

  /**
   * 解析搜索框文本 → 筛选条件（所有条件 AND）：
   * - 精确匹配 tag 名的词 → tag 条件（指令需同时具备这些 tag）
   * - 「未标记」「收藏」等特殊词 → 特殊条件
   * - 其余词 → 标题/内容模糊条件（大小写不敏感包含）
   * 分隔符：中文逗号「，」或英文逗号「,」，支持混合与连续分隔。
   */
  function parseSearchQuery() {
    const tags = commandLib.listTags();
    const nameToId = {};
    for (const tag of Object.values(tags)) nameToId[tag.name.trim()] = tag.id;
    const tagIds = new Set();
    const specials = new Set();
    const words = [];
    for (const raw of searchQuery.split(/[，,]/)) {
      const seg = String(raw || "").trim();
      if (!seg) continue;
      const lower = seg.toLowerCase();
      if (lower === "未标记") {
        specials.add("__untagged__");
      } else if (lower === "收藏" || lower === "⭐收藏" || lower === "star") {
        specials.add("__favorites__");
      } else if (nameToId[seg]) {
        tagIds.add(nameToId[seg]);
      } else {
        words.push(lower);
      }
    }
    return { tagIds, specials, words };
  }

  /** 当前可见指令列表：解析搜索文本 → 所有条件 AND 过滤 */
  function getVisibleCommands() {
    let list = Object.values(commandLib.listCommands());
    const cond = parseSearchQuery();
    if (cond.tagIds.size || cond.specials.size || cond.words.length) {
      list = list.filter((c) => {
        const cmdTags = Array.isArray(c.tagIds) ? c.tagIds : [];
        // tag 条件：全部命中（AND）
        for (const tid of cond.tagIds) {
          if (!cmdTags.includes(tid)) return false;
        }
        // 特殊条件：未标记 / 收藏
        if (cond.specials.has("__untagged__") && cmdTags.length !== 0)
          return false;
        if (cond.specials.has("__favorites__") && !c.favorite) return false;
        // 模糊词：标题(name)/内容(text) 任一包含（AND 全部词）
        for (const w of cond.words) {
          const hit =
            String(c.text || "")
              .toLowerCase()
              .includes(w) ||
            String(c.name || "")
              .toLowerCase()
              .includes(w);
          if (!hit) return false;
        }
        return true;
      });
    }
    return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /** 批量选择切换（支持 Shift / 框选范围选择） */
  function toggleBatchItem(id, shiftKey) {
    if ((shiftKey || batchRangeMode) && batchLastClicked) {
      const visible = getVisibleCommands().map((c) => c.id);
      const lastIdx = visible.indexOf(batchLastClicked);
      const curIdx = visible.indexOf(id);
      if (lastIdx >= 0 && curIdx >= 0) {
        const start = Math.min(lastIdx, curIdx);
        const end = Math.max(lastIdx, curIdx);
        for (let i = start; i <= end; i++) batchSelected.add(visible[i]);
      }
    } else {
      if (batchSelected.has(id)) batchSelected.delete(id);
      else batchSelected.add(id);
    }
    batchLastClicked = id;
  }

  /** 全选/全不选当前可见指令 */
  function toggleSelectAllVisible() {
    const visible = getVisibleCommands().map((c) => c.id);
    const allSelected =
      visible.length > 0 && visible.every((id) => batchSelected.has(id));
    if (allSelected) visible.forEach((id) => batchSelected.delete(id));
    else visible.forEach((id) => batchSelected.add(id));
  }

  // ---------------- 批量重命名弹窗（Promise 模式） ----------------

  /** 求公共前缀（传入名称数组） */
  function findCommonPrefix(names) {
    if (!names.length) return "";
    let p = names[0];
    for (const n of names) {
      while (n.indexOf(p) !== 0 && p) p = p.slice(0, -1);
      if (!p) break;
    }
    return p;
  }

  /** 求公共后缀（先反转再求前缀） */
  function findCommonSuffix(names) {
    const rev = names.map((n) => [...n].reverse().join(""));
    const p = findCommonPrefix(rev);
    return [...p].reverse().join("");
  }

  /** 名称预览 HTML：≤5 个全列，>5 个列前 5 + “...等共 N 个” */
  function nameListHtml(names) {
    const shown = names.slice(0, 5);
    let html = shown
      .map(
        (n) => `<span class="novel-ss-edit-name-item">${escapeHtml(n)}</span>`,
      )
      .join("");
    if (names.length > 5) {
      html += `<span class="novel-ss-edit-name-item novel-ss-edit-name-more">…等共 ${names.length} 个</span>`;
    }
    return html;
  }

  /**
   * 批量重命名弹窗（Promise 模式，五种操作：增加/删除前后缀 + 逐个重命名）。
   * @param {Array<{id:string, name:string}>} items 选中指令 {id, name}
   * @returns {Promise<object|null>}
   *   - 批量操作 → { mode:"batch", action:"add-prefix"|"add-suffix"|"del-prefix"|"del-suffix", text }
   *   - 逐个重命名 → { mode:"individual", renameMap:{ [id]: 新名称 } }
   *   - 取消 → null
   */
  function showBatchRenamePopup(items) {
    const names = items.map((it) => it.name || "");
    const overlay = document.createElement("div");
    overlay.className = "novel-ss-edit-popup-overlay";
    overlay.innerHTML = `
      <div class="novel-ss-edit-popup">
        <div class="novel-ss-edit-popup-title">批量重命名 ${items.length} 条指令</div>
        <div class="novel-ss-edit-popup-names">${nameListHtml(names)}</div>
        <div class="novel-ss-edit-popup-field">
          <label>操作类型</label>
          <select class="novel-ss-edit-input novel-ss-rename-action">
            <option value="add-prefix">增加前缀</option>
            <option value="add-suffix">增加后缀</option>
            <option value="del-prefix">删除前缀</option>
            <option value="del-suffix">删除后缀</option>
            <option value="individual">逐个重命名</option>
          </select>
        </div>
        <div class="novel-ss-edit-popup-field novel-ss-rename-text-field">
          <label class="novel-ss-rename-text-label">前缀内容</label>
          <input type="text" class="novel-ss-edit-input novel-ss-rename-text" placeholder="输入要添加的前缀" autocomplete="off" />
        </div>
        <div class="novel-ss-edit-popup-field novel-ss-rename-auto-detect" style="display:none">
          <label>自动检测到的公共前/后缀</label>
          <div class="novel-ss-rename-detected"></div>
        </div>
        <div class="novel-ss-rename-individual-field" style="display:none">
          <label>逐个指定新名称（留空则不修改）</label>
          <div class="novel-ss-rename-individual-list">
            ${items
              .map(
                (it) => `
              <div class="novel-ss-rename-individual-row" data-id="${escapeHtml(it.id)}">
                <span class="novel-ss-rename-old-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name || "（未命名）")}</span>
                <span class="novel-ss-rename-arrow">→</span>
                <input type="text" class="novel-ss-rename-new-input" placeholder="留空则不修改" value="" autocomplete="off" />
              </div>`,
              )
              .join("")}
          </div>
        </div>
        <div class="novel-ss-edit-popup-actions">
          <button class="novel-ss-edit-popup-cancel">取消</button>
          <button class="novel-ss-edit-popup-confirm">确认</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const select = overlay.querySelector(".novel-ss-rename-action");
    const textField = overlay.querySelector(".novel-ss-rename-text-field");
    const textLabel = overlay.querySelector(".novel-ss-rename-text-label");
    const textInput = overlay.querySelector(".novel-ss-rename-text");
    const autoDetect = overlay.querySelector(".novel-ss-rename-auto-detect");
    const detected = overlay.querySelector(".novel-ss-rename-detected");
    const individualField = overlay.querySelector(
      ".novel-ss-rename-individual-field",
    );
    const namesBlock = overlay.querySelector(".novel-ss-edit-popup-names");

    /** 渲染检测胶囊：点击将实际前后缀值填入输入框并聚焦 */
    function bindDetectCapsule(label, value) {
      detected.innerHTML = "";
      const cap = document.createElement("span");
      cap.className = "novel-ss-edit-detect-item";
      cap.textContent = label;
      cap.title = "点击填入";
      cap.addEventListener("click", () => {
        textInput.value = value;
        textInput.focus();
      });
      detected.appendChild(cap);
    }

    /** 统一控制 文本区 / 检测区 / 逐个表格 的显隐与文案 */
    function updateRenameUI() {
      const action = select.value;
      if (action === "individual") {
        textField.style.display = "none";
        autoDetect.style.display = "none";
        namesBlock.style.display = "none";
        individualField.style.display = "flex";
        const first = individualField.querySelector(
          ".novel-ss-rename-new-input",
        );
        first?.focus();
        return;
      }
      individualField.style.display = "none";
      textField.style.display = "flex";
      namesBlock.style.display = "flex";
      if (action === "add-prefix") {
        textLabel.textContent = "前缀内容";
        textInput.placeholder = "输入要添加的前缀";
        autoDetect.style.display = "none";
      } else if (action === "add-suffix") {
        textLabel.textContent = "后缀内容";
        textInput.placeholder = "输入要添加的后缀";
        autoDetect.style.display = "none";
      } else if (action === "del-prefix") {
        textLabel.textContent = "要删除的前缀";
        textInput.placeholder = "输入要删除的前缀，或点击下方自动检测结果";
        autoDetect.style.display = "flex";
        const p = findCommonPrefix(names);
        if (p) bindDetectCapsule(`公共前缀「${p}」`, p);
        else
          detected.innerHTML =
            '<span class="novel-ss-edit-detect-none">未检测到公共前缀</span>';
      } else if (action === "del-suffix") {
        textLabel.textContent = "要删除的后缀";
        textInput.placeholder = "输入要删除的后缀，或点击下方自动检测结果";
        autoDetect.style.display = "flex";
        const s = findCommonSuffix(names);
        if (s) bindDetectCapsule(`公共后缀「${s}」`, s);
        else
          detected.innerHTML =
            '<span class="novel-ss-edit-detect-none">未检测到公共后缀</span>';
      }
    }
    select.addEventListener("change", updateRenameUI);
    updateRenameUI();

    return new Promise((resolve) => {
      const finish = (value) => {
        overlay.remove();
        resolve(value);
      };
      // 取消
      overlay
        .querySelector(".novel-ss-edit-popup-cancel")
        .addEventListener("click", () => finish(null));
      // 遮罩点击关闭
      overlay.addEventListener("click", (e) => {
        if (e.target.classList.contains("novel-ss-edit-popup-overlay"))
          finish(null);
      });
      // 确认
      overlay
        .querySelector(".novel-ss-edit-popup-confirm")
        .addEventListener("click", () => {
          const action = select.value;
          if (action === "individual") {
            const renameMap = {};
            overlay
              .querySelectorAll(".novel-ss-rename-individual-row")
              .forEach((row) => {
                const input = row.querySelector(".novel-ss-rename-new-input");
                const newName = input.value.trim();
                if (newName) renameMap[row.dataset.id] = newName;
              });
            finish({ mode: "individual", renameMap });
          } else {
            finish({ mode: "batch", action, text: textInput.value.trim() });
          }
        });
      // 键盘：Enter 确认 / Escape 取消
      textInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          overlay.querySelector(".novel-ss-edit-popup-confirm").click();
        } else if (e.key === "Escape") {
          overlay.querySelector(".novel-ss-edit-popup-cancel").click();
        }
      });
      individualField
        .querySelectorAll(".novel-ss-rename-new-input")
        .forEach((inp) => {
          inp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              overlay.querySelector(".novel-ss-edit-popup-confirm").click();
            } else if (e.key === "Escape") {
              overlay.querySelector(".novel-ss-edit-popup-cancel").click();
            }
          });
        });
    });
  }

  /** 批量重命名：按弹窗结果执行五种操作，带统计汇总 */
  async function batchRenameSelected() {
    const cmds = commandLib.listCommands();
    const ids = Array.from(batchSelected).filter((id) => cmds[id]);
    if (!ids.length) {
      toast("请先选择指令");
      return;
    }
    const items = ids.map((id) => ({ id, name: cmds[id]?.name || "" }));
    const result = await showBatchRenamePopup(items);
    if (!result) return;

    let success = 0;
    let skipped = 0;
    let failed = 0;

    if (result.mode === "batch") {
      const { action, text } = result;
      if (!text) {
        toast("请输入内容");
        return;
      }
      for (const id of ids) {
        const oldName = String(cmds[id]?.name || "");
        let newName;
        if (action === "add-prefix") {
          newName = text + oldName;
        } else if (action === "add-suffix") {
          newName = oldName + text;
        } else if (action === "del-prefix") {
          if (!oldName.startsWith(text)) {
            skipped++;
            continue;
          }
          newName = oldName.substring(text.length);
        } else if (action === "del-suffix") {
          if (!oldName.endsWith(text)) {
            skipped++;
            continue;
          }
          newName = oldName.substring(0, oldName.length - text.length);
        }
        if (commandLib.updateCommand(id, { name: newName })) success++;
        else failed++;
      }
    } else if (result.mode === "individual") {
      const { renameMap } = result;
      for (const id of ids) {
        const newName = renameMap[id];
        if (!newName) {
          skipped++;
          continue;
        }
        if (newName === String(cmds[id]?.name || "")) {
          skipped++;
          continue;
        }
        if (commandLib.updateCommand(id, { name: newName })) success++;
        else failed++;
      }
    }

    let msg = `批量重命名完成：成功 ${success} 个`;
    if (skipped > 0) msg += `，跳过 ${skipped} 个`;
    if (failed > 0) msg += `，失败 ${failed} 个`;
    toast(msg);
    render();
  }

  /** 批量删除：确认后删除所有选中的指令 */
  function batchDeleteSelected() {
    const cmds = commandLib.listCommands();
    const ids = Array.from(batchSelected).filter((id) => cmds[id]);
    if (!ids.length) {
      toast("请先选择指令");
      return;
    }
    if (
      !window.confirm(`确定删除选中的 ${ids.length} 条指令？此操作不可撤销。`)
    )
      return;
    let n = 0;
    for (const id of ids) {
      if (commandLib.deleteCommand(id)) n++;
    }
    batchSelected.clear();
    batchLastClicked = null;
    toast(`已删除 ${n} 条指令`);
    render();
  }

  // ---------------- tag 管理弹窗 ----------------

  /** 渲染 tag 管理弹窗（批量新增 / 全选 / 框选 / 反选 / 删除 / 重命名） */
  function showTagManagePopup() {
    const overlay = document.createElement("div");
    overlay.className = "novel-ss-edit-popup-overlay";
    overlay.innerHTML = `
      <div class="novel-ss-edit-popup novel-ss-tag-manage">
        <div class="novel-ss-edit-popup-title">管理标签</div>
        <div class="novel-ss-tag-manage-new">
          <input type="text" class="novel-ss-edit-input novel-ss-tag-new-input" placeholder="输入标签名，多个用逗号分隔（如：tag1，tag2）" autocomplete="off" />
          <button class="novel-ss-tag-manage-add">＋ 新增标签</button>
        </div>
        <div class="novel-ss-tag-manage-toolbar">
          <button class="novel-ss-tag-btn novel-ss-tag-selall"><i class="fa-solid fa-square-check"></i> 全选</button>
          <button class="novel-ss-tag-btn novel-ss-tag-range"><i class="fa-solid fa-arrow-down-short-wide"></i> 框选</button>
          <button class="novel-ss-tag-btn novel-ss-tag-invert"><i class="fa-solid fa-arrows-rotate"></i> 反选</button>
          <span class="novel-ss-tag-manage-count"></span>
          <button class="novel-ss-tag-btn novel-ss-tag-del-selected"><i class="fa-solid fa-trash"></i> 删除选中</button>
        </div>
        <div class="novel-ss-tag-manage-list"></div>
        <div class="novel-ss-edit-popup-actions">
          <button class="novel-ss-edit-popup-cancel">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector(".novel-ss-tag-manage-list");
    const countEl = overlay.querySelector(".novel-ss-tag-manage-count");
    const newInput = overlay.querySelector(".novel-ss-tag-new-input");
    let tagSelected = new Set();
    let tagRangeMode = false;
    let tagLastClicked = null;

    /** 渲染 tag 列表 */
    function renderTagList() {
      const tags = Object.values(commandLib.listTags()).sort((a, b) =>
        String(a.name).localeCompare(String(b.name), "zh-Hans-CN"),
      );
      listEl.innerHTML = "";
      if (!tags.length) {
        listEl.innerHTML =
          '<div class="novel-ss-empty">暂无标签，可在上方输入框创建</div>';
      }
      tags.forEach((tag) => {
        const row = document.createElement("div");
        const checked = tagSelected.has(tag.id);
        const cmdCount = commandLib.listCommandsByTag(tag.id).length;
        row.className =
          "novel-ss-tag-row" + (checked ? " novel-ss-tag-row-selected" : "");
        row.dataset.tagId = tag.id;
        row.innerHTML = `
          <i class="${checked ? "fa-solid fa-square-check" : "fa-regular fa-square"} novel-ss-tag-row-check" title="选择"></i>
          <span class="novel-ss-tag-chip">${escapeHtml(tag.name)}</span>
          <span class="novel-ss-tag-manage-count">${cmdCount} 条</span>
          <span class="novel-ss-tag-manage-actions">
            <i class="fa-solid fa-pen novel-ss-tag-rename" title="重命名"></i>
            <i class="fa-solid fa-trash novel-ss-tag-del" title="删除"></i>
          </span>`;
        // 行点击：切换选中（支持 Shift / 框选范围）
        row.addEventListener("click", (e) => {
          if (e.target.closest(".novel-ss-tag-manage-actions")) return;
          if ((e.shiftKey || tagRangeMode) && tagLastClicked) {
            const ids = tags.map((t) => t.id);
            const lastIdx = ids.indexOf(tagLastClicked);
            const curIdx = ids.indexOf(tag.id);
            if (lastIdx >= 0 && curIdx >= 0) {
              const start = Math.min(lastIdx, curIdx);
              const end = Math.max(lastIdx, curIdx);
              for (let i = start; i <= end; i++) tagSelected.add(ids[i]);
            }
          } else {
            if (tagSelected.has(tag.id)) tagSelected.delete(tag.id);
            else tagSelected.add(tag.id);
          }
          tagLastClicked = tag.id;
          renderTagList();
        });
        // 重命名
        row
          .querySelector(".novel-ss-tag-rename")
          .addEventListener("click", (e) => {
            e.stopPropagation();
            const name = window.prompt("重命名标签：", tag.name);
            if (!name) return;
            if (commandLib.renameTag(tag.id, name.trim())) {
              toast("已重命名标签");
              renderTagList();
              render();
            } else {
              toast("重命名失败：名称不能为空或已存在");
            }
          });
        // 单个删除
        row
          .querySelector(".novel-ss-tag-del")
          .addEventListener("click", (e) => {
            e.stopPropagation();
            if (
              !window.confirm(
                `确定删除标签「${tag.name}」？该操作将从所有指令中移除该标签。`,
              )
            )
              return;
            commandLib.deleteTag(tag.id);
            tagSelected.delete(tag.id);
            toast("已删除标签");
            renderTagList();
            render();
          });
        listEl.appendChild(row);
      });
      countEl.textContent = `已选 ${tagSelected.size} 项`;
      const selall = overlay.querySelector(".novel-ss-tag-selall");
      if (selall)
        selall.innerHTML =
          tagSelected.size === tags.length && tags.length > 0
            ? '<i class="fa-solid fa-square-xmark"></i> 取消全选'
            : '<i class="fa-solid fa-square-check"></i> 全选';
    }

    // 批量新增：逗号分隔一次创建多个（中英文逗号均可）
    function addNewTags() {
      const text = newInput.value.trim();
      if (!text) {
        toast("请输入标签名");
        return;
      }
      const created = commandLib.createTags(text);
      if (created.length) {
        toast(`已新增 ${created.length} 个标签（重复已跳过）`);
        newInput.value = "";
        renderTagList();
        render();
      } else {
        toast("没有新增：名称为空或已存在");
      }
    }
    overlay
      .querySelector(".novel-ss-tag-manage-add")
      .addEventListener("click", addNewTags);
    newInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addNewTags();
      } else if (e.key === "Escape") {
        overlay.querySelector(".novel-ss-edit-popup-cancel").click();
      }
    });

    // 全选 / 反选
    overlay
      .querySelector(".novel-ss-tag-selall")
      .addEventListener("click", () => {
        const tags = Object.values(commandLib.listTags());
        const allSelected =
          tags.length > 0 && tags.every((t) => tagSelected.has(t.id));
        if (allSelected) tagSelected.clear();
        else tags.forEach((t) => tagSelected.add(t.id));
        renderTagList();
      });
    overlay
      .querySelector(".novel-ss-tag-invert")
      .addEventListener("click", () => {
        const tags = Object.values(commandLib.listTags());
        const cur = new Set(tagSelected);
        tagSelected.clear();
        tags.forEach((t) => {
          if (!cur.has(t.id)) tagSelected.add(t.id);
        });
        renderTagList();
      });
    // 框选模式
    overlay
      .querySelector(".novel-ss-tag-range")
      .addEventListener("click", (e) => {
        tagRangeMode = !tagRangeMode;
        e.currentTarget.classList.toggle(
          "novel-ss-tag-btn-active",
          tagRangeMode,
        );
      });
    // 批量删除选中
    overlay
      .querySelector(".novel-ss-tag-del-selected")
      .addEventListener("click", () => {
        const ids = Array.from(tagSelected);
        if (!ids.length) {
          toast("请先选择标签");
          return;
        }
        if (
          !window.confirm(
            `确定删除选中的 ${ids.length} 个标签？该操作将从所有指令中移除这些标签。`,
          )
        )
          return;
        const n = commandLib.deleteTags(ids);
        tagSelected.clear();
        tagLastClicked = null;
        toast(`已删除 ${n} 个标签`);
        renderTagList();
        render();
      });

    // 关闭
    const finish = () => overlay.remove();
    overlay
      .querySelector(".novel-ss-edit-popup-cancel")
      .addEventListener("click", finish);
    overlay.addEventListener("click", (e) => {
      if (e.target.classList.contains("novel-ss-edit-popup-overlay")) finish();
    });

    renderTagList();
    newInput.focus();
  }

  // ---------------- 指令 tag 管理弹窗（勾选/取消多 tag） ----------------

  /**
   * 单个指令标签弹窗：列出所有 tag 供勾选，保存后整体替换该指令 tagIds。
   * @param {string} cmdId 指令 id
   */
  function showCommandTagPopup(cmdId) {
    const cmd = commandLib.listCommands()[cmdId];
    if (!cmd) return;
    const current = new Set(cmd.tagIds || []);
    const overlay = document.createElement("div");
    overlay.className = "novel-ss-edit-popup-overlay";
    overlay.innerHTML = `
      <div class="novel-ss-edit-popup novel-ss-cmd-tag-popup">
        <div class="novel-ss-edit-popup-title">设置标签：${escapeHtml(cmd.name || cmd.text)}</div>
        <div class="novel-ss-cmd-tag-list"></div>
        <div class="novel-ss-edit-popup-actions">
          <button class="novel-ss-edit-popup-cancel">取消</button>
          <button class="novel-ss-edit-popup-confirm">保存</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector(".novel-ss-cmd-tag-list");
    const tags = Object.values(commandLib.listTags()).sort((a, b) =>
      String(a.name).localeCompare(String(b.name), "zh-Hans-CN"),
    );
    if (!tags.length) {
      listEl.innerHTML =
        '<div class="novel-ss-empty">暂无标签，请先在「管理标签」中创建</div>';
    }
    tags.forEach((tag) => {
      const row = document.createElement("div");
      const on = current.has(tag.id);
      row.className =
        "novel-ss-cmd-tag-row" + (on ? " novel-ss-cmd-tag-on" : "");
      row.innerHTML = `
        <i class="${on ? "fa-solid fa-square-check" : "fa-regular fa-square"} novel-ss-cmd-tag-check"></i>
        <span class="novel-ss-tag-chip">${escapeHtml(tag.name)}</span>`;
      row.addEventListener("click", () => {
        if (current.has(tag.id)) current.delete(tag.id);
        else current.add(tag.id);
        listEl.querySelectorAll(".novel-ss-cmd-tag-row").forEach((el, i) => {
          const t = tags[i];
          const on2 = current.has(t.id);
          el.classList.toggle("novel-ss-cmd-tag-on", on2);
          el.querySelector(".novel-ss-cmd-tag-check").className = on2
            ? "fa-solid fa-square-check novel-ss-cmd-tag-check"
            : "fa-regular fa-square novel-ss-cmd-tag-check";
        });
      });
      listEl.appendChild(row);
    });

    const finish = (value) => {
      overlay.remove();
      if (value) {
        commandLib.updateCommand(cmdId, { tagIds: Array.from(value) });
        toast("已更新标签");
        render();
      }
    };
    overlay
      .querySelector(".novel-ss-edit-popup-cancel")
      .addEventListener("click", () => finish(null));
    overlay
      .querySelector(".novel-ss-edit-popup-confirm")
      .addEventListener("click", () => finish(current));
    overlay.addEventListener("click", (e) => {
      if (e.target.classList.contains("novel-ss-edit-popup-overlay"))
        finish(null);
    });
  }

  // ---------------- 批量设置标签弹窗 ----------------

  /**
   * 批量设置标签：为选中 N 条指令批量设置标签。
   * 模仿批量重命名弹窗：操作类型支持「统一标签 / 逐个标签」两种模式。
   * - 统一标签：选一个 tag + 添加/移除 → 全部选中指令生效
   * - 逐个标签：每条指令一行「指令名 → 选择框」，点击选择框弹出 tag 下拉面板
   *   （挂 overlay 定位避免被滚动裁剪），面板内多选勾选；确认后按行整体替换 tagIds
   */
  function showBatchTagPopup() {
    const cmds = commandLib.listCommands();
    const ids = Array.from(batchSelected).filter((id) => cmds[id]);
    if (!ids.length) {
      toast("请先选择指令");
      return;
    }
    const names = ids.map((id) => cmds[id].name || cmds[id].text || "");
    const tags = Object.values(commandLib.listTags()).sort((a, b) =>
      String(a.name).localeCompare(String(b.name), "zh-Hans-CN"),
    );
    const overlay = document.createElement("div");
    overlay.className = "novel-ss-edit-popup-overlay";
    overlay.innerHTML = `
      <div class="novel-ss-edit-popup novel-ss-batch-tag-popup">
        <div class="novel-ss-edit-popup-title">批量设置标签：${ids.length} 条指令</div>
        <div class="novel-ss-edit-popup-names">${nameListHtml(names)}</div>
        <div class="novel-ss-edit-popup-field">
          <label>操作类型</label>
          <select class="novel-ss-edit-input novel-ss-batch-tag-mode">
            <option value="uniform">统一标签</option>
            <option value="individual">逐个标签</option>
          </select>
        </div>
        <div class="novel-ss-batch-tag-uniform">
          <div class="novel-ss-edit-popup-field">
            <label>操作</label>
            <select class="novel-ss-edit-input novel-ss-batch-tag-action">
              <option value="add">统一添加标签</option>
              <option value="overwrite">统一修改标签（覆盖）</option>
              <option value="remove">统一移除标签</option>
              <option value="clear">清空全部标签</option>
            </select>
          </div>
          <div class="novel-ss-batch-tag-utils">
            <button type="button" class="novel-ss-tag-btn novel-ss-batch-tag-selall">
              <i class="fa-solid fa-square-check"></i> 全选
            </button>
            <button type="button" class="novel-ss-tag-btn novel-ss-batch-tag-clear">
              <i class="fa-regular fa-square"></i> 清空
            </button>
          </div>
          <div class="novel-ss-batch-tag-list"></div>
        </div>
        <div class="novel-ss-batch-tag-individual" style="display:none">
          <label class="novel-ss-batch-tag-individual-label">逐个设置每条指令的标签（点击右侧框选择 tag）</label>
          <div class="novel-ss-batch-tag-individual-list"></div>
        </div>
        <div class="novel-ss-edit-popup-actions">
          <button class="novel-ss-edit-popup-cancel">取消</button>
          <button class="novel-ss-edit-popup-confirm">确认</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const modeSelect = overlay.querySelector(".novel-ss-batch-tag-mode");
    const uniformEl = overlay.querySelector(".novel-ss-batch-tag-uniform");
    const individualEl = overlay.querySelector(
      ".novel-ss-batch-tag-individual",
    );
    const listEl = overlay.querySelector(".novel-ss-batch-tag-list");
    const indivListEl = overlay.querySelector(
      ".novel-ss-batch-tag-individual-list",
    );
    const pickedSet = new Set(); // 统一模式：选中的多个 tag id
    const renderUniform = () => {
      const rows = listEl.querySelectorAll(".novel-ss-batch-tag-row");
      rows.forEach((row) => {
        const on = pickedSet.has(row.dataset.tagId);
        row.classList.toggle("novel-ss-batch-tag-on", on);
        const check = row.querySelector(".novel-ss-batch-tag-check");
        if (check) {
          check.className = on
            ? "fa-solid fa-square-check novel-ss-batch-tag-check"
            : "fa-regular fa-square novel-ss-batch-tag-check";
        }
      });
    };

    // ---- 统一模式：tag 列表（多选勾选） ----
    if (!tags.length) {
      listEl.innerHTML =
        '<div class="novel-ss-empty">暂无标签，请先在「管理标签」中创建</div>';
    }
    tags.forEach((tag) => {
      const row = document.createElement("div");
      row.className = "novel-ss-batch-tag-row";
      row.dataset.tagId = tag.id;
      row.innerHTML = `<i class="fa-regular fa-square novel-ss-batch-tag-check" title="选择"></i><span class="novel-ss-tag-chip">${escapeHtml(tag.name)}</span>`;
      row.addEventListener("click", () => {
        if (pickedSet.has(tag.id)) pickedSet.delete(tag.id);
        else pickedSet.add(tag.id);
        renderUniform();
      });
      listEl.appendChild(row);
    });

    // 全选 / 清空
    const selallBtn = overlay.querySelector(".novel-ss-batch-tag-selall");
    const clearBtn = overlay.querySelector(".novel-ss-batch-tag-clear");
    selallBtn.addEventListener("click", () => {
      tags.forEach((tag) => pickedSet.add(tag.id));
      renderUniform();
    });
    clearBtn.addEventListener("click", () => {
      pickedSet.clear();
      renderUniform();
    });

    // 操作 select：clear（清空全部标签）时隐藏 tag 选择列表，无需勾选
    const actionSelect = overlay.querySelector(".novel-ss-batch-tag-action");
    const uniformUtilsEl = overlay.querySelector(".novel-ss-batch-tag-utils");
    const uniformListWrapEl = listEl; // 列表容器
    function updateActionUI() {
      const act = actionSelect.value;
      const isClear = act === "clear";
      uniformUtilsEl.style.display = isClear ? "none" : "flex";
      uniformListWrapEl.style.display = isClear ? "none" : "flex";
      if (isClear) pickedSet.clear();
    }
    actionSelect.addEventListener("change", updateActionUI);
    updateActionUI();

    // ---- 逐个模式：每条指令一行（指令名 → 选择框 + 下拉面板） ----
    // 模仿逐个重命名行布局；点击选择框弹出 tag 下拉面板（挂 overlay 定位，
    // 避免被弹窗滚动裁剪），面板内多选勾选；确认后按行整体替换 tagIds。
    const rowStates = []; // { id, cur: Set<tagId> }，供 finish 收集
    const closeAllDropdowns = []; // 每行 closeDropdown 收集，统一关闭

    if (!tags.length) {
      indivListEl.innerHTML =
        '<div class="novel-ss-empty">暂无标签，请先在「管理标签」中创建</div>';
    }
    ids.forEach((id) => {
      const cmd = cmds[id];
      if (!cmd) return;
      const cur = new Set(cmd.tagIds || []);
      const row = document.createElement("div");
      row.className = "novel-ss-batch-tag-row novel-ss-batch-tag-row-indiv";
      row.dataset.id = id;
      // 指令名（左）
      const nameSpan = document.createElement("span");
      nameSpan.className = "novel-ss-batch-tag-cmd-name";
      nameSpan.textContent = cmd.name || cmd.text || "（未命名）";
      nameSpan.title = cmd.name || cmd.text || "";
      // 箭头
      const arrow = document.createElement("span");
      arrow.className = "novel-ss-batch-tag-arrow";
      arrow.textContent = "→";
      // 选择框（点击弹出下拉面板）
      const picker = document.createElement("div");
      picker.className = "novel-ss-batch-tag-picker";
      picker.title = "点击选择标签";
      /** 将当前已选 tag 渲染为胶囊（含可移除 ✕） */
      function renderPickerChips() {
        picker.innerHTML = "";
        if (!cur.size) {
          const ph = document.createElement("span");
          ph.className = "novel-ss-batch-tag-picker-placeholder";
          ph.textContent = "点击选择标签";
          picker.appendChild(ph);
          return;
        }
        tags.forEach((tag) => {
          if (!cur.has(tag.id)) return;
          const chip = document.createElement("span");
          chip.className = "novel-ss-tag-chip novel-ss-batch-tag-picker-chip";
          chip.dataset.tagId = tag.id;
          chip.textContent = tag.name + " ✕";
          chip.title = "点击移除";
          chip.addEventListener("click", (e) => {
            e.stopPropagation();
            cur.delete(tag.id);
            renderPickerChips();
            if (dropdown) renderDropdown();
          });
          picker.appendChild(chip);
        });
      }
      // 下拉面板（挂 overlay，fixed 定位）
      let dropdown = null;
      function closeDropdown() {
        if (dropdown) {
          dropdown.remove();
          dropdown = null;
        }
      }
      function renderDropdown() {
        if (!dropdown) return;
        dropdown.innerHTML = "";
        if (!tags.length) {
          dropdown.innerHTML =
            '<div class="novel-ss-batch-tag-dropdown-empty">暂无标签，请先在「管理标签」中创建</div>';
          return;
        }
        tags.forEach((tag) => {
          const on = cur.has(tag.id);
          const opt = document.createElement("div");
          opt.className =
            "novel-ss-batch-tag-opt" + (on ? " novel-ss-batch-tag-opt-on" : "");
          opt.dataset.tagId = tag.id;
          opt.innerHTML = `<i class="${on ? "fa-solid fa-square-check" : "fa-regular fa-square"} novel-ss-batch-tag-opt-check"></i><span class="novel-ss-tag-chip">${escapeHtml(tag.name)}</span>`;
          opt.addEventListener("click", () => {
            if (cur.has(tag.id)) cur.delete(tag.id);
            else cur.add(tag.id);
            renderDropdown();
            renderPickerChips();
          });
          dropdown.appendChild(opt);
        });
      }
      function openDropdown() {
        closeDropdown();
        dropdown = document.createElement("div");
        dropdown.className = "novel-ss-batch-tag-dropdown";
        renderDropdown();
        overlay.appendChild(dropdown);
        const r = picker.getBoundingClientRect();
        dropdown.style.left = r.left + "px";
        dropdown.style.top = r.bottom + 4 + "px";
        dropdown.style.minWidth = Math.max(r.width, 160) + "px";
        // 视口底部翻转
        const dr = dropdown.getBoundingClientRect();
        if (dr.bottom > window.innerHeight) {
          dropdown.style.top = Math.max(8, r.top - dr.height - 4) + "px";
        }
      }
      picker.addEventListener("click", (e) => {
        e.stopPropagation();
        if (dropdown) {
          // 本行已打开：toggle 关闭
          closeDropdown();
          return;
        }
        closeAllDropdowns.forEach((fn) => fn());
        openDropdown();
      });
      // 点击行内（选择框外）也关闭本行下拉
      row.addEventListener("click", (e) => {
        if (e.target.closest(".novel-ss-batch-tag-dropdown")) return;
        closeDropdown();
      });
      closeAllDropdowns.push(closeDropdown);
      renderPickerChips();
      rowStates.push({ id, cur });
      row.appendChild(nameSpan);
      row.appendChild(arrow);
      row.appendChild(picker);
      indivListEl.appendChild(row);
    });
    // 弹窗内滚动 / 遮罩点击时统一关闭下拉，避免位置错位
    overlay.addEventListener(
      "scroll",
      () => closeAllDropdowns.forEach((fn) => fn()),
      true,
    );

    // ---- 模式切换：统一 / 逐个 ----
    function updateModeUI() {
      const mode = modeSelect.value;
      uniformEl.style.display = mode === "uniform" ? "block" : "none";
      individualEl.style.display = mode === "individual" ? "block" : "none";
      // 切换模式时清空统一模式选择，避免残留高亮
      pickedSet.clear();
      renderUniform();
    }
    modeSelect.addEventListener("change", updateModeUI);
    updateModeUI();

    const finish = (value) => {
      if (!value) {
        closeAllDropdowns.forEach((fn) => fn());
        overlay.remove();
        return;
      }
      const mode = modeSelect.value;

      // ---- 先完成校验与数据读取（校验失败不关闭弹窗） ----
      let action = null;
      let rowPlans = null; // 逐个模式：{ id, tagIds: string[] } 列表
      if (mode === "uniform") {
        action = overlay
          .querySelector(".novel-ss-batch-tag-action")
          .value.trim();
        // clear（清空全部标签）无需勾选 tag；其余行为需要至少勾选一个
        if (action !== "clear" && !pickedSet.size) {
          toast("请先选择至少一个标签");
          return;
        }
      } else {
        // 逐个模式：从 rowStates 收集每行当前勾选的 tag
        rowPlans = rowStates.map((s) => ({
          id: s.id,
          tagIds: Array.from(s.cur),
        }));
      }

      closeAllDropdowns.forEach((fn) => fn());
      overlay.remove();
      let changed = 0; // 实际发生变化的指令数

      if (mode === "uniform") {
        const applyTag = (cmd, tagIds, act) => {
          const cur = new Set(cmd.tagIds || []);
          let dirty = false;
          for (const tagId of tagIds) {
            if (act === "add") {
              if (!cur.has(tagId)) {
                cur.add(tagId);
                dirty = true;
              }
            } else {
              if (cur.has(tagId)) {
                cur.delete(tagId);
                dirty = true;
              }
            }
          }
          if (!dirty) return false;
          // 按 tag 顺序存储
          const ordered = tags.filter((t) => cur.has(t.id)).map((t) => t.id);
          commandLib.updateCommand(cmd.id, { tagIds: ordered });
          return true;
        };
        const pickedArr = Array.from(pickedSet);
        const pickedNames = pickedArr
          .map((id) => tags.find((t) => t.id === id)?.name)
          .filter(Boolean);

        if (action === "clear") {
          // 清空全部标签：所有选中指令 tagIds 置空
          for (const id of ids) {
            const cmd = cmds[id];
            if (!cmd) continue;
            const cur = new Set(cmd.tagIds || []);
            if (!cur.size) continue;
            commandLib.updateCommand(cmd.id, { tagIds: [] });
            changed++;
          }
          toast(
            changed
              ? `已清空全部标签：${changed} 条指令受影响`
              : "指令均无标签",
          );
        } else if (action === "overwrite") {
          // 统一修改（覆盖）：整体替换为勾选的 tag 集合（按 tag 顺序存储）
          const nextArr = tags
            .filter((t) => pickedSet.has(t.id))
            .map((t) => t.id);
          for (const id of ids) {
            const cmd = cmds[id];
            if (!cmd) continue;
            const cur = new Set(cmd.tagIds || []);
            const next = new Set(nextArr);
            if (
              cur.size === next.size &&
              Array.from(cur).every((x) => next.has(x))
            )
              continue;
            commandLib.updateCommand(cmd.id, { tagIds: nextArr });
            changed++;
          }
          toast(
            changed
              ? `已覆盖为标签「${pickedNames.join(
                  "、",
                )}」：${changed} 条指令受影响`
              : "指令标签均已是所选标签",
          );
        } else {
          // 统一添加 / 统一移除
          for (const id of ids) {
            const cmd = cmds[id];
            if (cmd && applyTag(cmd, pickedArr, action)) changed++;
          }
          toast(
            `已${action === "add" ? "添加" : "移除"}标签「${pickedNames.join(
              "、",
            )}」：${changed} 条指令受影响`,
          );
        }
      } else {
        // 逐个模式：按行整体替换 tagIds（按 tag 顺序存储）
        rowPlans.forEach((plan) => {
          const cmd = cmds[plan.id];
          if (!cmd) return;
          const cur = new Set(cmd.tagIds || []);
          const next = new Set(plan.tagIds);
          if (
            cur.size === next.size &&
            Array.from(cur).every((x) => next.has(x))
          )
            return; // 未变化
          const ordered = tags.filter((t) => next.has(t.id)).map((t) => t.id);
          commandLib.updateCommand(cmd.id, { tagIds: ordered });
          changed++;
        });
        toast(
          changed
            ? `已批量设置标签：${changed} 条指令发生变化`
            : "无指令发生变化",
        );
      }
      render();
    };
    overlay
      .querySelector(".novel-ss-edit-popup-cancel")
      .addEventListener("click", () => finish(null));
    overlay
      .querySelector(".novel-ss-edit-popup-confirm")
      .addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (e) => {
      if (e.target.classList.contains("novel-ss-edit-popup-overlay"))
        finish(null);
    });
  }

  // ---------------- 渲染：指令列表 ----------------

  function renderCommands(container) {
    container.innerHTML = "";

    const cmds = getVisibleCommands();
    const tags = commandLib.listTags();
    // tag 显示顺序统一为「tag 顺序」（与 tag 管理/筛选一致：按名称拼音排序）
    const tagOrder = Object.values(tags)
      .sort((a, b) =>
        String(a.name).localeCompare(String(b.name), "zh-Hans-CN"),
      )
      .map((t) => t.id);

    if (!cmds.length) {
      container.innerHTML = `<div class="novel-ss-empty">暂无指令</div>`;
      return;
    }

    cmds.forEach((cmd) => {
      const row = document.createElement("div");
      const selected = batchSelected.has(cmd.id);
      row.className =
        "novel-ss-cmd-row" +
        (batchMode && selected ? " novel-ss-cmd-selected" : "");
      row.dataset.cmdId = cmd.id;
      row.innerHTML = `
        ${batchMode ? `<i class="${selected ? "fa-solid fa-square-check" : "fa-regular fa-square"} novel-ss-cmd-check" title="选择"></i>` : ""}
        <div class="novel-ss-cmd-main">
          <div class="novel-ss-cmd-title">${escapeHtml(cmd.name || cmd.text)}</div>
          <div class="novel-ss-cmd-meta">
            ${cmd.name ? `<span class="novel-ss-cmd-text">${escapeHtml(cmd.text)}</span>` : ""}
          </div>
          ${
            (cmd.tagIds || []).length
              ? `<div class="novel-ss-cmd-tags">${tagOrder
                  .filter((tid) => (cmd.tagIds || []).includes(tid))
                  .map((tid) => (tags[tid] ? tagChipHtml(tags[tid]) : ""))
                  .join("")}</div>`
              : ""
          }
        </div>
        <span class="novel-ss-cmd-actions">
          <i class="fa-solid fa-tags novel-ss-cmd-tags-btn" title="设置标签"></i>
          <i class="${cmd.favorite ? "fa-solid" : "fa-regular"} fa-star novel-ss-cmd-star${cmd.favorite ? " novel-ss-cmd-star-on" : ""}" title="${cmd.favorite ? "取消收藏" : "收藏"}"></i>
          <i class="fa-solid fa-pen novel-ss-cmd-rename" title="重命名"></i>
          <i class="fa-solid fa-trash novel-ss-cmd-del" title="删除"></i>
        </span>`;
      // 批量模式下，点击行切换选中；否则追加到输入框
      row.addEventListener("click", (e) => {
        if (e.target.closest(".novel-ss-cmd-actions")) return;
        if (e.target.closest(".novel-ss-cmd-tags")) return;
        if (batchMode) {
          toggleBatchItem(cmd.id, e.shiftKey);
          renderCommands(container);
        } else {
          appendToInput(cmd.text);
          toast("已填入输入框");
        }
      });
      // 复选框点击（批量模式下同样切换选中）
      row
        .querySelector(".novel-ss-cmd-check")
        ?.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleBatchItem(cmd.id, e.shiftKey);
          renderCommands(container);
        });
      // tag 胶囊点击：切换该 tag 筛选（若已筛选该 tag 则移除，否则仅筛选该 tag）
      row
        .querySelectorAll(".novel-ss-cmd-tags .novel-ss-tag-chip")
        .forEach((chip) => {
          chip.addEventListener("click", (e) => {
            e.stopPropagation();
            const tagId = chip.dataset.tagId;
            const tag = commandLib.listTags()[tagId];
            if (!tag) return;
            const already = parseSearchQuery().tagIds.has(tagId);
            const parts = searchQuery.split(/[，,]/).map((s) => s.trim());
            if (already) {
              // 移除该 tag 词
              searchQuery = parts.filter((p) => p && p !== tag.name).join("，");
            } else {
              // 仅保留该 tag 词（清空其他筛选/搜索）
              searchQuery = tag.name;
            }
            const searchInput = panelEl.querySelector(".novel-ss-search");
            if (searchInput) searchInput.value = searchQuery;
            render();
          });
        });
      // 设置标签按钮
      row
        .querySelector(".novel-ss-cmd-tags-btn")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          showCommandTagPopup(cmd.id);
        });
      // 收藏星标
      row.querySelector(".novel-ss-cmd-star").addEventListener("click", (e) => {
        e.stopPropagation();
        const on = commandLib.toggleFavorite(cmd.id);
        toast(on ? "已收藏" : "已取消收藏");
        renderCommands(container);
        refreshBatchBar();
      });
      // 操作：重命名 / 删除
      row
        .querySelector(".novel-ss-cmd-rename")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          if (batchMode && batchSelected.has(cmd.id)) {
            batchRenameSelected();
          } else {
            promptRenameCommand(cmd.id);
          }
        });
      row.querySelector(".novel-ss-cmd-del").addEventListener("click", (e) => {
        e.stopPropagation();
        if (batchMode && batchSelected.has(cmd.id)) {
          batchDeleteSelected();
        } else if (window.confirm("删除这条指令？")) {
          commandLib.deleteCommand(cmd.id);
          batchSelected.delete(cmd.id);
          toast("已删除");
          render();
        }
      });
      container.appendChild(row);
    });
  }

  /** 渲染单条 tag 胶囊（点击 → 跳转该 tag 筛选） */
  function tagChipHtml(tag) {
    return `<span class="novel-ss-tag-chip" data-tag-id="${escapeHtml(tag.id)}" title="点击筛选该标签">${escapeHtml(tag.name)}</span>`;
  }

  // ---------------- 输入框填充 ----------------

  /** 将指令文本追加到输入框末尾（已有内容则先补换行） */
  function appendToInput(text) {
    const ta = getTextarea?.();
    if (!ta) return;
    const cur = String(ta.value || "");
    const sep = cur ? (cur.endsWith("\n") ? "" : "\n") : "";
    ta.value = cur + sep + text;
    ta.focus();
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    // 触发 ST 的输入框自适应高度
    if (window.jQuery) {
      window.jQuery(ta).trigger("input");
    }
  }

  // ---------------- 新建指令弹窗（支持连续新建 / 草稿保留） ----------------

  /** 新建指令弹窗草稿（关闭弹窗后保留，下次打开继续编辑） */
  let newCmdDraft = { name: "", text: "", tagIds: [] };

  /**
   * 打开新建指令弹窗：从上到下「名称 / 内容 / 标签」。
   * - 名称留空 → 创建时自动命名「未命名-N」（N 自增不重复）
   * - 「确认并新建下一个」：创建并清空弹窗，弹窗保留以便连续新建
   * - 「确认并退出」：创建并清空草稿后关闭弹窗
   * - 「取消」：不创建、不清空、不关闭（弹窗保持原样）
   * - 「清空弹窗」：清空名称 / 内容 / 标签勾选
   * - 关闭弹窗（✕ / 点击遮罩）：草稿保留，下次打开恢复
   */
  function openNewCommandPopup() {
    const tags = Object.values(commandLib.listTags()).sort((a, b) =>
      String(a.name).localeCompare(String(b.name), "zh-Hans-CN"),
    );
    const overlay = document.createElement("div");
    overlay.className = "novel-ss-edit-popup-overlay";
    overlay.innerHTML = `
      <div class="novel-ss-edit-popup novel-ss-new-cmd-popup">
        <div class="novel-ss-edit-popup-title novel-ss-new-cmd-title">
          <span>新建指令</span>
          <i class="fa-solid fa-xmark novel-ss-new-cmd-close" title="关闭（保留内容）"></i>
        </div>
        <div class="novel-ss-edit-popup-field">
          <label>名称（留空自动命名「未命名-N」）</label>
          <input type="text" class="novel-ss-edit-input novel-ss-new-cmd-name" placeholder="可选" autocomplete="off" />
        </div>
        <div class="novel-ss-edit-popup-field">
          <label>内容</label>
          <textarea class="novel-ss-edit-input novel-ss-new-cmd-text" rows="6" placeholder="指令内容（必填）"></textarea>
        </div>
        <div class="novel-ss-edit-popup-field novel-ss-new-cmd-tags-field">
          <label>标签</label>
          <div class="novel-ss-cmd-tag-list novel-ss-new-cmd-tags"></div>
        </div>
        <div class="novel-ss-edit-popup-actions">
          <button type="button" class="novel-ss-new-cmd-clear">清空弹窗</button>
          <button type="button" class="novel-ss-edit-popup-cancel novel-ss-new-cmd-cancel">取消</button>
          <button type="button" class="novel-ss-new-cmd-next">确认并新建下一个</button>
          <button type="button" class="novel-ss-edit-popup-confirm novel-ss-new-cmd-save">确认并退出</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const nameInput = overlay.querySelector(".novel-ss-new-cmd-name");
    const textInput = overlay.querySelector(".novel-ss-new-cmd-text");
    const tagList = overlay.querySelector(".novel-ss-new-cmd-tags");

    // 用草稿填充输入框
    nameInput.value = newCmdDraft.name || "";
    textInput.value = newCmdDraft.text || "";

    /** 渲染标签多选列表（勾选态来自草稿） */
    function renderTagRows() {
      tagList.innerHTML = "";
      if (!tags.length) {
        tagList.innerHTML =
          '<div class="novel-ss-empty">暂无标签，可稍后在「管理标签」中创建</div>';
        return;
      }
      tags.forEach((tag) => {
        const row = document.createElement("div");
        const on = newCmdDraft.tagIds.includes(tag.id);
        row.className =
          "novel-ss-cmd-tag-row" + (on ? " novel-ss-cmd-tag-on" : "");
        row.innerHTML = `
          <i class="${on ? "fa-solid fa-square-check" : "fa-regular fa-square"} novel-ss-cmd-tag-check"></i>
          <span class="novel-ss-tag-chip">${escapeHtml(tag.name)}</span>`;
        row.addEventListener("click", () => {
          const idx = newCmdDraft.tagIds.indexOf(tag.id);
          if (idx >= 0) newCmdDraft.tagIds.splice(idx, 1);
          else newCmdDraft.tagIds.push(tag.id);
          renderTagRows();
        });
        tagList.appendChild(row);
      });
    }
    renderTagRows();

    // 输入实时同步草稿
    nameInput.addEventListener("input", () => {
      newCmdDraft.name = nameInput.value;
    });
    textInput.addEventListener("input", () => {
      newCmdDraft.text = textInput.value;
    });

    /** 校验并创建指令（名称留空自动「未命名-N」），成功返回 true */
    function tryCreate() {
      const text = String(textInput.value || "").trim();
      if (!text) {
        toast("请输入指令内容");
        textInput.focus();
        return false;
      }
      let name = String(nameInput.value || "").trim();
      if (!name) {
        let n = 1;
        while (commandLib.existsByName(`未命名-${n}`)) n += 1;
        name = `未命名-${n}`;
      }
      const cmd = commandLib.createCommand(text, {
        name,
        tagIds: newCmdDraft.tagIds,
      });
      if (!cmd) {
        toast("创建失败");
        return false;
      }
      return true;
    }

    /** 清空草稿 + 输入框 + 标签勾选 */
    function clearAll() {
      newCmdDraft = { name: "", text: "", tagIds: [] };
      nameInput.value = "";
      textInput.value = "";
      renderTagRows();
      nameInput.focus();
    }

    // 确认并新建下一个：创建 → 清空 → 弹窗保留
    overlay
      .querySelector(".novel-ss-new-cmd-next")
      .addEventListener("click", () => {
        if (!tryCreate()) return;
        clearAll();
        toast("已创建指令");
        render();
      });

    // 确认并退出：创建 → 清空草稿 → 关闭弹窗
    overlay
      .querySelector(".novel-ss-new-cmd-save")
      .addEventListener("click", () => {
        if (!tryCreate()) return;
        clearAll();
        overlay.remove();
        toast("已创建指令");
        render();
      });

    // 取消：不创建、不清空、不关闭
    overlay
      .querySelector(".novel-ss-new-cmd-cancel")
      .addEventListener("click", () => {});

    // 清空弹窗
    overlay
      .querySelector(".novel-ss-new-cmd-clear")
      .addEventListener("click", clearAll);

    // 关闭（✕ / 遮罩）：草稿保留
    overlay
      .querySelector(".novel-ss-new-cmd-close")
      .addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
      if (e.target.classList.contains("novel-ss-edit-popup-overlay"))
        overlay.remove();
    });

    nameInput.focus();
  }

  function promptRenameCommand(cmdId) {
    const cmd = commandLib.listCommands()[cmdId];
    if (!cmd) return;
    const name = window.prompt("指令名称（可留空）：", cmd.name || "");
    if (name === null) return;
    commandLib.updateCommand(cmdId, { name: name.trim() });
    render();
  }

  /**
   * 从 txt 导入指令（弹窗模式）。
   * - 支持一次选择多个 txt 文件
   * - 支持填写分隔符：文件内容按分隔符切分为多条指令（每条指令一段，空段自动跳过）
   * - 分隔符留空 → 按「每行一条指令」导入（兼容原行为）
   * - 确认后自动跳过重复内容
   */
  function promptImportTxt() {
    const files = [];
    let previews = [];
    let separators = "";
    let keepSep = false;

    const overlay = document.createElement("div");
    overlay.className = "novel-ss-edit-popup-overlay";
    overlay.innerHTML = `
      <div class="novel-ss-edit-popup novel-ss-import-popup">
        <div class="novel-ss-import-title">
          <span>从 txt 导入指令</span>
          <i class="fa-solid fa-xmark novel-ss-import-close" title="关闭"></i>
        </div>
        <div class="novel-ss-edit-popup-field">
          <label>选择文件（可多选）</label>
          <div class="novel-ss-import-files"></div>
          <button type="button" class="novel-ss-import-pick">选择 txt 文件</button>
        </div>
        <div class="novel-ss-edit-popup-field">
          <label>分隔符（可选，留空则每行一条指令）</label>
          <textarea class="novel-ss-edit-input novel-ss-import-sep" rows="2" placeholder="例：填两行&#10;---&#10;指令&#10;（文件内容按这两行切分为多条指令）"></textarea>
          <label class="novel-ss-import-keepsep">
            <input type="checkbox" class="novel-ss-import-keepsep-input" />
            <span>导入时保留分隔符（勾选后，切分出的每条指令内容中包含分隔符）</span>
          </label>
          <div class="novel-ss-import-hint">分隔符可跨多行（如「--- 换行 指令」）；文件内容按此分隔符切分为多条指令，一个文件可包含多条</div>
        </div>
        <div class="novel-ss-edit-popup-field novel-ss-import-preview-field">
          <label class="novel-ss-import-preview-label">解析预览</label>
          <div class="novel-ss-import-preview"></div>
        </div>
        <div class="novel-ss-edit-popup-actions">
          <button class="novel-ss-edit-popup-cancel">取消</button>
          <button class="novel-ss-edit-popup-confirm novel-ss-import-confirm">导入</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const filesBox = overlay.querySelector(".novel-ss-import-files");
    const sepInput = overlay.querySelector(".novel-ss-import-sep");
    const keepSepInput = overlay.querySelector(
      ".novel-ss-import-keepsep-input",
    );
    const previewBox = overlay.querySelector(".novel-ss-import-preview");
    const previewLabel = overlay.querySelector(
      ".novel-ss-import-preview-label",
    );
    const confirmBtn = overlay.querySelector(".novel-ss-import-confirm");

    /** 计算切分结果（带缓存：同一份文本 + 同一分隔符只切一次） */
    const splitCache = new Map();
    function computePreviews() {
      separators = sepInput.value;
      keepSep = keepSepInput.checked;
      previews = [];
      for (const f of files) {
        const key = f.text + "\u0000" + separators + "\u0000" + keepSep;
        let parts = splitCache.get(key);
        if (!parts) {
          parts = splitBySeparator(f.text, separators, keepSep);
          splitCache.set(key, parts);
        }
        previews.push({ file: f, parts });
      }
      renderPreview();
    }

    /** 渲染文件列表与解析预览 */
    function renderPreview() {
      // 文件列表
      filesBox.innerHTML = "";
      if (!files.length) {
        filesBox.innerHTML = '<div class="novel-ss-empty">尚未选择文件</div>';
      } else {
        files.forEach((f, i) => {
          const row = document.createElement("div");
          row.className = "novel-ss-import-file-row";
          row.innerHTML = `
            <span class="novel-ss-import-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
            <span class="novel-ss-import-file-meta">${f.text.length} 字符</span>
            <i class="fa-solid fa-xmark novel-ss-import-file-del" title="移除"></i>`;
          row
            .querySelector(".novel-ss-import-file-del")
            .addEventListener("click", () => {
              files.splice(i, 1);
              splitCache.clear();
              computePreviews();
            });
          filesBox.appendChild(row);
        });
      }
      // 预览
      const total = previews.reduce((n, p) => n + p.parts.length, 0);
      previewLabel.textContent = `解析预览（共 ${total} 条指令）`;
      previewBox.innerHTML = "";
      if (!files.length) {
        previewBox.innerHTML =
          '<div class="novel-ss-empty">选择文件后在此预览解析结果</div>';
      } else if (total === 0) {
        previewBox.innerHTML =
          '<div class="novel-ss-empty">未解析出任何指令，请检查分隔符</div>';
      } else {
        previews.forEach(({ file, parts }) => {
          parts.forEach((part, idx) => {
            const row = document.createElement("div");
            row.className = "novel-ss-import-preview-row";
            row.innerHTML = `
              <span class="novel-ss-import-preview-idx">${escapeHtml(file.name)} #${idx + 1}</span>
              <span class="novel-ss-import-preview-text">${escapeHtml(part)}</span>`;
            previewBox.appendChild(row);
          });
        });
      }
      // 确认按钮可用态
      const dup = total - countNewUnique();
      confirmBtn.disabled = total === 0;
      confirmBtn.textContent = `导入 ${total} 条${dup > 0 ? `（${dup} 条重复将跳过）` : ""}`;
    }

    /** 统计最终真正会新增的数量（去除重复后） */
    function countNewUnique() {
      const texts = new Set();
      let n = 0;
      for (const p of previews) {
        for (const part of p.parts) {
          if (!texts.has(part)) {
            texts.add(part);
            if (!commandLib.existsByText(part)) n += 1;
          }
        }
      }
      return n;
    }

    // 选择文件（多选）
    overlay
      .querySelector(".novel-ss-import-pick")
      .addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".txt,text/plain";
        input.multiple = true;
        input.addEventListener("change", () => {
          const picked = Array.from(input.files || []);
          if (!picked.length) return;
          let remaining = picked.length;
          picked.forEach((file) => {
            const reader = new FileReader();
            reader.onload = () => {
              const text = String(reader.result || "").replace(/^\uFEFF/, "");
              files.push({ name: file.name, text });
              remaining -= 1;
              if (remaining === 0) {
                splitCache.clear();
                computePreviews();
              }
            };
            reader.readAsText(file);
          });
        });
        input.click();
      });

    // 分隔符输入 / 保留分隔符选项 → 实时重算
    sepInput.addEventListener("input", () => {
      splitCache.clear();
      computePreviews();
    });
    keepSepInput.addEventListener("change", () => {
      splitCache.clear();
      computePreviews();
    });

    // 取消 / 关闭
    const close = () => overlay.remove();
    overlay
      .querySelector(".novel-ss-edit-popup-cancel")
      .addEventListener("click", close);
    overlay
      .querySelector(".novel-ss-import-close")
      .addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target.classList.contains("novel-ss-edit-popup-overlay")) close();
    });

    // 确认导入
    confirmBtn.addEventListener("click", () => {
      const addedTexts = new Set();
      let added = 0;
      for (const p of previews) {
        for (const part of p.parts) {
          if (addedTexts.has(part)) continue; // 同一批内去重
          addedTexts.add(part);
          if (commandLib.createCommand(part, {})) added += 1;
        }
      }
      const skipped = previews.reduce((n, p) => n + p.parts.length, 0) - added;
      toast(
        `导入完成：新增 ${added} 条${skipped > 0 ? `（重复已跳过 ${skipped} 条）` : ""}`,
      );
      overlay.remove();
      render();
    });

    sepInput.focus();
  }

  /**
   * 按分隔符切分文本为多条指令。
   * - 分隔符留空 → 每行一条指令
   * - 分隔符可跨多行（如 "---\n指令"，用户输入的真实换行或字面 \n 均可）
   * - 分隔符未命中 → 整段退化为一条指令
   * - 空段（全空白）自动跳过
   * - keepSep=true：把分隔符补回每段（首段后补、末段前补、中间段前后都补）
   * @param {string} text 文件全文
   * @param {string} sep 用户填写的分隔符
   * @param {boolean} [keepSep] 是否保留分隔符（默认 false）
   * @returns {string[]} 切分后的指令数组（trim 后）
   */
  function splitBySeparator(text, sep, keepSep) {
    const src = String(text || "");
    const raw = String(sep || "").trim();
    if (!raw) {
      // 无分隔符：每行一条指令
      return src
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    // 分隔符保留原样（含真实换行）参与切分；同时兼容用户用字面 \n 写换行
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\\n/g, "\n").trim();
    if (!normalized) {
      return src
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const parts = src.split(normalized);
    if (parts.length === 1) {
      // 分隔符未命中：退化为整段一条指令
      const t = src.trim();
      return t ? [t] : [];
    }
    if (keepSep) {
      // 保留分隔符：把分隔符补回每段（首段后补、末段前补、中间段前后都补）
      const out = [];
      parts.forEach((part, i) => {
        const seg = part.trim();
        if (!seg) return;
        if (i === 0) out.push(seg + "\n" + normalized);
        else if (i === parts.length - 1) out.push(normalized + "\n" + seg);
        else out.push(normalized + "\n" + seg + "\n" + normalized);
      });
      return out;
    }
    return parts.map((s) => s.trim()).filter(Boolean);
  }

  // ---------------- 面板整体渲染 ----------------

  /** 刷新批量工具栏的可见性 / 计数 / 按钮激活态 */
  function refreshBatchBar() {
    if (!mounted || !panelEl) return;
    const bar = panelEl.querySelector(".novel-ss-batch-bar");
    if (!bar) return;
    bar.style.display = batchMode ? "flex" : "none";
    const countEl = bar.querySelector(".novel-ss-batch-count");
    if (countEl) countEl.textContent = `已选 ${batchSelected.size} 项`;
    const visible = getVisibleCommands();
    const allSelected =
      visible.length > 0 && visible.every((id) => batchSelected.has(id));
    const selallBtn = bar.querySelector(".novel-ss-batch-selall");
    if (selallBtn)
      selallBtn.innerHTML = allSelected
        ? `<i class="fa-solid fa-square-xmark"></i> 取消全选`
        : `<i class="fa-solid fa-square-check"></i> 全选`;
    const rangeBtn = bar.querySelector(".novel-ss-batch-range");
    if (rangeBtn)
      rangeBtn.classList.toggle("novel-ss-batch-active", batchRangeMode);
  }

  /** 从搜索文本中移除指定词（用于胶囊点击/删除 tag 时改写文本） */
  function removeWordFromSearch(word) {
    const parts = searchQuery.split(/[，,]/).map((s) => s.trim());
    const kept = parts.filter((p) => p && p !== word);
    searchQuery = kept.join("，");
    const searchInput = panelEl.querySelector(".novel-ss-search");
    if (searchInput) searchInput.value = searchQuery;
  }

  /** 刷新 tag 筛选按钮外观 + 已选胶囊区（从解析结果渲染，同步搜索文本） */
  function refreshTagFilter() {
    if (!mounted || !panelEl) return;
    const btn = panelEl.querySelector(".novel-ss-tag-filter-btn");
    if (!btn) return;
    const cond = parseSearchQuery();
    const tags = commandLib.listTags();
    const total = cond.tagIds.size + cond.specials.size;
    btn.classList.toggle("novel-ss-tag-filter-active", total > 0);
    const btnLabel = btn.querySelector(".novel-ss-tag-filter-btn-label");
    if (btnLabel) btnLabel.textContent = total > 0 ? `标签(${total})` : "标签";
    // 已选胶囊区（点 ✕ 移除单项 = 从搜索文本删除该词）；无筛选时隐藏
    const chipsEl = panelEl.querySelector(".novel-ss-tag-filter-chips");
    if (!chipsEl) return;
    chipsEl.innerHTML = "";
    // 特殊词在文本中的实际写法（支持「未标记」「⭐收藏」「收藏」「star」），用于精确移除
    const specialWordByVal = {};
    for (const raw of searchQuery.split(/[，,]/)) {
      const seg = String(raw || "").trim();
      const lower = seg.toLowerCase();
      if (lower === "未标记") specialWordByVal.__untagged__ = seg;
      else if (lower === "收藏" || lower === "⭐收藏" || lower === "star")
        specialWordByVal.__favorites__ = seg;
    }
    const entries = [];
    for (const f of cond.specials)
      entries.push({
        val: f,
        name: f === "__untagged__" ? "未标记" : "⭐ 收藏",
        word: specialWordByVal[f] || (f === "__untagged__" ? "未标记" : "收藏"),
      });
    for (const tid of cond.tagIds)
      if (tags[tid])
        entries.push({ val: tid, name: tags[tid].name, word: tags[tid].name });
    chipsEl.style.display = entries.length ? "flex" : "none";
    entries.forEach((entry) => {
      const chip = document.createElement("span");
      chip.className = "novel-ss-tag-chip novel-ss-tag-filter-chip";
      chip.textContent = entry.name;
      chip.title = "点击移除该筛选";
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        removeWordFromSearch(entry.word);
        render();
      });
      chipsEl.appendChild(chip);
    });
    const clearBtn = panelEl.querySelector(".novel-ss-tag-filter-clear");
    if (clearBtn)
      clearBtn.style.display =
        cond.tagIds.size || cond.specials.size ? "inline-flex" : "none";
  }

  /** 关闭 tag 多选筛选下拉面板 */
  function closeTagFilterDropdown() {
    if (tagFilterDropdown) {
      tagFilterDropdown.remove();
      tagFilterDropdown = null;
    }
  }

  /**
   * 在下拉勾选/取消时改写搜索文本（搜索框是唯一状态源）。
   * @param {string} word 该选项对应的词（tag 名 / "未标记" / "收藏"）
   * @param {boolean} on 勾选为 true，取消为 false
   */
  function setSearchWord(word, on) {
    const parts = searchQuery.split(/[，,]/).map((s) => s.trim());
    let idx = parts.indexOf(word);
    // 取消时若精确词未命中，尝试匹配特殊词变体（未标记/收藏/⭐收藏/star）
    if (!on && idx === -1) {
      const lower = word.toLowerCase();
      if (lower === "收藏") {
        idx = parts.findIndex(
          (p) =>
            p.toLowerCase() === "收藏" ||
            p.toLowerCase() === "⭐收藏" ||
            p.toLowerCase() === "star",
        );
      } else if (lower === "未标记") {
        idx = parts.findIndex((p) => p.toLowerCase() === "未标记");
      }
    }
    if (on) {
      if (idx === -1) {
        parts.push(word);
        searchQuery = parts.filter(Boolean).join("，");
      }
    } else if (idx !== -1) {
      parts.splice(idx, 1);
      searchQuery = parts.filter(Boolean).join("，");
    }
    const searchInput = panelEl.querySelector(".novel-ss-search");
    if (searchInput) searchInput.value = searchQuery;
  }

  /** 渲染 tag 筛选下拉面板选项（勾选态实时来自解析结果） */
  function renderTagFilterDropdownOptions() {
    if (!tagFilterDropdown) return;
    const cond = parseSearchQuery();
    tagFilterDropdown
      .querySelectorAll(".novel-ss-tag-filter-opt")
      .forEach((opt) => {
        const val = opt.dataset.val;
        const on = cond.tagIds.has(val) || cond.specials.has(val);
        opt.classList.toggle("novel-ss-tag-filter-opt-on", on);
        const icon = opt.querySelector("i");
        if (icon)
          icon.className = on
            ? "fa-solid fa-square-check"
            : "fa-regular fa-square";
      });
  }

  /** 渲染并定位 tag 多选筛选下拉面板（挂 panel 内、fixed 定位、防裁剪翻转） */
  function openTagFilterDropdown() {
    closeTagFilterDropdown();
    const btn = panelEl.querySelector(".novel-ss-tag-filter-btn");
    if (!btn) return;
    const tags = Object.values(commandLib.listTags()).sort((a, b) =>
      String(a.name).localeCompare(String(b.name), "zh-Hans-CN"),
    );
    const cond = parseSearchQuery();
    const dd = document.createElement("div");
    dd.className = "novel-ss-tag-filter-dropdown";
    const optHtml = (val, label, checked) => `
      <div class="novel-ss-tag-filter-opt${checked ? " novel-ss-tag-filter-opt-on" : ""}" data-val="${val}">
        <i class="fa-regular fa-square${checked ? " fa-solid fa-square-check" : ""}"></i>
        <span>${label}</span>
      </div>`;
    let inner = `
      ${optHtml("__untagged__", "未标记", cond.specials.has("__untagged__"))}
      ${optHtml("__favorites__", "⭐ 收藏", cond.specials.has("__favorites__"))}
      <div class="novel-ss-tag-filter-sep"></div>`;
    if (!tags.length) {
      inner += `<div class="novel-ss-tag-filter-empty">暂无标签，请先在「管理标签」中创建</div>`;
    } else {
      inner += tags
        .map((t) => optHtml(t.id, escapeHtml(t.name), cond.tagIds.has(t.id)))
        .join("");
    }
    dd.innerHTML = inner;
    dd.addEventListener("click", (e) => {
      // 阻止冒泡到 document（避免下拉被点击外部监听关闭）
      e.stopPropagation();
      const opt = e.target.closest(".novel-ss-tag-filter-opt");
      if (!opt) return;
      const val = opt.dataset.val;
      const tagsMap = commandLib.listTags();
      let word =
        val === "__untagged__"
          ? "未标记"
          : val === "__favorites__"
            ? "收藏"
            : tagsMap[val]?.name;
      if (!word) return;
      // 取消勾选时优先匹配文本中的实际写法（如手打的「⭐收藏」「star」）
      const cond = parseSearchQuery();
      const isOn = cond.tagIds.has(val) || cond.specials.has(val);
      if (isOn && val !== "__untagged__" && val !== "__favorites__") {
        // tag 名可能大小写不同，按 id 从文本中找实际分段
        for (const raw of searchQuery.split(/[，,]/)) {
          const seg = String(raw || "").trim();
          if (tagsMap[val] && seg === tagsMap[val].name) {
            word = seg;
            break;
          }
        }
      }
      setSearchWord(word, !isOn);
      render();
    });
    panelEl.appendChild(dd);
    tagFilterDropdown = dd;
    // 定位（相对按钮，fixed 坐标取按钮视口位置）
    const r = btn.getBoundingClientRect();
    dd.style.left = r.right - Math.min(r.width, 200) + "px";
    dd.style.top = r.bottom + 4 + "px";
    dd.style.minWidth = Math.max(160, Math.min(r.width, 220)) + "px";
    const dr = dd.getBoundingClientRect();
    if (dr.right > window.innerWidth - 8) {
      dd.style.left = Math.max(8, window.innerWidth - dr.width - 8) + "px";
    }
    if (dr.bottom > window.innerHeight - 8) {
      dd.style.top = Math.max(8, r.top - dr.height - 4) + "px";
    }
  }

  function render() {
    if (!mounted || !panelEl) return;
    // 清理批量选中集中已不存在的指令 id
    const cmds = commandLib.listCommands();
    for (const id of Array.from(batchSelected)) {
      if (!cmds[id]) batchSelected.delete(id);
    }
    const list = panelEl.querySelector(".novel-ss-list");
    if (list) renderCommands(list);
    refreshTagFilter();
    renderTagFilterDropdownOptions();
    refreshBatchBar();
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.className = "novel-ss-panel";
    panel.innerHTML = `
      <div class="novel-ss-toolbar">
        <span class="novel-ss-toolbar-title"><i class="fa-solid fa-book-bookmark"></i> 番外指令库</span>
        <span class="novel-ss-toolbar-actions">
          <i class="fa-solid fa-tags novel-ss-manage-tag" title="管理标签"></i>
          <i class="fa-solid fa-xmark novel-ss-close" title="关闭"></i>
        </span>
      </div>
      <div class="novel-ss-search-row">
        <i class="fa-solid fa-magnifying-glass"></i>
        <input type="text" class="novel-ss-search" placeholder="搜索指令或标签，用「，」分隔多个（全部满足）…" autocomplete="off" />
        <div class="novel-ss-tag-filter-wrap">
          <button type="button" class="novel-ss-tag-filter-btn" title="按标签筛选（可多选）">
            <i class="fa-solid fa-tags"></i>
            <span class="novel-ss-tag-filter-btn-label">标签</span>
            <i class="fa-solid fa-caret-down"></i>
          </button>
          <i class="fa-solid fa-xmark novel-ss-tag-filter-clear" style="display:none" title="清除标签筛选"></i>
          <div class="novel-ss-tag-filter-chips" style="display:none"></div>
        </div>
      </div>
      <div class="novel-ss-list-toolbar">
        <span class="novel-ss-list-title-label">全部指令</span>
        <span class="novel-ss-list-actions">
          <i class="fa-solid fa-file-import novel-ss-import" title="从 txt 导入"></i>
          <i class="fa-solid fa-plus novel-ss-new-cmd" title="新建指令"></i>
          <i class="fa-solid fa-list-check novel-ss-batch-toggle" title="批量操作"></i>
        </span>
      </div>
      <div class="novel-ss-batch-bar" style="display:none">
        <button class="novel-ss-batch-btn novel-ss-batch-selall"><i class="fa-solid fa-square-check"></i> 全选</button>
        <button class="novel-ss-batch-btn novel-ss-batch-range"><i class="fa-solid fa-arrow-down-short-wide"></i> 框选</button>
        <span class="novel-ss-batch-count"></span>
        <button class="novel-ss-batch-btn novel-ss-batch-tag"><i class="fa-solid fa-tags"></i> 设置标签</button>
        <button class="novel-ss-batch-btn novel-ss-batch-rename"><i class="fa-solid fa-pen"></i> 重命名</button>
        <button class="novel-ss-batch-btn novel-ss-batch-del"><i class="fa-solid fa-trash"></i> 删除</button>
      </div>
      <div class="novel-ss-list"></div>`;
    return panel;
  }

  function positionPanel() {
    if (!panelEl) return;
    const w = Math.min(720, window.innerWidth - 24);
    const h = Math.min(520, window.innerHeight - 24);
    panelEl.style.width = `${w}px`;
    panelEl.style.height = `${h}px`;
    panelEl.style.left = `${Math.max(12, (window.innerWidth - w) / 2)}px`;
    panelEl.style.top = `${Math.max(12, (window.innerHeight - h) / 2)}px`;
  }

  function bindEvents() {
    if (!panelEl) return;
    // 关闭
    panelEl.querySelector(".novel-ss-close").addEventListener("click", close);
    // 管理标签
    panelEl
      .querySelector(".novel-ss-manage-tag")
      .addEventListener("click", () => showTagManagePopup());
    // 搜索（含手动输入 tag 名筛选）：文本为唯一状态源，实时解析刷新筛选/下拉勾选态
    const searchInput = panelEl.querySelector(".novel-ss-search");
    searchInput.addEventListener("input", () => {
      searchQuery = String(searchInput.value || "").trim();
      render();
    });
    // tag 多选筛选：点击按钮开合下拉面板
    const tagFilterBtn = panelEl.querySelector(".novel-ss-tag-filter-btn");
    tagFilterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (tagFilterDropdown) closeTagFilterDropdown();
      else openTagFilterDropdown();
    });
    // 滚动 / 点击面板外关闭下拉（捕获阶段，覆盖所有滚动源）
    const closeDd = (e) => {
      // 下拉自身内部滚动（标签多时内滚）不关闭
      if (
        e &&
        e.target instanceof Node &&
        tagFilterDropdown?.contains(e.target)
      )
        return;
      closeTagFilterDropdown();
    };
    panelEl.addEventListener("scroll", closeDd, true);
    window.addEventListener("scroll", closeDd, true);
    document.addEventListener("click", closeDd);
    // 清除全部 tag 筛选（清空搜索文本）
    panelEl
      .querySelector(".novel-ss-tag-filter-clear")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        searchQuery = "";
        const searchInput = panelEl.querySelector(".novel-ss-search");
        if (searchInput) searchInput.value = "";
        render();
      });
    // 新建指令
    panelEl
      .querySelector(".novel-ss-new-cmd")
      .addEventListener("click", openNewCommandPopup);
    // 从 txt 导入
    panelEl
      .querySelector(".novel-ss-import")
      .addEventListener("click", promptImportTxt);
    // 批量操作开关
    panelEl
      .querySelector(".novel-ss-batch-toggle")
      .addEventListener("click", () => {
        batchMode = !batchMode;
        if (!batchMode) {
          batchSelected.clear();
          batchLastClicked = null;
          batchRangeMode = false;
        }
        render();
      });
    // 全选/全不选
    panelEl
      .querySelector(".novel-ss-batch-selall")
      .addEventListener("click", () => {
        toggleSelectAllVisible();
        renderCommands(panelEl.querySelector(".novel-ss-list"));
        refreshBatchBar();
      });
    // 框选模式
    panelEl
      .querySelector(".novel-ss-batch-range")
      .addEventListener("click", () => {
        batchRangeMode = !batchRangeMode;
        refreshBatchBar();
      });
    // 批量设置标签
    panelEl
      .querySelector(".novel-ss-batch-tag")
      .addEventListener("click", showBatchTagPopup);
    // 批量重命名
    panelEl
      .querySelector(".novel-ss-batch-rename")
      .addEventListener("click", batchRenameSelected);
    // 批量删除
    panelEl
      .querySelector(".novel-ss-batch-del")
      .addEventListener("click", batchDeleteSelected);
    // 点击面板外部关闭（批量重命名/tag 弹窗打开时跳过）
    document.addEventListener("mousedown", function onClickOutside(e) {
      if (!panelEl || !mounted || panelEl.contains(e.target)) return;
      if (document.querySelector(".novel-ss-edit-popup-overlay")) return;
      close();
      document.removeEventListener("mousedown", onClickOutside);
    });
    // Esc 关闭（批量重命名/tag 弹窗打开时由弹窗自己处理 Esc）
    document.addEventListener("keydown", function onEsc(e) {
      if (!panelEl || !mounted) return;
      if (
        e.key === "Escape" &&
        !document.querySelector(".novel-ss-edit-popup-overlay")
      ) {
        close();
        document.removeEventListener("keydown", onEsc);
      }
    });
    // 窗口尺寸变化时重定位
    window.addEventListener("resize", positionPanel);
  }

  // ---------------- 面板生命周期 ----------------

  function open() {
    if (!getEnabled?.()) return;
    if (!mounted) {
      panelEl = buildPanel();
      document.body.appendChild(panelEl);
      mounted = true;
      bindEvents();
    }
    positionPanel();
    panelEl.style.display = "flex";
    render();
  }

  function close() {
    if (!mounted || !panelEl) return;
    // 关闭时退出批量模式，避免下次打开残留选中态
    batchMode = false;
    batchSelected.clear();
    batchLastClicked = null;
    batchRangeMode = false;
    // 关闭 tag 筛选下拉
    closeTagFilterDropdown();
    panelEl.style.display = "none";
  }

  function toggle() {
    if (!getEnabled?.()) return;
    if (mounted && panelEl && panelEl.style.display !== "none") {
      close();
    } else {
      open();
    }
  }

  /** 设置项变化后刷新（数据已由 commandLib 持久化，直接重渲染） */
  function refresh() {
    if (!mounted || !panelEl) return;
    if (!getEnabled?.()) {
      close();
      return;
    }
    render();
  }

  // ---------------- 导出 ----------------

  return { toggle, open, close, refresh };
}
