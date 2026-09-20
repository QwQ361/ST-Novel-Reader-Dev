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
  let selectedCategoryId = null; // null = 未分类；"__all__" = 全部
  let searchQuery = "";
  let expandedSet = new Set();
  let dragCmdId = null; // 正在拖拽的指令 id
  let dragCatId = null; // 正在拖拽的分类 id

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

    // 「全部」与「未分类」固定项
    const fixedItems = [
      { id: "__all__", name: "全部", icon: "fa-folder-open" },
      { id: null, name: "未分类", icon: "fa-folder-minus" },
    ];
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
        dragCatId = null;
        dragCmdId = null;
        if (srcCmd) {
          // 指令 → 分类
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

  function renderCommands(container) {
    container.innerHTML = "";

    let cmds;
    if (searchQuery) {
      cmds = Object.values(commandLib.listCommands()).filter((c) =>
        String(c.text || "")
          .toLowerCase()
          .includes(searchQuery),
      );
    } else {
      cmds = commandLib.listCommandsByCategory(selectedCategoryId);
    }

    if (!cmds.length) {
      container.innerHTML = `<div class="novel-ss-empty">暂无指令</div>`;
      return;
    }

    cmds.forEach((cmd) => {
      const row = document.createElement("div");
      row.className = "novel-ss-cmd-row";
      row.dataset.cmdId = cmd.id;
      row.draggable = true;
      const catName = cmd.categoryId
        ? commandLib.listCategories()[cmd.categoryId]?.name || "未分类"
        : "未分类";
      row.innerHTML = `
        <i class="fa-solid fa-grip-vertical novel-ss-cmd-drag" title="拖拽到分类"></i>
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
      // 点击指令 → 追加到输入框
      row.addEventListener("click", (e) => {
        if (e.target.closest(".novel-ss-cmd-actions")) return;
        appendToInput(cmd.text);
        toast("已填入输入框");
      });
      // 拖拽指令
      row.addEventListener("dragstart", (e) => {
        dragCmdId = cmd.id;
        e.dataTransfer.setData("text/plain", cmd.id);
        e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        dragCmdId = null;
      });
      // 操作：重命名 / 删除
      row
        .querySelector(".novel-ss-cmd-rename")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          promptRenameCommand(cmd.id);
        });
      row.querySelector(".novel-ss-cmd-del").addEventListener("click", (e) => {
        e.stopPropagation();
        if (window.confirm("删除这条指令？")) {
          commandLib.deleteCommand(cmd.id);
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
      categoryId: selectedCategoryId === "__all__" ? null : selectedCategoryId,
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
            categoryId:
              selectedCategoryId === "__all__" ? null : selectedCategoryId,
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

  function render() {
    if (!mounted || !panelEl) return;
    const tree = panelEl.querySelector(".novel-ss-tree");
    const list = panelEl.querySelector(".novel-ss-list");
    if (tree) renderTree(tree);
    if (list) renderCommands(list);
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
            </span>
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
    // 点击面板外部关闭
    document.addEventListener("mousedown", function onClickOutside(e) {
      if (!panelEl || !mounted || panelEl.contains(e.target)) return;
      close();
      document.removeEventListener("mousedown", onClickOutside);
    });
    // Esc 关闭
    document.addEventListener("keydown", function onEsc(e) {
      if (!panelEl || !mounted) return;
      if (e.key === "Escape") {
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
    panelEl.style.display = "block";
    render();
  }

  function close() {
    if (!mounted || !panelEl) return;
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
