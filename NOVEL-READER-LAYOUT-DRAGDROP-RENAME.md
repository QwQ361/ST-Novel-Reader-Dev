# 小说阅读器：可复用的布局 / 拖放 / 重命名弹窗代码与 CSS 总结

> 面向新插件「酒馆小说阅读器」的代码复用清单。
> 本文件聚焦 **CFM（AAAA-ST-Folder-Manager-V2）中不涉及酒馆原生资源的纯 UI / 交互 / 弹窗实现**，可直接照搬或改造复用。
>
> 覆盖四块内容：
>
> 1. 文件夹左右分栏布局（CSS）
> 2. 拖动移入文件夹的拖放指示（JS + CSS）
> 3. 批量拖动时的靶子图标（JS + CSS）
> 4. 批量重命名弹窗（JS + CSS）

---

## 0. 总览：哪些可以无脑抄，哪些要改

| 复用项                       | 来源文件                                                                                                        | 改动量 | 说明                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------- |
| 双栏布局骨架                 | [`style.css`](../style.css) L90-388                                                                             | 极小   | 纯 CSS，类名可照抄或改前缀        |
| 拖放指示三区域判定           | [`ui/tree/tree-view.js`](../ui/tree/tree-view.js) L259-315                                                      | 极小   | 纯算法，与数据无关                |
| 拖放指示 CSS（线/高亮/禁止） | [`style.css`](../style.css) L299-316 / L439-464 / L997-1012                                                     | 极小   | 纯 CSS                            |
| PC 端 dragstart 封装         | [`features/dragdrop/desktop.js`](../features/dragdrop/desktop.js) L14-107                                       | 小     | 需自建数据对象，无 ST 依赖        |
| 移动端触摸拖拽               | [`features/dragdrop/mobile.js`](../features/dragdrop/mobile.js) L386-620                                        | 中     | 是自研触摸方案（非 ST），整体可搬 |
| 批量拖拽幽灵 `📦 共 N 项`     | [`desktop.js`](../features/dragdrop/desktop.js) L50-51 / [`mobile.js`](../features/dragdrop/mobile.js) L386-415 | 极小   | 纯 UI                             |
| 靶子图标（fa-crosshairs）    | [`ui/views/chatlogs-view.js`](../ui/views/chatlogs-view.js) L140/L215 + [`style.css`](../style.css) L5471-5497  | 极小   | 模式类开关显隐                    |
| 弹窗 Promise 模式            | [`features/chatlogs/rename.js`](../features/chatlogs/rename.js) L173-415                                        | 小     | 纯前端弹窗，与重命名解耦          |
| 自动检测公共前/后缀          | [`features/chatlogs/rename.js`](../features/chatlogs/rename.js) L331-363                                        | 极小   | 纯字符串算法                      |
| 逐个重命名表格               | [`rename.js`](../features/chatlogs/rename.js) L253-258 + [`style.css`](../style.css) L5377-5442                 | 小     | 纯 UI                             |
| 批量执行统计 + toastr 汇总   | [`rename.js`](../features/chatlogs/rename.js) L417-549                                                          | 小     | 模式与执行解耦，可换业务          |

> ⚠️ **明确不涉及**：聊天记录文件读取、`chatGroups` 文件夹映射、`pinnedChats` 置顶、`getCharacters`/`getContext` 等酒馆原生资源 API。下面所有可复用代码 **都不依赖酒馆原生资源**，可以放心复制。

---

## 1. 文件夹左右分栏布局（CSS）

### 1.1 结构层级

```
#cfm-popup            ← 弹窗容器（flex column）
└── .cfm-dual-pane    ← 双栏容器（flex row, flex:1）
    ├── .cfm-left-pane    ← 左栏：文件夹树（固定宽 260px）
    │   ├── .cfm-left-header
    │   └── .cfm-left-tree
    │       └── .cfm-tnode（树节点，含 selected 高亮）
    └── .cfm-right-pane   ← 右栏：内容列表（flex:1）
        ├── .cfm-right-header（路径 / 计数 / 模式按钮）
        └── .cfm-right-list
            └── .cfm-row（列表行）
```

### 1.2 核心 CSS（照抄级）

来源：[`style.css`](../style.css) L90-388

```css
/* 主容器：固定宽高 + 纵向 flex */
#cfm-popup {
  width: 96vw;
  max-width: 960px;
  height: 88vh;
  display: flex;
  flex-direction: column;
  /* …边框、圆角、阴影、背景走主题色变量… */
}

/* 双栏：占满剩余高度，内部各自滚动 */
.cfm-dual-pane {
  display: flex;
  flex: 1;
  min-height: 0;   /* ← 关键：允许子元素收缩并内部滚动 */
  overflow: hidden;
}

/* 左栏：固定宽度区间 + 右分隔线 */
.cfm-left-pane {
  width: 260px;
  min-width: 200px;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
  border-right: 1px solid var(--SmartThemeBorderColor, #45475a);
}

/* 右栏：flex 撑满 */
.cfm-right-pane {
  flex: 1;
  min-width: 0;      /* ← 关键：防止长内容撑爆 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 左右两栏的滚动区 */
.cfm-left-tree,
.cfm-right-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
```

### 1.3 关键技巧（直接抄）

1. **`min-height: 0` + `flex: 1`**：这是"父容器 flex column、子容器内部滚动"的标配，缺一不可。没有 `min-height: 0` 子元素会被内容撑高、滚动失效。
2. **右栏 `min-width: 0`**：防止超长名称把右栏撑出容器。
3. **左栏 `flex-shrink: 0` + 宽度区间**：260px 默认、200-360px 可调，天然支持后续加拖拽调宽。
4. **列表行 `.cfm-row`**：`display:flex; align-items:center; padding`，内部 `icon / name(main) / actions` 三段式，`name` 区 `flex:1; min-width:0` 配合 `text-overflow:ellipsis` 截断。

### 1.4 移动端适配（可选项）

来源：[`style.css`](../style.css) L2268-2285、L2486-2490、L2549-2560

- **竖屏变上下**：左栏 `width:auto; height:40%; border-right:none; border-bottom`（媒体查询内）
- **分隔线拖动手柄**：`.cfm-left-pane::after` 伪元素做窄条，`cursor:col-resize`
- **全屏模式**：可整体隐藏左栏，加返回按钮

---

## 2. 拖动移入文件夹的拖放指示（JS + CSS）

### 2.1 三区域判定算法（纯逻辑，直接抄）

来源：[`ui/tree/tree-view.js`](../ui/tree/tree-view.js) L259-315

核心思想：**把目标元素按相对高度切成上/中/下三段**，分别代表"插入到前面 / 移入内部 / 插入到后面"。

```js
// 在 dragover 处理器内
function computeDropZone(e, $target) {
  const rect = $target[0].getBoundingClientRect();
  const relativeY = (e.clientY - rect.top) / rect.height;
  let zone;
  if (relativeY < 0.25) zone = "before";
  else if (relativeY > 0.75) zone = "after";
  else zone = "into";
  // 关键：把判定结果存到元素上，供 drop 时读取
  $target.data("dropZone", zone);
  // 清理旧类，打上新类
  $target
    .removeClass("cfm-drop-before cfm-drop-after cfm-drop-target")
    .addClass(zone === "before" ? "cfm-drop-before"
           : zone === "after"  ? "cfm-drop-after"
           : "cfm-drop-target");
}
```

**配套约定（跨端统一）**：

- `before` → `.cfm-drop-before`
- `after` → `.cfm-drop-after`
- `into` → `.cfm-drop-target`
- 禁止（同文件夹 / 循环嵌套）→ `.cfm-drop-forbidden`
- 整个列表容器整体可放 → `.cfm-right-list-drop-target`

### 2.2 拖放指示 CSS（照抄级）

来源：[`style.css`](../style.css) L299-316（树节点）、L439-464（列表行）、L460-464（列表整体）、L997-1012（根 dropzone）

```css
/* 树节点：插入线（上/下）+ 移入高亮 */
.cfm-tnode.cfm-drop-before { box-shadow: inset 0 2px 0 0 #89b4fa; }
.cfm-tnode.cfm-drop-after  { box-shadow: inset 0 -2px 0 0 #89b4fa; }
.cfm-tnode.cfm-drop-target {
  background: rgba(137, 180, 250, 0.15);
  box-shadow: inset 3px 0 0 0 #89b4fa;   /* 左边框色条 */
}

/* 列表行：移入 = 虚线框 + 背景；前后 = 插入线；禁止 = 红 */
.cfm-row.cfm-drop-target {
  background: rgba(137, 180, 250, 0.15);
  outline: 2px dashed #89b4fa;
  outline-offset: -2px;
}
.cfm-row.cfm-drop-before { box-shadow: inset 0 2px 0 0 #89b4fa; }
.cfm-row.cfm-drop-after  { box-shadow: inset 0 -2px 0 0 #89b4fa; }
.cfm-row.cfm-drop-forbidden { background: rgba(243, 139, 168, 0.15); }

/* 整个右侧列表容器作为放置区 */
.cfm-right-list.cfm-right-list-drop-target {
  background: rgba(137, 180, 250, 0.08);
  outline: 2px dashed #89b4fa;
  outline-offset: -2px;
}

/* 根 dropzone：虚线框 + 中央提示文字，拖动经过变绿 */
.cfm-root-dropzone {
  border: 2px dashed var(--SmartThemeBorderColor, #45475a);
  /* …圆角、flex 居中、文字提示… */
}
.cfm-root-dropzone.cfm-drag-over {
  border-color: #a6e3a1;
  background: rgba(166, 227, 161, 0.08);
}
```

**设计要点**：

- 用 `box-shadow: inset` 画"插入线"，不改变布局尺寸、不产生重排，性能好。
- 用 `outline` 画虚线框（outline 不占布局空间）。
- 三个状态类互斥，由 JS 统一 `removeClass` 后再 `addClass`。

### 2.3 PC 端拖拽封装（无 ST 依赖，直接抄）

来源：[`features/dragdrop/desktop.js`](../features/dragdrop/desktop.js) L14-107

```js
/* ---------- 拖拽开始 ---------- */
function pcDragStart(e, dragData) {
  // 1) 清掉酒馆 body.dragover 残留（避免弹窗关闭后界面变淡）
  $("body").removeClass("dragover");

  // 2) 数据通道：全局变量优先，dataTransfer 兜底
  window.__myDragData = dragData;
  if (e.originalEvent && e.originalEvent.dataTransfer) {
    const dt = e.originalEvent.dataTransfer;
    dt.setData("text/plain", JSON.stringify(dragData));
    dt.effectAllowed = "move";
  }

  // 3) 批量拖拽幽灵：拖起多个时显示 📦 共 N 项
  if (dragData.multiSelect) {
    const ghost = document.createElement("div");
    ghost.textContent = `📦 共 ${dragData.count} 项`;
    ghost.style.position = "fixed";
    ghost.style.top = "-9999px";          // 先藏起来
    ghost.style.left = "-9999px";
    ghost.style.background = "#45475a";
    ghost.style.color = "#cdd6f4";
    ghost.style.padding = "4px 10px";
    ghost.style.borderRadius = "6px";
    ghost.style.fontSize = "13px";
    ghost.style.pointerEvents = "none";
    ghost.style.zIndex = "999999";
    document.body.appendChild(ghost);
    if (dt) dt.setDragImage(ghost, 10, 10);
    setTimeout(() => ghost.remove(), 0);
  }
}

/* ---------- 拖拽取数据 ---------- */
function pcGetDropData(e) {
  // 全局变量优先（同页面内拖拽最稳）
  if (window.__myDragData) return window.__myDragData;
  // 兜底：解析 dataTransfer
  try {
    const raw = e.originalEvent?.dataTransfer?.getData("text/plain");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
```

**关键经验**：

1. **幽灵元素必须在 `dragstart` 同步创建**，`setDragImage` 后才 `setTimeout` 移除。
2. **`setData` 必须同步调用**，否则浏览器（尤其 Chrome）会抛 `InvalidStateError`。
3. **全局变量 + dataTransfer 双通道**：同一页面内拖拽优先读全局变量，跨标签页等边缘情况走 dataTransfer。
4. `dragend` 里记得清 `window.__myDragData` 与源行的 `cfm-dragging` 类（源行半透明）。

### 2.4 拖拽目标高亮动画（可选增强）

来源：[`features/dragdrop/drop-zones.js`](../features/dragdrop/drop-zones.js) L1-159

- `ensureDragLocateHighlightStyleCore`：往 `<head>` 注入 `@keyframes cfmDragHighlightPulse`（拖拽时目标轻微闪烁脉冲）。
- `flashDraggedElementCore`：dragstart 时让被拖元素闪烁 2 次，提示"拿起来了"。

---

## 3. 批量拖动时的靶子图标（JS + CSS）

### 3.1 交互逻辑

来源：[`ui/views/chatlogs-view.js`](../ui/views/chatlogs-view.js) L140/L150-153、L215/L217-220

**设计**：左栏文件夹树每个节点**常驻渲染**一个靶子图标，但默认隐藏；只有进入"多选/批量模式"（父容器加 `.cfm-multisel-on` 类）才显示。这样免去模式切换时重新渲染树的成本。

```html
<!-- 树节点里始终带着靶子按钮 -->
<span class="cfm-tnode-target" title="移入此文件夹">
  <i class="fa-solid fa-crosshairs"></i>
</span>
```

```js
// 点击靶子 → 把当前批量选中的资源移到该文件夹
$targetBtn.on("click", (e) => {
  e.stopPropagation();          // 别触发节点展开/选中
  moveSelectedToFolder(folderId);
});
```

### 3.2 CSS（照抄级）

来源：[`style.css`](../style.css) L5471-5497

```css
/* 默认隐藏 */
.cfm-tnode-target,
.cfm-row-target-btn {
  display: none !important;
}

/* 多选模式下显示为绿色靶子 */
#cfm-popup.cfm-multisel-on .cfm-tnode-target,
#cfm-popup.cfm-multisel-on .cfm-row-target-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  color: #a6e3a1;               /* 绿色 */
  cursor: pointer;
  margin-left: 4px;
}
#cfm-popup.cfm-multisel-on .cfm-tnode-target:hover,
#cfm-popup.cfm-multisel-on .cfm-row-target-btn:hover {
  color: #57f287;               /* hover 变亮 */
}
```

### 3.3 多选工具栏（可选）

来源：[`style.css`](../style.css) L5499-5508 + [`rename.js`](../features/chatlogs/rename.js) L551-580

```html
<div class="cfm-multisel-toolbar">
  <button class="cfm-btn cfm-btn-sm cfm-multisel-selectall">全选 / 全不选</button>
  <button class="cfm-btn cfm-btn-sm cfm-multisel-range">框选(开)</button>
  <span class="cfm-multisel-count">已选 N 项</span>
</div>
```

---

## 4. 批量重命名弹窗（JS + CSS）

### 4.1 弹窗 Promise 模式（纯前端，直接抄）

来源：[`features/chatlogs/rename.js`](../features/chatlogs/rename.js) L173-415

**核心设计**：弹窗函数返回 `Promise`，确认/取消/遮罩点击都 `resolve` 出结果或 `null`，调用方 `await` 后按结果执行。弹窗与业务完全解耦，可任意换内容复用。

```js
async function showMyRenamePopup(names) {
  const isSingle = names.length === 1;
  const popupHtml = `
    <div class="cfm-edit-popup-overlay">
      <div class="cfm-edit-popup">
        <div class="cfm-edit-popup-title">${isSingle ? "重命名" : "批量重命名"}</div>
        <div class="cfm-edit-popup-names">${nameListHtml(names)}</div>
        <div class="cfm-edit-popup-field">
          <label>新名称</label>
          <input type="text" class="cfm-edit-input" placeholder="输入新名称">
        </div>
        <div class="cfm-edit-popup-actions">
          <button class="cfm-btn cfm-edit-popup-cancel">取消</button>
          <button class="cfm-btn cfm-edit-popup-confirm">确认</button>
        </div>
      </div>
    </div>`;
  const overlay = $(popupHtml);
  $("body").append(overlay);
  overlay.find(".cfm-edit-input").trigger("focus").select();

  return new Promise((resolve) => {
    overlay.find(".cfm-edit-popup-cancel").on("click", () => {
      overlay.remove();
      resolve(null);
    });
    // 遮罩点击关闭：必须校验 target 类名，避免点卡片内部误关
    overlay.find(".cfm-edit-popup-overlay").on("click", (e) => {
      if ($(e.target).hasClass("cfm-edit-popup-overlay")) {
        overlay.remove();
        resolve(null);
      }
    });
    overlay.find(".cfm-edit-popup-confirm").on("click", () => {
      const value = overlay.find(".cfm-edit-input").val().trim();
      overlay.remove();
      resolve(value || null);
    });
    // 键盘：Enter 确认 / Escape 取消
    overlay.find(".cfm-edit-input").on("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        overlay.find(".cfm-edit-popup-confirm").trigger("click");
      }
      if (e.key === "Escape") {
        overlay.find(".cfm-edit-popup-cancel").trigger("click");
      }
    });
  });
}
```

**可复用的套路清单**：

1. 遮罩 + 卡片两层结构，`$("body").append(overlay)`，无需预建 DOM。
2. 遮罩点击关闭：必须 `hasClass("cfm-edit-popup-overlay")` 校验，否则点卡片内部也会误关。
3. Enter/Escape 键盘支持，`trigger("click")` 复用按钮逻辑。
4. 关闭即 `overlay.remove()`，无内存泄漏。
5. 名称预览列表：≤5 个全列，>5 个只列前 5 + `...等共 N 个`。

### 4.2 弹窗 CSS（照抄级）

来源：[`style.css`](../style.css) L4183-4426

```css
/* 全屏遮罩：固定定位 + 半透明 + 居中 */
.cfm-edit-popup-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100000;                  /* 必须压过酒馆所有层级 */
  animation: cfm-fade-in 0.2s ease;
}

/* 卡片本体：主题色 + 上限宽 */
.cfm-edit-popup {
  background: var(--SmartThemeBlurTintColor, #1e1e2e);
  border: 1px solid var(--SmartThemeBorderColor, #45475a);
  border-radius: 10px;
  width: min(480px, 90vw);
  max-height: 80vh;
  overflow-y: auto;
  padding: 20px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.cfm-edit-popup-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--SmartThemeBodyColor, #cdd6f4);
  margin-bottom: 14px;
}

/* 名称预览列表 */
.cfm-edit-popup-names {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 14px;
}
.cfm-edit-name-item {
  background: rgba(137, 180, 250, 0.12);
  color: #89b4fa;
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 12px;
}
.cfm-edit-name-more { opacity: 0.7; }

/* 输入项 */
.cfm-edit-input {
  width: 100%;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--SmartThemeBorderColor, #45475a);
  border-radius: 6px;
  color: var(--SmartThemeBodyColor, #cdd6f4);
  padding: 8px 10px;
  font-size: 13px;
  box-sizing: border-box;
}
.cfm-edit-input:focus {
  border-color: #89b4fa;
  outline: none;
  box-shadow: 0 0 0 2px rgba(137, 180, 250, 0.25);
}

/* 按钮组：右对齐 */
.cfm-edit-popup-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
.cfm-edit-popup-confirm {
  background: #89b4fa;
  color: #11111b;
  border: none;
  padding: 8px 18px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
}
.cfm-edit-popup-cancel {
  background: transparent;
  color: #f38ba8;
  border: 1px solid #f38ba8;
  padding: 8px 18px;
  border-radius: 6px;
  cursor: pointer;
}
.cfm-edit-popup-cancel:hover { background: rgba(243, 139, 168, 0.15); }

@keyframes cfm-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
```

### 4.3 自动检测公共前/后缀（纯字符串算法，直接抄）

来源：[`features/chatlogs/rename.js`](../features/chatlogs/rename.js) L331-363 + [`style.css`](../style.css) L5343-5375

```js
// 求公共前缀（传入 baseName 数组）
function findCommonPrefix(names) {
  if (!names.length) return "";
  let p = names[0];
  for (const n of names) {
    while (n.indexOf(p) !== 0 && p) p = p.slice(0, -1);
    if (!p) break;
  }
  return p;
}
// 求公共后缀（先反转再求前缀）
function findCommonSuffix(names) {
  const rev = names.map((n) => [...n].reverse().join(""));
  const p = findCommonPrefix(rev);
  return [...p].reverse().join("");
}
```

检测结果渲染为可点击胶囊，点击直接填入输入框：

```html
<span class="cfm-rename-detect-item" data-value="公共前缀">公共前缀</span>
```

```css
.cfm-rename-detect-item {
  background: rgba(137, 180, 250, 0.15);
  color: #89b4fa;
  padding: 2px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.cfm-rename-detect-item:hover { background: rgba(137, 180, 250, 0.3); }
.cfm-rename-detect-none { color: #a6adc8; font-size: 12px; }
```

```js
// 点击胶囊 → 填入输入框
overlay.on("click", ".cfm-rename-detect-item", function () {
  overlay.find(".cfm-edit-input").val($(this).data("value"));
});
```

### 4.4 逐个重命名表格（纯 UI，直接抄）

来源：[`rename.js`](../features/chatlogs/rename.js) L253-258 + [`style.css`](../style.css) L5377-5442

```html
<div class="cfm-rename-individual-list">
  <div class="cfm-rename-individual-row">
    <span class="cfm-rename-old-name" title="原完整名">旧名称</span>
    <span class="cfm-rename-arrow">→</span>
    <input type="text" class="cfm-rename-new-input"
           placeholder="留空则不修改"
           data-old-name="原完整名" data-ext=".jsonl" value="">
  </div>
  <!-- 每行一个，循环生成 -->
</div>
```

```css
/* 列表容器：限高滚动 */
.cfm-rename-individual-list {
  max-height: 360px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
/* 行：旧名(40%) + 箭头 + 输入框(flex 1) */
.cfm-rename-individual-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cfm-rename-old-name {
  flex: 0 0 40%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--SmartThemeBodyColor, #cdd6f4);
  font-size: 12px;
}
.cfm-rename-arrow { color: #a6adc8; font-size: 12px; flex-shrink: 0; }
.cfm-rename-new-input {
  flex: 1;
  min-width: 0;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--SmartThemeBorderColor, #45475a);
  border-radius: 6px;
  color: var(--SmartThemeBodyColor, #cdd6f4);
  padding: 6px 8px;
  font-size: 12px;
  box-sizing: border-box;
}
```

数据收集（确认时遍历每行）：

```js
const renameMap = {};
overlay.find(".cfm-rename-individual-row").each(function () {
  const input = $(this).find(".cfm-rename-new-input");
  const oldName = input.data("old-name");
  const newBaseName = input.val().trim();
  if (newBaseName) renameMap[oldName] = `${newBaseName}${input.data("ext") || ""}`;
});
// → resolve({ mode: "individual", renameMap })
```

### 4.5 批量执行统计 + toastr 汇总（可复用模式）

来源：[`rename.js`](../features/chatlogs/rename.js) L417-549

```js
async function executeBatchRename(names, result) {
  let success = 0, skipped = 0, failed = 0;

  async function renameOne(oldName, newName) {
    if (!newName) return "skip-empty";
    if (newName === oldName) return "skip-same";
    const ok = await doRename(oldName, newName);   // 换成你的业务
    return ok ? "success" : "failed";
  }

  for (const oldName of names) {
    const newName = computeNewName(oldName, result); // 换你的业务
    const status = await renameOne(oldName, newName);
    if (status === "success") success++;
    else if (status === "skip-empty" || status === "skip-same") skipped++;
    else failed++;
  }

  let msg = `批量重命名完成：成功 ${success} 个`;
  if (skipped > 0) msg += `，跳过 ${skipped} 个`;
  if (failed > 0) msg += `，失败 ${failed} 个`;
  if (success > 0) cfmToastr.success(msg);
  else if (failed > 0) cfmToastr.warning(msg);
  else cfmToastr.info(msg);
}
```

**要点**：弹窗（收集意图）与执行（真正改数据）严格分离——弹窗只返回 `{ mode, action, text }` 或 `{ mode:"individual", renameMap }`，执行层拿到后再遍历。这样弹窗可以 100% 复用，业务只需替换 `doRename` 与 `computeNewName`。

---

## 5. 给小说阅读器的落地建议

### 5.1 分栏布局直接照搬

阅读器主界面完全可以用同样的 `#cfm-popup → .cfm-dual-pane → 左树 + 右列表` 结构：

- 左栏：**角色列表**（或 角色 → 聊天记录 两级树），对应 CFM 的文件夹树，复用 `.cfm-tnode` 节点样式 + selected 高亮 + `data-id` 定位。
- 右栏：聊天记录列表，复用 `.cfm-row` 行样式（图标 + 名称 + meta 三段式）。
- 这样天然支持"查阅非当前角色 / 非当前聊天记录"：左树遍历所有角色，右列表展示该角色全部聊天。

### 5.2 拖放指示整套搬（如做"把聊天拖进书架/收藏夹"）

- 三区域判定算法、`.cfm-drop-*` 五类 CSS、PC 封装、移动端触摸方案（自研，不依赖 ST 拖拽），都是纯逻辑 + 纯 CSS。
- 只需把 `dragData.type` 换成你的业务类型（如 `"novel-book"`、`"chatlog-item"`），drop 时按 `type` 分发即可。

### 5.3 靶子图标用于"批量收藏/批量移入书架"

- 树节点常驻渲染靶子 + `#cfm-popup.cfm-multisel-on` 控制显隐的模式照抄，批量模式下点击靶子 = 一键把选中的聊天移入目标书架/分组。
- 多选工具栏（全选/框选/计数）也可复用。

### 5.4 重命名弹窗 = 阅读器的"收藏/书架改名"

- Promise 弹窗骨架、自动检测公共前后缀、逐个重命名表格，都是纯 UI，可直接用于书架的批量改名。
- 注意：CFM 中聊天记录重命名本身调用酒馆 `renameGroupOrCharacterChatFunc` / `ctx.renameChat`（**属于酒馆原生资源**，见 [`rename.js`](../features/chatlogs/rename.js) L75-116）——小说阅读器若只需改自己的书架名/收藏名，**不要抄这段**，改成读写自己的存储即可。

### 5.5 通用可复用清单（最终版）

| #   | 复用内容                               | 来源                                                  | 依赖酒馆原生? |
| --- | -------------------------------------- | ----------------------------------------------------- | ------------- |
| 1   | 双栏布局 CSS + `min-height:0` 滚动技巧 | `style.css` L90-388                                   | 否            |
| 2   | 三区域拖放判定算法                     | `tree-view.js` L259-315                               | 否            |
| 3   | 拖放指示 CSS（线/高亮/禁止/根区）      | `style.css` L299-316 / L439-464 / L997-1012           | 否            |
| 4   | PC dragstart 封装 + 双通道数据         | `desktop.js` L14-107                                  | 否            |
| 5   | 移动端触摸拖拽（自研方案）             | `mobile.js` L386-620                                  | 否            |
| 6   | 批量拖拽幽灵 `📦 共 N 项`               | `desktop.js` L50-51 / `mobile.js` L386-415            | 否            |
| 7   | 拖拽高亮脉冲动画注入                   | `drop-zones.js` L1-159                                | 否            |
| 8   | 靶子图标 + 模式类开关显隐              | `chatlogs-view.js` L140/L215 + `style.css` L5471-5497 | 否            |
| 9   | 多选工具栏（全选/框选/计数）           | `rename.js` L551-580 + `style.css` L5499-5508         | 否            |
| 10  | Promise 弹窗骨架（遮罩/键盘/关闭清理） | `rename.js` L173-415                                  | 否            |
| 11  | 自动检测公共前/后缀                    | `rename.js` L331-363                                  | 否            |
| 12  | 逐个重命名表格                         | `rename.js` L253-258 + `style.css` L5377-5442         | 否            |
| 13  | 批量执行统计 + toastr 汇总             | `rename.js` L417-549                                  | 否            |

> **结论**：以上 13 项全部为**纯前端 UI / 交互 / 算法**，不触碰酒馆原生资源 API（不读聊天文件、不动 `chatGroups`/`pinnedChats`/`getContext`），小说阅读器可以直接照搬，只需替换业务数据类型与存储读写。真正涉及酒馆原生资源的只有 CFM 中"聊天文件改名/删除"的执行段（`renameChatFile` L75-116、`deleteChatFile` 等），阅读器若只需要管理自己的书架/收藏，完全绕开它们。
