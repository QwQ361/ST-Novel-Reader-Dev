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
  let selectedCategoryId = null; // null = 未分类
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

    // 「未分类」固定项（标注/新建指令默认归入；也作为拖拽目标）
    const fixedItems = [{ id: null, name: "未分类", icon: "fa-folder-minus" }];
    fixedItems.forEach((it) => {
      const row = document.createElement("div");
      row.className =
        "novel-ss-cat-row" +
        (selectedCategoryId === it.id ? " novel-ss-cat-selected" : "");
      row.dataset.catId = String(it.id === null ? "__uncat__" : it.id);
      row.innerHTML = `<i class="fa-solid ${it.icon} novel-ss-cat-icon"></i><span class="novel-ss-cat-name">${escapeHtml(it.name)}</span>`;
      row.addEventListener("click", () => {
        selectedCategoryId = it.id;
        render();
      });
      // 拖拽目标：指令（单个/批量）/分类可放入「未分类」
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });
      row.addEventListener("drop", (e) => {
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
      });
      container.appendChild(row);
    });

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
      row.innerHTML = `
        <span class="novel-ss-cat-arrow ${hasChildren ? "" : "novel-ss-cat-arrow-empty"}">
          <i class="fa-solid fa-chevron-right ${expanded ? "novel-ss-rotated" : ""}"></i>
        </span>
        <i class="fa-solid fa-folder novel-ss-cat-icon"></i>
        <span class="novel-ss-cat-name">${escapeHtml(cat.name)}</span>
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
      // 拖拽：分类可拖（移动到别的分类下）
      row.addEventListener("dragstart", (e) => {
        dragCatId = catId;
        e.dataTransfer.setData("text/plain", catId);
        e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
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
        if (srcCmds && srcCmds.length) {
          // 批量指令 → 分类
          let moved = 0;
          for (const cid of srcCmds) {
            if (commandLib.updateCommand(cid, { categoryId: catId })) moved++;
          }
          toast(`已移动 ${moved} 条指令`);
        } else if (srcCmd) {
          // 单个指令 → 分类
          commandLib.updateCommand(srcCmd, { categoryId: catId });
          toast("已移入分类");
        } else if (srcCat && srcCat !== catId) {
          commandLib.moveCategory(srcCat, catId);
          toast("已移动分类");
        }
        render();
      });
      // 分类操作按钮（悬停显示）：新建子分类 / 重命名 / 删除
      const actions = document.createElement("span");
      actions.className = "novel-ss-cat-actions";
      actions.innerHTML = `
        <i class="fa-solid fa-plus novel-ss-cat-add" title="新建子分类"></i>
        <i class="fa-solid fa-pen novel-ss-cat-rename" title="重命名"></i>
        <i class="fa-solid fa-trash novel-ss-cat-del" title="删除"></i>`;
      actions
        .querySelector(".novel-ss-cat-add")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          promptNewCategory(catId);
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
      row.appendChild(actions);
      container.appendChild(row);

      if (expanded) children.forEach((cid) => renderNode(cid, depth + 1));
    };
    rootIds.forEach((cid) => renderNode(cid, 0));
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
   * 批量重命名弹窗（Promise 模式）。
   * @param {string[]} labels 选中指令的显示名（用于预览与前后缀检测）
   * @returns {Promise<string|null>} 确认返回新名称（留空 = "" 表示清除），取消返回 null
   */
  function showBatchRenamePopup(labels) {
    const overlay = document.createElement("div");
    overlay.className = "novel-ss-edit-popup-overlay";
    overlay.innerHTML = `
      <div class="novel-ss-edit-popup">
        <div class="novel-ss-edit-popup-title">批量重命名 ${labels.length} 条指令</div>
        <div class="novel-ss-edit-popup-names">${nameListHtml(labels)}</div>
        <div class="novel-ss-edit-popup-detect">
          <span class="novel-ss-edit-detect-label">公共部分：</span>
          <span class="novel-ss-edit-detect-none">（无）</span>
        </div>
        <div class="novel-ss-edit-popup-field">
          <label>新名称</label>
          <input type="text" class="novel-ss-edit-input" placeholder="输入新名称（留空则清除名称）" autocomplete="off" />
        </div>
        <div class="novel-ss-edit-popup-actions">
          <button class="novel-ss-edit-popup-cancel">取消</button>
          <button class="novel-ss-edit-popup-confirm">确认</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector(".novel-ss-edit-input");
    input.focus();
    input.select();

    // 公共前/后缀检测：点击胶囊直接填入输入框
    const prefix = findCommonPrefix(labels);
    const suffix = findCommonSuffix(labels);
    if (prefix || suffix) {
      const detectBox = overlay.querySelector(".novel-ss-edit-popup-detect");
      detectBox.innerHTML =
        '<span class="novel-ss-edit-detect-label">公共部分：</span>';
      if (prefix) {
        const cap = document.createElement("span");
        cap.className = "novel-ss-edit-detect-item";
        cap.textContent = `前缀「${prefix}」`;
        cap.title = "点击填入";
        cap.addEventListener("click", () => {
          input.value = prefix;
          input.focus();
        });
        detectBox.appendChild(cap);
      }
      if (suffix) {
        const cap = document.createElement("span");
        cap.className = "novel-ss-edit-detect-item";
        cap.textContent = `后缀「${suffix}」`;
        cap.title = "点击填入";
        cap.addEventListener("click", () => {
          input.value = suffix;
          input.focus();
        });
        detectBox.appendChild(cap);
      }
    }

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
      // 确认：留空也返回 ""（表示清除名称），仅取消返回 null
      overlay
        .querySelector(".novel-ss-edit-popup-confirm")
        .addEventListener("click", () => finish(input.value.trim()));
      // 键盘：Enter 确认 / Escape 取消
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          overlay.querySelector(".novel-ss-edit-popup-confirm").click();
        } else if (e.key === "Escape") {
          overlay.querySelector(".novel-ss-edit-popup-cancel").click();
        }
      });
    });
  }

  /** 批量重命名：给所有选中的指令设置名称 */
  async function batchRenameSelected() {
    const cmds = commandLib.listCommands();
    const ids = Array.from(batchSelected).filter((id) => cmds[id]);
    if (!ids.length) {
      toast("请先选择指令");
      return;
    }
    const labels = ids.map((id) => cmds[id]?.name || cmds[id]?.text || "");
    const name = await showBatchRenamePopup(labels);
    if (name === null) return;
    let n = 0;
    for (const id of ids) {
      if (commandLib.updateCommand(id, { name: String(name || "").trim() }))
        n++;
    }
    toast(`已重命名 ${n} 条指令`);
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
      const catName = cmd.categoryId
        ? commandLib.listCategories()[cmd.categoryId]?.name || "未分类"
        : "未分类";
      row.innerHTML = `
        ${batchMode ? `<i class="${selected ? "fa-solid fa-square-check" : "fa-regular fa-square"} novel-ss-cmd-check" title="选择"></i>` : `<i class="fa-solid fa-grip-vertical novel-ss-cmd-drag" title="拖拽到分类"></i>`}
        <div class="novel-ss-cmd-main">
          <div class="novel-ss-cmd-title">${escapeHtml(cmd.name || cmd.text)}</div>
          <div class="novel-ss-cmd-meta">
            ${cmd.name ? `<span class="novel-ss-cmd-text">${escapeHtml(cmd.text)}</span>` : ""}
            <span class="novel-ss-cmd-cat">${escapeHtml(catName)}</span>
          </div>
        </div>
        <span class="novel-ss-cmd-actions">
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
        } else {
          dragCmdId = cmd.id;
          dragCmdIds = null;
        }
        e.dataTransfer.setData("text/plain", cmd.id);
        e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        dragCmdId = null;
        dragCmdIds = null;
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
    const cmd = commandLib.createCommand(text, {
      categoryId: selectedCategoryId,
    });
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
            <span>指令</span>
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
