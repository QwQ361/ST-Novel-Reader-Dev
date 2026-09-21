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
  // 当前筛选：null=全部 / "__untagged__"=未标记 / "__favorites__"=收藏 / "tag_xxx"=某 tag
  let selectedFilter = null;
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

  /** 当前可见指令列表（与渲染一致的筛选逻辑：tag 筛选 AND 搜索） */
  function getVisibleCommands() {
    let list = Object.values(commandLib.listCommands());

    // 1. tag 下拉筛选（与搜索 AND 叠加）
    if (selectedFilter === "__untagged__") {
      list = list.filter((c) => !c.tagIds || c.tagIds.length === 0);
    } else if (selectedFilter === "__favorites__") {
      list = list.filter((c) => c.favorite);
    } else if (selectedFilter && selectedFilter.startsWith("tag_")) {
      const tagId = selectedFilter;
      list = list.filter(
        (c) => Array.isArray(c.tagIds) && c.tagIds.includes(tagId),
      );
    }

    // 2. 搜索：文本（text/name）模糊 或 tag 名包含（大小写不敏感），取并集
    if (searchQuery) {
      const q = searchQuery;
      const matchTagIds = new Set(
        Object.values(commandLib.listTags())
          .filter((tag) =>
            String(tag.name || "")
              .toLowerCase()
              .includes(q),
          )
          .map((tag) => tag.id),
      );
      list = list.filter((c) => {
        const textHit =
          String(c.text || "")
            .toLowerCase()
            .includes(q) ||
          String(c.name || "")
            .toLowerCase()
            .includes(q);
        const tagHit =
          Array.isArray(c.tagIds) && c.tagIds.some((id) => matchTagIds.has(id));
        return textHit || tagHit;
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
   * - 逐个标签：每条指令一行（指令名 + tag 胶囊勾选区），逐条设置标签，确认后按行整体替换 tagIds
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
              <option value="add">添加标签</option>
              <option value="remove">移除标签</option>
            </select>
          </div>
          <div class="novel-ss-batch-tag-list"></div>
        </div>
        <div class="novel-ss-batch-tag-individual" style="display:none">
          <label class="novel-ss-batch-tag-individual-label">逐个设置每条指令的标签（点击 tag 胶囊切换勾选，留空则清除全部）</label>
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
    let picked = null; // 统一模式：选中的单个 tag id

    // ---- 统一模式：tag 列表（单选高亮） ----
    if (!tags.length) {
      listEl.innerHTML =
        '<div class="novel-ss-empty">暂无标签，请先在「管理标签」中创建</div>';
    }
    tags.forEach((tag) => {
      const row = document.createElement("div");
      row.className = "novel-ss-batch-tag-row";
      row.dataset.tagId = tag.id;
      row.innerHTML = `<span class="novel-ss-tag-chip">${escapeHtml(tag.name)}</span>`;
      row.addEventListener("click", () => {
        picked = tag.id;
        listEl
          .querySelectorAll(".novel-ss-batch-tag-row")
          .forEach((el) =>
            el.classList.toggle(
              "novel-ss-batch-tag-on",
              el.dataset.tagId === tag.id,
            ),
          );
      });
      listEl.appendChild(row);
    });

    // ---- 逐个模式：每条指令一行（指令名 + tag 胶囊勾选区） ----
    // 每行行内 tag 胶囊为独立状态：点击切换勾选，确认后按行整体替换 tagIds。
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
      const nameSpan = document.createElement("span");
      nameSpan.className = "novel-ss-batch-tag-cmd-name";
      nameSpan.textContent = cmd.name || cmd.text || "（未命名）";
      nameSpan.title = cmd.name || cmd.text || "";
      const chipsWrap = document.createElement("div");
      chipsWrap.className = "novel-ss-batch-tag-cmd-chips";
      tags.forEach((tag) => {
        const chip = document.createElement("span");
        chip.className =
          "novel-ss-tag-chip novel-ss-batch-tag-indiv-chip" +
          (cur.has(tag.id) ? " novel-ss-batch-tag-indiv-chip-on" : "");
        chip.dataset.tagId = tag.id;
        chip.textContent = tag.name;
        chip.title = "点击切换勾选";
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          const on = chip.classList.contains(
            "novel-ss-batch-tag-indiv-chip-on",
          );
          chip.classList.toggle("novel-ss-batch-tag-indiv-chip-on", !on);
        });
        chipsWrap.appendChild(chip);
      });
      row.appendChild(nameSpan);
      row.appendChild(chipsWrap);
      indivListEl.appendChild(row);
    });

    // ---- 模式切换：统一 / 逐个 ----
    function updateModeUI() {
      const mode = modeSelect.value;
      uniformEl.style.display = mode === "uniform" ? "block" : "none";
      individualEl.style.display = mode === "individual" ? "block" : "none";
    }
    modeSelect.addEventListener("change", updateModeUI);
    updateModeUI();

    const finish = (value) => {
      if (!value) {
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
        if (!picked) {
          toast("请先选择一个标签");
          return;
        }
      } else {
        rowPlans = [];
        indivListEl
          .querySelectorAll(".novel-ss-batch-tag-row-indiv")
          .forEach((row) => {
            const tagIds = Array.from(
              row.querySelectorAll(
                ".novel-ss-batch-tag-indiv-chip.novel-ss-batch-tag-indiv-chip-on",
              ),
            ).map((chip) => chip.dataset.tagId);
            rowPlans.push({ id: row.dataset.id, tagIds });
          });
      }

      overlay.remove();
      let changed = 0; // 实际发生变化的指令数

      if (mode === "uniform") {
        const applyTag = (cmd, tagId, act) => {
          const cur = new Set(cmd.tagIds || []);
          if (act === "add") {
            if (cur.has(tagId)) return false;
            cur.add(tagId);
          } else {
            if (!cur.has(tagId)) return false;
            cur.delete(tagId);
          }
          commandLib.updateCommand(cmd.id, { tagIds: Array.from(cur) });
          return true;
        };
        for (const id of ids) {
          const cmd = cmds[id];
          if (cmd && applyTag(cmd, picked, action)) changed++;
        }
        toast(
          `已${action === "add" ? "添加" : "移除"}标签「${
            tags.find((t) => t.id === picked)?.name || ""
          }」：${changed} 条指令受影响`,
        );
      } else {
        // 逐个模式：按行整体替换 tagIds
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
          commandLib.updateCommand(cmd.id, { tagIds: Array.from(next) });
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
              ? `<div class="novel-ss-cmd-tags">${(cmd.tagIds || [])
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
      // tag 胶囊点击：跳转该 tag 筛选
      row
        .querySelectorAll(".novel-ss-cmd-tags .novel-ss-tag-chip")
        .forEach((chip) => {
          chip.addEventListener("click", (e) => {
            e.stopPropagation();
            const tagId = chip.dataset.tagId;
            selectedFilter = tagId;
            searchQuery = "";
            const searchInput = panelEl.querySelector(".novel-ss-search");
            if (searchInput) searchInput.value = "";
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

  // ---------------- 操作对话框（window.prompt / confirm，轻量） ----------------

  function promptNewCommand() {
    const text = window.prompt("输入指令文本：");
    if (!text) return;
    // 新指令默认无 tag（无论当前筛选）
    const cmd = commandLib.createCommand(text, {});
    if (cmd) {
      toast("已创建指令");
      render();
    }
  }

  function promptRenameCommand(cmdId) {
    const cmd = commandLib.listCommands()[cmdId];
    if (!cmd) return;
    const name = window.prompt("指令名称（可留空）：", cmd.name || "");
    if (name === null) return;
    commandLib.updateCommand(cmdId, { name: name.trim() });
    render();
  }

  function promptImportTxt() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,text/plain";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        const lines = text
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        let added = 0;
        for (const line of lines) {
          const cmd = commandLib.createCommand(line, {});
          if (cmd) added += 1;
        }
        toast(`导入完成：新增 ${added} 条（重复已跳过）`);
        render();
      };
      reader.readAsText(file);
    });
    input.click();
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

  /** 刷新 tag 下拉筛选框选项（保留当前选中值） */
  function refreshTagFilter() {
    if (!mounted || !panelEl) return;
    const select = panelEl.querySelector(".novel-ss-tag-filter");
    if (!select) return;
    const cur = selectedFilter;
    const tags = Object.values(commandLib.listTags()).sort((a, b) =>
      String(a.name).localeCompare(String(b.name), "zh-Hans-CN"),
    );
    select.innerHTML = `
      <option value="">全部标签</option>
      <option value="__untagged__">未标记</option>
      <option value="__favorites__">⭐ 收藏</option>
      ${tags
        .map(
          (t) =>
            `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`,
        )
        .join("")}`;
    select.value = cur || "";
    const clearBtn = panelEl.querySelector(".novel-ss-tag-filter-clear");
    if (clearBtn) clearBtn.style.display = cur ? "inline-flex" : "none";
  }

  function render() {
    if (!mounted || !panelEl) return;
    // 清理批量选中集中已不存在的指令 id
    const cmds = commandLib.listCommands();
    for (const id of Array.from(batchSelected)) {
      if (!cmds[id]) batchSelected.delete(id);
    }
    // 若当前筛选的 tag 已被删除，回退到全部
    if (
      selectedFilter &&
      selectedFilter.startsWith("tag_") &&
      !commandLib.listTags()[selectedFilter]
    ) {
      selectedFilter = null;
    }
    const list = panelEl.querySelector(".novel-ss-list");
    if (list) renderCommands(list);
    refreshTagFilter();
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
        <input type="text" class="novel-ss-search" placeholder="搜索指令或标签…" autocomplete="off" />
        <select class="novel-ss-tag-filter" title="按标签筛选"></select>
        <i class="fa-solid fa-xmark novel-ss-tag-filter-clear" style="display:none" title="清除标签筛选"></i>
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
    // 搜索（含手动输入 tag 名筛选）
    const searchInput = panelEl.querySelector(".novel-ss-search");
    searchInput.addEventListener("input", () => {
      searchQuery = String(searchInput.value || "")
        .trim()
        .toLowerCase();
      renderCommands(panelEl.querySelector(".novel-ss-list"));
    });
    // tag 下拉筛选
    const tagFilter = panelEl.querySelector(".novel-ss-tag-filter");
    tagFilter.addEventListener("change", () => {
      selectedFilter = tagFilter.value || null;
      render();
    });
    // 清除 tag 筛选
    panelEl
      .querySelector(".novel-ss-tag-filter-clear")
      .addEventListener("click", () => {
        selectedFilter = null;
        render();
      });
    // 新建指令
    panelEl
      .querySelector(".novel-ss-new-cmd")
      .addEventListener("click", promptNewCommand);
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
