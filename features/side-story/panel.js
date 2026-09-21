// features/side-story/panel.js
// 番外指令库浮动面板。
// 布局：左侧分类树（无限层级文件夹式）+ 右侧指令列表（当前选中分类）+ 顶部搜索。
// 交互：
//   - 分类：新建（顶层/子级）、重命名、删除、拖拽移动（到另一个分类下）
//   - 指令：新建（手写）、重命名、删除、拖拽归类（到分类上）、从 txt 导入
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
  let selectedCategoryId = null; // null = 未分类；"__favorites__" = 收藏视图
  let searchQuery = "";
  let expandedSet = new Set();
  let dragCmdId = null; // 正在拖拽的指令 id
  let dragCmdIds = null; // 批量拖拽时携带的指令 id 数组（null 表示非批量）
  let dragCatId = null; // 正在拖拽的分类 id
  // 批量操作状态（参照 CFM 批量模式）
  let batchMode = false; // 批量操作模式开关
  let batchSelected = new Set(); // 批量选中的指令 id
  let batchLastClicked = null; // 框选锚点（上次点击的指令 id）
  let batchRangeMode = false; // 框选模式开关

  // ---------------- 拖拽视觉（参照 CFM：多选 ghost / 三区域指示 / 落点闪烁） ----------------

  /** 注入拖拽高亮脉冲样式（全局只注入一次） */
  function ensureDragHighlightStyle() {
    if (document.getElementById("novel-ss-drag-highlight-style")) return;
    const style = document.createElement("style");
    style.id = "novel-ss-drag-highlight-style";
    style.textContent = `
      .novel-ss-drag-highlighted {
        animation: novelSsDragHighlightPulse 0.9s ease-out;
      }
      @keyframes novelSsDragHighlightPulse {
        0%   { box-shadow: 0 0 0 3px rgba(249, 226, 175, 0.9); }
        100% { box-shadow: 0 0 0 3px rgba(249, 226, 175, 0); }
      }`;
    document.head.appendChild(style);
  }

  /** 落点闪烁：给元素加一次金色脉冲动画（重触发用 void offsetWidth） */
  function flashDragTarget(el) {
    if (!el) return;
    el.classList.remove("novel-ss-drag-highlighted");
    void el.offsetWidth;
    el.classList.add("novel-ss-drag-highlighted");
  }

  /** 多选拖拽 ghost：自定义拖拽图像「📦 共 N 项」（参照 CFM pcDragStartCore） */
  function setMultiDragGhost(e, count) {
    if (!(count > 1)) return;
    const ghost = document.createElement("div");
    ghost.className = "novel-ss-drag-ghost";
    ghost.textContent = `📦 共 ${count} 项`;
    document.body.appendChild(ghost);
    try {
      e.dataTransfer?.setDragImage(ghost, 0, 0);
    } catch (err) {
      /* 兼容性异常忽略 */
    }
    setTimeout(() => ghost.remove(), 0);
  }

  /**
   * 三区域判定：按悬停相对高度分 before / after / into（参照 CFM tree-view.js）。
   * @param {DragEvent} e 拖拽事件
   * @param {HTMLElement} el 目标元素
   * @returns {"before"|"after"|"into"} 目标区域
   */
  function getDropZone(e, el) {
    const rect = el.getBoundingClientRect();
    if (!rect.height) return "into";
    const relativeY = (e.clientY - rect.top) / rect.height;
    if (relativeY < 0.25) return "before";
    if (relativeY > 0.75) return "after";
    return "into";
  }

  /** 清除某容器内所有拖放指示类（dragend 统一清理） */
  function clearDropIndicators() {
    if (!panelEl) return;
    panelEl
      .querySelectorAll(".novel-ss-cat-row, .novel-ss-cmd-row")
      .forEach((el) =>
        el.classList.remove(
          "novel-ss-drop-target",
          "novel-ss-drop-before",
          "novel-ss-drop-after",
          "novel-ss-drop-forbidden",
        ),
      );
  }

  // ---------------- 工具 ----------------

  function escapeHtml(str) {
    const el = document.createElement("span");
    el.textContent = String(str ?? "");
    return el.innerHTML;
  }

  // ---------------- 渲染：分类树 ----------------

  function renderTree(container) {
    const cats = commandLib.listCategories();
    const rootIds = commandLib.getChildCategoryIds(null);

    container.innerHTML = "";

    // ---- 顶部：⭐ 收藏 置顶节点（查看全部收藏指令；收藏是属性，非容器，不可拖放） ----
    const favRow = document.createElement("div");
    favRow.className =
      "novel-ss-cat-row novel-ss-cat-fav" +
      (selectedCategoryId === "__favorites__" ? " novel-ss-cat-selected" : "");
    favRow.dataset.catId = "__favorites__";
    favRow.innerHTML = `
      <i class="fa-solid fa-star novel-ss-cat-icon novel-ss-fav-star"></i>
      <span class="novel-ss-cat-name">收藏</span>
      <span class="novel-ss-cat-count">${commandLib.listFavoriteCount()}</span>`;
    favRow.addEventListener("click", () => {
      selectedCategoryId = "__favorites__";
      render();
    });
    container.appendChild(favRow);

    // 递归渲染分类
    const renderNode = (catId, depth) => {
      const cat = cats[catId];
      if (!cat) return;
      const children = commandLib.getChildCategoryIds(catId);
      const hasChildren = children.length > 0;
      const expanded = expandedSet.has(catId);
      const count = commandLib.listCommandsByCategory(catId).length;

      const row = document.createElement("div");
      row.className =
        "novel-ss-cat-row" +
        (selectedCategoryId === catId ? " novel-ss-cat-selected" : "");
      row.dataset.catId = catId;
      row.style.paddingLeft = `${12 + depth * 16}px`;
      // 自身 + 全部子孙（拖拽禁止态用：分类不能拖到自身或子孙里）
      const selfDesc = new Set(commandLib.getDescendantCategoryIds(catId));
      row.innerHTML = `
        <span class="novel-ss-cat-arrow ${hasChildren ? "" : "novel-ss-cat-arrow-empty"}">
          <i class="fa-solid fa-chevron-right ${expanded ? "novel-ss-rotated" : ""}"></i>
        </span>
        ${cat.pinned ? '<i class="fa-solid fa-thumbtack novel-ss-cat-icon novel-ss-cat-pin"></i>' : '<i class="fa-solid fa-folder novel-ss-cat-icon"></i>'}
        <span class="novel-ss-cat-name">${escapeHtml(cat.name)}</span>
        <span class="novel-ss-cat-actions">
          <i class="fa-solid fa-plus novel-ss-cat-add" title="新建子分类"></i>
          ${cat.pinned ? '<i class="fa-solid fa-thumbtack novel-ss-cat-pin-toggle novel-ss-cat-pin-on" title="取消置顶"></i>' : '<i class="fa-solid fa-thumbtack novel-ss-cat-pin-toggle" title="置顶"></i>'}
          <i class="fa-solid fa-pen novel-ss-cat-rename" title="重命名"></i>
          <i class="fa-solid fa-trash novel-ss-cat-del" title="删除"></i>
        </span>
        <span class="novel-ss-cat-count">${count}</span>`;
      row.draggable = true;

      // 箭头：切换展开
      row
        .querySelector(".novel-ss-cat-arrow")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          if (!hasChildren) return;
          if (expandedSet.has(catId)) expandedSet.delete(catId);
          else expandedSet.add(catId);
          render();
        });
      // 行点击：选中分类
      row.addEventListener("click", () => {
        selectedCategoryId = catId;
        render();
      });
      // 拖拽：分类可拖（移入别的分类 / 同级重排 before-after）
      row.addEventListener("dragstart", (e) => {
        dragCatId = catId;
        e.dataTransfer.setData("text/plain", catId);
        e.dataTransfer.effectAllowed = "move";
        row.classList.add("novel-ss-dragging");
      });
      row.addEventListener("dragend", () => {
        dragCatId = null;
        row.classList.remove("novel-ss-dragging");
        clearDropIndicators();
      });
      // 悬停：三区域指示（before/after/into）；拖到自身或子孙 → 禁止态红叉
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        const srcCat = dragCatId || e.dataTransfer.getData("text/plain");
        if (srcCat && selfDesc.has(srcCat)) {
          e.dataTransfer.dropEffect = "none";
          row.classList.add("novel-ss-drop-forbidden");
          row.classList.remove(
            "novel-ss-drop-before",
            "novel-ss-drop-after",
            "novel-ss-drop-target",
          );
          return;
        }
        e.dataTransfer.dropEffect = "move";
        const zone = getDropZone(e, row);
        row.classList.toggle("novel-ss-drop-before", zone === "before");
        row.classList.toggle("novel-ss-drop-after", zone === "after");
        row.classList.toggle("novel-ss-drop-target", zone === "into");
        row.classList.remove("novel-ss-drop-forbidden");
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove(
          "novel-ss-drop-target",
          "novel-ss-drop-before",
          "novel-ss-drop-after",
          "novel-ss-drop-forbidden",
        );
      });
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const srcCat = dragCatId || e.dataTransfer.getData("text/plain");
        const srcCmd = dragCmdId;
        const srcCmds = dragCmdIds;
        dragCatId = null;
        dragCmdId = null;
        dragCmdIds = null;
        clearDropIndicators();
        // 分类拖到自身/子孙 → 禁止
        if (srcCat && selfDesc.has(srcCat)) return;
        const zone = getDropZone(e, row);
        if (srcCmds && srcCmds.length) {
          // 批量指令 → 移入分类
          let moved = 0;
          for (const cid of srcCmds) {
            if (commandLib.updateCommand(cid, { categoryId: catId })) moved++;
          }
          toast(`已移动 ${moved} 条指令`);
        } else if (srcCmd) {
          // 单个指令 → 移入分类
          commandLib.updateCommand(srcCmd, { categoryId: catId });
          toast("已移入分类");
        } else if (srcCat) {
          if (zone === "before" || zone === "after") {
            // 同级重排（pinned 分组不一致会被拒绝）
            const ok = commandLib.reorderCategory(srcCat, catId, zone);
            if (ok) toast("已调整分类顺序");
          } else {
            // 移入目标分类下
            if (srcCat === catId) return;
            commandLib.moveCategory(srcCat, catId);
            expandedSet.add(catId);
            toast("已移动分类");
          }
        }
        render();
        const newRow = panelEl.querySelector(
          `.novel-ss-cat-row[data-cat-id="${catId}"]`,
        );
        if (newRow) flashDragTarget(newRow);
      });
      // 分类操作按钮（始终常显，位于计数左侧）：新建子分类 / 置顶 / 重命名 / 删除
      const actions = row.querySelector(".novel-ss-cat-actions");
      actions
        .querySelector(".novel-ss-cat-add")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          promptNewCategory(catId);
        });
      actions
        .querySelector(".novel-ss-cat-pin-toggle")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          const pinned = commandLib.toggleCategoryPin(catId);
          if (pinned) expandedSet.add(catId);
          toast(pinned ? "已置顶" : "已取消置顶");
          render();
        });
      actions
        .querySelector(".novel-ss-cat-rename")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          promptRenameCategory(catId);
        });
      actions
        .querySelector(".novel-ss-cat-del")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          promptDeleteCategory(catId);
        });
      container.appendChild(row);

      if (expanded) children.forEach((cid) => renderNode(cid, depth + 1));
    };
    rootIds.forEach((cid) => renderNode(cid, 0));

    // ---- 底部：未分类 固定节点（指令/分类可移入；into 语义） ----
    const unRow = document.createElement("div");
    unRow.className =
      "novel-ss-cat-row novel-ss-cat-uncat" +
      (selectedCategoryId === null ? " novel-ss-cat-selected" : "");
    unRow.dataset.catId = "__uncat__";
    unRow.innerHTML = `
      <i class="fa-solid fa-folder-minus novel-ss-cat-icon"></i>
      <span class="novel-ss-cat-name">未分类</span>
      <span class="novel-ss-cat-count">${commandLib.listCommandsByCategory(null).length}</span>`;
    unRow.addEventListener("click", () => {
      selectedCategoryId = null;
      render();
    });
    // 拖拽目标（into 语义：指令/分类放入未分类）
    unRow.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      unRow.classList.add("novel-ss-drop-target");
    });
    unRow.addEventListener("dragleave", () => {
      unRow.classList.remove("novel-ss-drop-target");
    });
    unRow.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const srcCmd = dragCmdId;
      const srcCmds = dragCmdIds;
      const srcCat = dragCatId || e.dataTransfer.getData("text/plain");
      dragCmdId = null;
      dragCmdIds = null;
      dragCatId = null;
      if (srcCmds && srcCmds.length) {
        let moved = 0;
        for (const cid of srcCmds) {
          if (commandLib.updateCommand(cid, { categoryId: null })) moved++;
        }
        toast(`已移动 ${moved} 条指令到未分类`);
      } else if (srcCmd) {
        commandLib.updateCommand(srcCmd, { categoryId: null });
        toast("已移入未分类");
      } else if (srcCat) {
        commandLib.moveCategory(srcCat, null);
        toast("已移动分类到顶层");
      }
      render();
      const newRow = panelEl.querySelector(
        `.novel-ss-cat-row[data-cat-id="__uncat__"]`,
      );
      if (newRow) flashDragTarget(newRow);
    });
    container.appendChild(unRow);
  }

  // ---------------- 渲染：指令列表 ----------------

  /** 当前可见指令列表（与渲染一致的筛选逻辑） */
  function getVisibleCommands() {
    if (searchQuery) {
      return Object.values(commandLib.listCommands()).filter((c) =>
        String(c.text || "")
          .toLowerCase()
          .includes(searchQuery),
      );
    }
    return commandLib.listCommandsByCategory(selectedCategoryId);
  }

  /** 批量选择切换（支持 Shift / 框选范围选择，参照 CFM toggleMultiSelectItemCore） */
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

  // ---------------- 批量重命名弹窗（Promise 模式，参照 CFM rename.js） ----------------

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
   * 公共前/后缀检测仅用指令「名称」（name），不参与文本兜底，
   * 避免未命名指令的正文被误识别为公共部分。
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

    /** 渲染检测胶囊：点击将实际前后缀值填入输入框并聚焦（显示文本含说明，填入用 value） */
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

    /** 统一控制 文本区 / 检测区 / 逐个表格 的显隐与文案（参照 CFM updateRenameUI） */
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
      // 遮罩点击关闭：校验目标类名，避免点卡片内部误关
      overlay.addEventListener("click", (e) => {
        if (e.target.classList.contains("novel-ss-edit-popup-overlay"))
          finish(null);
      });
      // 确认：逐个重命名收集 renameMap；批量操作返回 action + text
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
      // 键盘：Enter 确认 / Escape 取消（批量文本输入框）
      textInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          overlay.querySelector(".novel-ss-edit-popup-confirm").click();
        } else if (e.key === "Escape") {
          overlay.querySelector(".novel-ss-edit-popup-cancel").click();
        }
      });
      // 键盘：逐个重命名表格输入框同样支持 Enter/Esc
      individualField.querySelectorAll(".novel-ss-rename-new-input").forEach((inp) => {
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

  /** 批量重命名：按弹窗结果执行五种操作（增加/删除前后缀 + 逐个重命名），带统计汇总 */
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

  function renderCommands(container) {
    container.innerHTML = "";

    const cmds = getVisibleCommands();

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
      row.draggable = true;
      row.innerHTML = `
        ${batchMode ? `<i class="${selected ? "fa-solid fa-square-check" : "fa-regular fa-square"} novel-ss-cmd-check" title="选择"></i>` : ""}
        <div class="novel-ss-cmd-main">
          <div class="novel-ss-cmd-title">${escapeHtml(cmd.name || cmd.text)}</div>
          <div class="novel-ss-cmd-meta">
            ${cmd.name ? `<span class="novel-ss-cmd-text">${escapeHtml(cmd.text)}</span>` : ""}
          </div>
        </div>
        <span class="novel-ss-cmd-actions">
          <i class="${cmd.favorite ? "fa-solid" : "fa-regular"} fa-star novel-ss-cmd-star${cmd.favorite ? " novel-ss-cmd-star-on" : ""}" title="${cmd.favorite ? "取消收藏" : "收藏"}"></i>
          <i class="fa-solid fa-pen novel-ss-cmd-rename" title="重命名"></i>
          <i class="fa-solid fa-trash novel-ss-cmd-del" title="删除"></i>
        </span>`;
      // 批量模式下，点击行切换选中；否则追加到输入框
      row.addEventListener("click", (e) => {
        if (e.target.closest(".novel-ss-cmd-actions")) return;
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
      // 拖拽指令：非批量单拖 → 单指令；批量选中包含该指令 → 批量拖
      row.addEventListener("dragstart", (e) => {
        if (batchMode && batchSelected.has(cmd.id) && batchSelected.size > 1) {
          dragCmdId = null;
          dragCmdIds = Array.from(batchSelected);
          setMultiDragGhost(e, dragCmdIds.length);
        } else {
          dragCmdId = cmd.id;
          dragCmdIds = null;
        }
        e.dataTransfer.setData("text/plain", cmd.id);
        e.dataTransfer.effectAllowed = "move";
        row.classList.add("novel-ss-dragging");
      });
      row.addEventListener("dragend", () => {
        dragCmdId = null;
        dragCmdIds = null;
        row.classList.remove("novel-ss-dragging");
        clearDropIndicators();
      });
      // 收藏星标：切换收藏 → 三处同步（自身图标 + 左栏收藏计数 + 若在收藏视图则重渲染）
      row
        .querySelector(".novel-ss-cmd-star")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          const on = commandLib.toggleFavorite(cmd.id);
          toast(on ? "已收藏" : "已取消收藏");
          if (selectedCategoryId === "__favorites__") {
            render();
          } else {
            renderCommands(container);
            const tree = panelEl.querySelector(".novel-ss-tree");
            if (tree) renderTree(tree);
            refreshBatchBar();
          }
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

  function promptNewCategory(parentId) {
    const name = window.prompt("分类名称：");
    if (!name) return;
    const cat = commandLib.createCategory(parentId, name);
    if (cat) {
      if (parentId) expandedSet.add(parentId);
      selectedCategoryId = cat.id;
      toast("已创建分类");
      render();
    } else {
      toast("分类名不能为空");
    }
  }

  function promptRenameCategory(catId) {
    const cat = commandLib.listCategories()[catId];
    if (!cat) return;
    const name = window.prompt("重命名分类：", cat.name);
    if (!name) return;
    if (commandLib.renameCategory(catId, name)) render();
  }

  function promptDeleteCategory(catId) {
    if (
      !window.confirm(
        "删除该分类？其下所有子分类一并删除，其中的指令将归入「未分类」。",
      )
    )
      return;
    commandLib.deleteCategory(catId);
    if (selectedCategoryId === catId) selectedCategoryId = null;
    toast("已删除分类");
    render();
  }

  function promptNewCommand() {
    const text = window.prompt("输入指令文本：");
    if (!text) return;
    // 收藏视图下新建 → 归入未分类（收藏是属性，不是容器）
    const catId =
      selectedCategoryId === "__favorites__" ? null : selectedCategoryId;
    const cmd = commandLib.createCommand(text, { categoryId: catId });
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
          const cmd = commandLib.createCommand(line, {
            categoryId: selectedCategoryId,
          });
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

  function render() {
    if (!mounted || !panelEl) return;
    // 清理批量选中集中已不存在的指令 id（防止残留脏 id 干扰计数/弹窗）
    const cmds = commandLib.listCommands();
    for (const id of Array.from(batchSelected)) {
      if (!cmds[id]) batchSelected.delete(id);
    }
    // 右栏标题：显示当前文件夹名（搜索 / 收藏 / 未分类 / 分类名）
    const titleEl = panelEl.querySelector(".novel-ss-list-title-label");
    if (titleEl) {
      if (searchQuery) titleEl.textContent = "搜索结果";
      else if (selectedCategoryId === "__favorites__") titleEl.textContent = "收藏";
      else if (selectedCategoryId === null) titleEl.textContent = "未分类";
      else
        titleEl.textContent =
          commandLib.listCategories()[selectedCategoryId]?.name || "指令";
    }
    const tree = panelEl.querySelector(".novel-ss-tree");
    const list = panelEl.querySelector(".novel-ss-list");
    if (tree) renderTree(tree);
    if (list) renderCommands(list);
    refreshBatchBar();
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.className = "novel-ss-panel";
    panel.innerHTML = `
      <div class="novel-ss-toolbar">
        <span class="novel-ss-toolbar-title"><i class="fa-solid fa-book-bookmark"></i> 番外指令库</span>
        <span class="novel-ss-toolbar-actions">
          <i class="fa-solid fa-xmark novel-ss-close" title="关闭"></i>
        </span>
      </div>
      <div class="novel-ss-search-row">
        <i class="fa-solid fa-magnifying-glass"></i>
        <input type="text" class="novel-ss-search" placeholder="搜索指令…" autocomplete="off" />
      </div>
      <div class="novel-ss-body">
        <div class="novel-ss-tree-col">
          <div class="novel-ss-col-title">
            <span>分类</span>
            <span class="novel-ss-cat-title-actions">
              <i class="fa-solid fa-angles-down novel-ss-expand-all" title="展开全部分类"></i>
              <i class="fa-solid fa-angles-up novel-ss-collapse-all" title="收起全部分类"></i>
              <i class="fa-solid fa-plus novel-ss-new-cat" title="新建顶层分类"></i>
            </span>
          </div>
          <div class="novel-ss-tree"></div>
        </div>
        <div class="novel-ss-list-col">
          <div class="novel-ss-col-title">
            <span class="novel-ss-list-title-label">指令</span>
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
            <button class="novel-ss-batch-btn novel-ss-batch-rename"><i class="fa-solid fa-pen"></i> 重命名</button>
            <button class="novel-ss-batch-btn novel-ss-batch-del"><i class="fa-solid fa-trash"></i> 删除</button>
          </div>
          <div class="novel-ss-list"></div>
        </div>
      </div>`;
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
    // 展开/收起全部
    panelEl
      .querySelector(".novel-ss-expand-all")
      .addEventListener("click", () => {
        const cats = commandLib.listCategories();
        for (const id of Object.keys(cats)) expandedSet.add(id);
        render();
      });
    panelEl
      .querySelector(".novel-ss-collapse-all")
      .addEventListener("click", () => {
        expandedSet.clear();
        render();
      });
    // 搜索
    const searchInput = panelEl.querySelector(".novel-ss-search");
    searchInput.addEventListener("input", () => {
      searchQuery = String(searchInput.value || "")
        .trim()
        .toLowerCase();
      renderCommands(panelEl.querySelector(".novel-ss-list"));
    });
    // 新建顶层分类
    panelEl
      .querySelector(".novel-ss-new-cat")
      .addEventListener("click", () => promptNewCategory(null));
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
    // 批量重命名
    panelEl
      .querySelector(".novel-ss-batch-rename")
      .addEventListener("click", batchRenameSelected);
    // 批量删除
    panelEl
      .querySelector(".novel-ss-batch-del")
      .addEventListener("click", batchDeleteSelected);
    // 点击面板外部关闭（批量重命名弹窗打开时跳过，避免弹窗期间误关面板）
    document.addEventListener("mousedown", function onClickOutside(e) {
      if (!panelEl || !mounted || panelEl.contains(e.target)) return;
      if (document.querySelector(".novel-ss-edit-popup-overlay")) return;
      close();
      document.removeEventListener("mousedown", onClickOutside);
    });
    // Esc 关闭（批量重命名弹窗打开时由弹窗自己处理 Esc）
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
      ensureDragHighlightStyle();
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
