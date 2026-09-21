# 小说阅读器 · 拖拽视觉 / 左栏 UI / 收藏实现 复用总结

> 本文档总结 CFM 中「挪动时的视觉效果（单项/多项）」「左栏 UI（收藏/文件夹/未归类）」「右栏收藏及收藏实现」三部分代码，供小说阅读器（Novel Reader）复用。
> **均不涉及酒馆原生资源**，全部是 CFM 自建 DOM + 自建状态 + 自建存储，可直接移植。

---

## 目录

1. [一、挪动时的视觉效果（单项 / 多项）](#一挪动时的视觉效果单项--多项)
2. [二、左栏 UI（收藏 / 文件夹 / 未归类）](#二左栏-ui收藏--文件夹--未归类)
3. [三、右栏收藏及收藏实现](#三右栏收藏及收藏实现)
4. [四、可复用清单（直接照抄）](#四可复用清单直接照抄)
5. [五、小说阅读器落地建议](#五小说阅读器落地建议)

---

## 一、挪动时的视觉效果（单项 / 多项）

### 1.1 多选拖拽数据构造 — `features/selection/mode.js` (L101-115)

`getMultiDragDataCore(singleData, deps)`：当多选模式开启且选中集合 > 1 且当前拖拽项在选中集合内时，把 `singleData` 扩展为：

```js
export function getMultiDragDataCore(singleData, deps) {
  const selected = deps.getMultiSelected();
  if (!deps.getMultiSelectMode() || selected.size <= 1) return singleData;

  // 角色卡用 avatar，Persona 用 avatarId，其它资源用 name。
  const idKey = singleData.avatar || singleData.avatarId || singleData.name;
  if (!selected.has(idKey)) return singleData;

  return {
    ...singleData,
    multiSelect: true,
    selectedIds: Array.from(selected),
    count: selected.size,
  };
}
```

**关键点：**
- `selected.size <= 1` 时退化为单项拖拽（返回原始 `singleData`，不带 `multiSelect` 标记）
- `idKey` 取 `avatar || avatarId || name`，保证拖拽项能匹配上选中集合
- 返回对象带 `multiSelect: true` + `selectedIds[]` + `count`

**调用方（所有视图统一模式）：**

```js
row.on("dragstart", (e) => {
  pcDragStart(e, getMultiDragData({ type: "background", name }));
});
row.on("dragend", () => pcDragEnd());
touchDragMgr.bind(row, () => getMultiDragData({ type: "background", name }));
```

对应文件：`ui/views/backgrounds-view.js` (L710-716)、`themes-view.js` (L761-770)、`presets-view.js` (L937-945)、`worldinfo-view.js` (L861-869)、`qr-view.js` (L808-816)、`personas-view.js` (L931-943)、`list-view.js` (L785-797)

### 1.2 多选拖拽 ghost 视觉 — `features/dragdrop/desktop.js` (L14-68)

`pcDragStartCore(e, dragData, deps)`：

```js
// 多选时设置自定义拖拽图像
if (dragData.multiSelect && dragData.count > 1) {
  const ghost = doc.createElement("div");
  ghost.className = "cfm-pc-drag-ghost";
  ghost.textContent = `📦 共 ${dragData.count} 项`;
  ghost.style.cssText =
    "position:fixed;left:-9999px;top:-9999px;padding:6px 16px;border-radius:8px;background:rgba(40,40,40,0.92);color:#fff;font-size:14px;white-space:nowrap;z-index:99999;pointer-events:none;";
  doc.body.appendChild(ghost);
  try {
    dataTransfer?.setDragImage(ghost, 0, 0);
  } catch (error) {
    /* 忽略 */
  }
  // 异步移除幽灵元素
  setTimeout(() => ghost.remove(), 0);
}
```

**关键点：**
- 幽灵元素定位到屏幕外（`left:-9999px;top:-9999px`），仅作为 `setDragImage` 的渲染源
- 样式全部内联，无需额外 CSS
- `setTimeout(() => ghost.remove(), 0)` 异步移除，不阻塞后续操作
- `setDragImage` 包 try/catch 防兼容性异常
- 单项拖拽（无 `multiSelect`）不设 ghost，用浏览器默认半透明拖拽图像

**同函数还负责：**
- 清掉 ST 残留的 `body.dragover` 状态（L24）
- `dataTransfer.setData("text/plain", JSON.stringify(dragData))`（L35）
- `dataTransfer.effectAllowed = "move"`（L37）

### 1.3 拖拽中源元素视觉 — `style.css`

拖拽开始时源行加 `.cfm-dragging` 类，松手后移除：

```js
// themes-view.js (L507-513)
row.on("dragend", () => {
  row.removeClass("cfm-dragging");
  pcDragEnd();
  $(".cfm-row").removeClass(
    "cfm-drop-target cfm-drop-before cfm-drop-after cfm-drop-forbidden",
  );
});
```

CSS：

```css
/* style.css L975-990 */
.cfm-tree-item[draggable="true"] { cursor: grab; }
.cfm-tree-item:active { cursor: grabbing; }
.cfm-dragging { opacity: 0.4; }
.cfm-drag-over { background: rgba(137, 180, 250, 0.15); outline: 1px dashed #89b4fa; }
```

### 1.4 三区域拖放指示（before / after / into）— `ui/tree/tree-view.js` (L260-315) + `style.css`

**判定逻辑**（拖拽悬停到目标时，按相对高度分三区）：

```js
const rect = el.getBoundingClientRect();
const relativeY = (e.clientY - rect.top) / rect.height;
let zone;
if (relativeY < 0.25) zone = "before";   // 顶部 25% → 插入到目标前
else if (relativeY > 0.75) zone = "after"; // 底部 25% → 插入到目标后
else zone = "into";                        // 中间 50% → 移入目标内部
```

**禁用场景**（文件夹拖入自身 / 会成环 → 红色禁止）：

```js
if (data.id === folderId || wouldCreateCycle(data.id, folderId)) {
  el.addClass("cfm-drop-forbidden");
  e.originalEvent.dataTransfer.dropEffect = "none";
  return;
}
```

**CSS 三态指示**（`style.css` L299-316，左栏树节点）：

```css
/* 移入：整体蓝色高亮 + 左边框 */
.cfm-tnode.cfm-drop-target {
  background: rgba(137, 180, 250, 0.25);
  border-left: 2px solid #89b4fa;
}
/* 插入到前：顶部 2px 蓝线 */
.cfm-tnode.cfm-drop-before {
  box-shadow: inset 0 2px 0 0 #89b4fa;
  background: rgba(137, 180, 250, 0.1);
}
/* 插入到后：底部 2px 蓝线 */
.cfm-tnode.cfm-drop-after {
  box-shadow: inset 0 -2px 0 0 #89b4fa;
  background: rgba(137, 180, 250, 0.1);
}
/* 禁止：红色 + 红左边框 */
.cfm-tnode.cfm-drop-forbidden {
  background: rgba(243, 139, 168, 0.15);
  border-left: 2px solid #f38ba8;
}
```

**右栏行版本**（`style.css` L440-458，`.cfm-row`）：

```css
.cfm-row.cfm-drop-target {
  background: rgba(137, 180, 250, 0.2);
  outline: 1px dashed #89b4fa;
}
.cfm-row.cfm-drop-before { box-shadow: inset 0 2px 0 0 #89b4fa; }
.cfm-row.cfm-drop-after  { box-shadow: inset 0 -2px 0 0 #89b4fa; }
.cfm-row.cfm-drop-forbidden {
  background: rgba(243, 139, 168, 0.15);
  outline: 1px dashed #f38ba8;
}
```

### 1.5 拖放落点闪烁反馈 — `features/dragdrop/drop-zones.js`

**样式注入**（L5-28）：`ensureDragLocateHighlightStyleCore` 注入 `#cfm-drag-highlight-style`：

```css
.cfm-drag-highlighted {
  animation: cfmDragHighlightPulse 1s ease-out;
}
@keyframes cfmDragHighlightPulse {
  0%   { box-shadow: 0 0 0 3px rgba(249, 226, 175, 0.9); }
  100% { box-shadow: 0 0 0 3px rgba(249, 226, 175, 0); }
}
```

**闪烁执行**（L107-159）：`flashDraggedElement(selector)` — 重试机制（最多 24 次 × 80ms 间隔等待元素出现），`normalizeElements` 兼容 DOM 元素 / jQuery / 数组 / 字符串选择器，重触发动画用 `void element.offsetWidth`。

### 1.6 拖放目标区整体高亮 — 右栏空白区域

```js
// themes-view.js (L824-833)
rightList.on("dragover", (e) => {
  e.preventDefault();
  e.originalEvent.dataTransfer.dropEffect = "move";
  if ($(e.target).closest(".cfm-row").length > 0) return;
  rightList.addClass("cfm-right-list-drop-target");
});
rightList.on("dragleave", (e) => {
  if ($(e.relatedTarget).closest("#cfm-theme-right-list").length === 0)
    rightList.removeClass("cfm-right-list-drop-target");
});
```

配合 `dragend` 统一清理所有 drop 类（见 1.3）。

### 1.7 清理流程

`pcDragEndCore`（`features/dragdrop/desktop.js` L110 起）：
- 清理 `body.dragover`
- 延迟 120ms 清空全局拖拽数据（避免 drop 处理时拿不到）
- 末尾调用 `flashDraggedElement(highlightSelector)` 做落点闪烁

---

## 二、左栏 UI（收藏 / 文件夹 / 未归类）

### 2.1 三段式结构总览

左栏树 `renderLeftTree`（`ui/tree/tree-view.js` L46-166）：

```
┌─ 收藏（置顶）─────────────┐
│ ⭐ 收藏              [N] │  ← div.cfm-tnode.cfm-tnode-favorites[data-id="__favorites__"]
├─ 文件夹树（递归）─────────┤
│ ▸ 文件夹A            [3] │  ← renderTreeNode 递归
│ ▸ 文件夹B            [0] │
│   ▸ 子文件夹C        [1] │
├─ 未归类（固定底部）───────┤
│ 📦 未归类角色         [N] │  ← div.cfm-tnode.cfm-tnode-uncategorized[data-id="__uncategorized__"]
└──────────────────────────┘
```

### 2.2 收藏入口（置顶）— `ui/tree/tree-view.js` (L51-66)

```js
const favNode = $(
  `<div class="cfm-tnode cfm-tnode-favorites" data-id="__favorites__" data-folder-id="">
    <span class="cfm-tnode-arrow"><i class="fa-solid fa-angle-right"></i></span>
    <span class="cfm-tnode-icon"><i class="fa-solid fa-star" style="color:#f9e2af;"></i></span>
    <span class="cfm-tnode-label">收藏</span>
    <span class="cfm-tnode-count">${getFavoriteCharacters().length}</span>
  </div>`,
);
favNode.on("click", () => {
  setSelectedTreeNode("__favorites__");
  refreshSelection();
  renderRightPane();
});
```

**关键点：**
- 特殊 id `__favorites__` 与真实文件夹 id 区分（真实 id 是 UUID）
- 星形图标 + 金色 `#f9e2af`
- 计数 = `getFavoriteCharacters().length`（实时从收藏数组算）
- 点击 → 设置选中节点 → 刷新选中态 → 重渲染右栏（显示收藏视图）

**CSS**（`style.css` L2064-2068）：

```css
.cfm-tnode.cfm-tnode-favorites {
  border-top: 1px solid rgba(128, 128, 128, 0.3);
  margin-top: 2px;
}
```

### 2.3 文件夹树（中间）— `ui/tree/tree-view.js` (L68-72, L168-408)

```js
sortFolders(getTopLevelFolders()).forEach((folder) => renderTreeNode(folder, tree));
```

`renderTreeNode` 节点结构（L176-185）：

```html
<div class="cfm-tnode" data-id="UUID" draggable="true">
  <span class="cfm-tnode-arrow"><i class="fa-solid fa-angle-right"></i></span>   <!-- 展开/收起 -->
  <span class="cfm-tnode-icon"><i class="fa-solid fa-folder"></i></span>          <!-- 文件夹图标 -->
  <span class="cfm-tnode-label">名称</span>
  <span class="cfm-tnode-target"><i class="fa-solid fa-crosshairs"></i></span>    <!-- 靶子：移入此文件夹 -->
  <span class="cfm-tnode-rename"><i class="fa-solid fa-pen"></i></span>           <!-- 重命名 -->
  <span class="cfm-tnode-count">N</span>                                          <!-- 计数 -->
</div>
```

交互：
- 靶子点击（L197-212）→ `handleFolderTargetMove`（多选模式批量移动）
- 箭头点击（L215-223）→ 展开/收起子文件夹
- 节点点击（L226-237）→ 选中并渲染右栏
- 拖拽悬停（L260-315）→ 三区域判定（见 1.4）
- drop（L321-394）→ 文件夹嵌套/排序 + 角色批量移动（`data.multiSelect && data.selectedIds`）

### 2.4 未归类入口（固定底部）— `ui/tree/tree-view.js` (L74-158)

```js
const uncatNode = $(
  `<div class="cfm-tnode cfm-tnode-uncategorized" data-id="__uncategorized__">
    <span class="cfm-tnode-arrow"><i class="fa-solid fa-angle-right"></i></span>
    <span class="cfm-tnode-icon"><i class="fa-solid fa-box-open"></i></span>
    <span class="cfm-tnode-label">未归类角色</span>
    <span class="cfm-tnode-count">${getUncategorizedCharacters().length}</span>
  </div>`,
);
// 支持 dragover/drop：把角色移出所有文件夹
uncatNode.on("dragover", (e) => {
  e.preventDefault();
  e.originalEvent.dataTransfer.dropEffect = "move";
  uncatNode.addClass("cfm-drop-target");
});
uncatNode.on("drop", (e) => {
  e.preventDefault();
  const data = pcGetDropData(e);
  // 批量：data.multiSelect ? data.selectedIds : [data.avatar]
  // 单次：moveCharactersToFolder(null, avatars)
  uncatNode.removeClass("cfm-drop-target");
});
```

**关键点：**
- 特殊 id `__uncategorized__`（资源视图用 `__ungrouped__`）
- 图标 `fa-box-open`，颜色灰色 `#a6adc8`（`style.css` L240-297 附近）
- 计数 = `getUncategorizedCharacters().length`（所有不在任何文件夹的角色）
- 核心能力：**作为拖放目标，把角色移出所有文件夹**（`moveCharactersToFolder(null, ...)`）

### 2.5 资源视图左栏（presets/themes/worldinfo/personas/regex/qr/backgrounds 通用模式）

每个资源视图都有相同三段式，仅 id 与数据源不同（已确认 `backgrounds-view.js`）：

| 资源 | 左树容器 | 收藏节点 id | 未归类节点 id |
|---|---|---|---|
| 角色 | `#cfm-left-tree` | `__favorites__` | `__uncategorized__` |
| 预设 | `#cfm-preset-left-tree` | `__favorites__` | `__ungrouped__` |
| 主题 | `#cfm-theme-left-tree` | `__favorites__` | `__ungrouped__` |
| 世界观 | `#cfm-worldinfo-left-tree` | `__favorites__` | `__ungrouped__` |
| 背景 | `#cfm-bg-left-tree` | `__favorites__` | `__ungrouped__` |
| 人设 | `#cfm-persona-left-tree` | `__favorites__` | `__ungrouped__` |
| 正则 | `#cfm-regex-left-tree` | `__favorites__` | `__ungrouped__` |
| 快捷回复 | `#cfm-qr-left-tree` | `__favorites__` | `__ungrouped__` |
| 聊天记录 | `#cfm-chatlogs-left-tree` | 无收藏星标 | `__ungrouped__` |

> 注：聊天记录视图（`ui/views/chatlogs-view.js`）左栏是「角色头部 + 聊天文件夹树 + 未归类」，没有收藏星标（收藏仅用于角色/资源）。未归类节点（L209-257）点击靶子执行 `moveCLToFolder(null)` 移出所有文件夹。

**左栏双栏骨架**（`ui/modal/shell.js` L202-215 附近）：

```html
<div class="cfm-dual-pane">
  <div class="cfm-left-pane">
    <div class="cfm-left-header">  <!-- 标题 + 新建按钮 + 排序按钮 -->
      <span>文件夹</span>
      <button class="cfm-btn cfm-btn-sm cfm-new-folder"><i class="fa-solid fa-plus"></i> 新建</button>
    </div>
    <div class="cfm-left-tree" id="cfm-left-tree"></div>  <!-- 树渲染容器 -->
  </div>
  <div class="cfm-right-pane">
    <div class="cfm-right-list" id="cfm-right-list"></div>
  </div>
</div>
```

---

## 三、右栏收藏及收藏实现

### 3.1 收藏存储模型

**角色收藏**（数组存 avatar 名称）：

```js
settings[extensionName].favorites  // string[]：角色 avatar 名列表
```

**资源收藏**（按资源类型分数组存名称，`features/favorites/favorites.js` L3-11）：

```js
const RESOURCE_FAVORITE_KEYS = {
  presets:     "presetFavorites",
  worldinfo:   "worldInfoFavorites",
  themes:      "themeFavorites",
  backgrounds: "bgFavorites",
  personas:    "personaFavorites",
  regex:       "regexFavorites",
  quickreply:  "qrFavorites",
};
```

### 3.2 收藏核心函数 — `features/favorites/favorites.js`（全文件 66 行）

```js
// L25-36：角色收藏切换，返回是否"现在是已收藏"
export function toggleFavoriteCore(avatar, deps) {
  const favs = deps.getFavorites();          // 读 settings 里的 favorites 数组
  const idx = favs.indexOf(avatar);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.push(avatar);
  deps.saveFavorites(favs);                  // 写回 settings + saveSettingsDebounced()
  return idx < 0;
}

// L38-41：收藏角色列表
export function getFavoriteCharactersCore(deps) {
  return deps.getCharacters().filter((c) => deps.getFavorites().includes(c.avatar));
}

// L43-48：补齐每种资源收藏数组（防 undefined）
export function ensureResFavoritesCore(deps) { ... }

// L59-65：资源收藏切换，返回是否"现在是已收藏"
export function toggleResFavoriteCore(type, name, deps) {
  const key = RESOURCE_FAVORITE_KEYS[type];
  const favs = deps.getResFavorites(type);
  const idx = favs.indexOf(name);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.push(name);
  deps.saveResFavorites(key, favs);
  return idx < 0;
}
```

**关键点：**
- 切换函数返回 `idx < 0`（布尔值：操作后是否为已收藏），调用方据此直接更新 DOM，无需再查一次
- 保存用 `saveSettingsDebounced()`（防抖），不阻塞 UI

### 3.3 右栏行内星标 — `ui/list/list-view.js` (L585-612)

```html
<div class="cfm-row-star ${fav ? "cfm-star-active" : ""}" title="${fav ? "取消收藏" : "添加收藏"}">
  <i class="fa-${fav ? "solid" : "regular"} fa-star"></i>
</div>
```

```js
bindTouchSafeTap(starEl, () => {
  const nowFav = toggleFavorite(char.avatar);
  starEl.toggleClass("cfm-star-active", nowFav);
  starEl.attr("title", nowFav ? "取消收藏" : "添加收藏");
  starEl.find("i").attr("class", `fa-${nowFav ? "solid" : "regular"} fa-star`);
  // 同步左栏收藏计数
  $(".cfm-tnode-favorites .cfm-tnode-count").text(getFavoriteCharacters().length);
  // 若当前就在收藏视图，整体重渲染
  if (state.selectedFolder === "__favorites__") renderRightPane();
});
```

**关键点：**
- 图标用 FontAwesome 实心/空心切换：`fa-solid fa-star` ↔ `fa-regular fa-star`
- 三处同步：星标自身 class + title + 图标；左栏计数；收藏视图重渲染
- `bindTouchSafeTap` 是 CFM 自写的触摸安全点击绑定（防移动端双击缩放误触）

**资源星标**（`ui/views/backgrounds-view.js` L642-663，代表所有资源视图）：

```js
const nowFav = toggleResFavorite("backgrounds", name);
// ...同上三处同步，计数选择器改为：
$("#cfm-bg-left-tree .cfm-tnode-favorites .cfm-tnode-count").text(
  bgNames.filter((nn) => getResFavorites("backgrounds").includes(nn)).length,
);
if (state.selectedBgFolder === "__favorites__") renderBackgroundsView();
```

### 3.4 收藏视图渲染（右栏筛选）— `ui/list/list-view.js` (L162-209)

```js
if (selectedId === "__favorites__") {
  pathEl.text("⭐ 收藏");                        // 顶部路径标题
  const favChars = filterHiddenChars(getFavoriteCharacters());  // 数据源换成收藏列表
  if (favChars.length === 0) {
    rightList.html('还没有收藏任何角色<br>点击角色行右侧的 ☆ 按钮添加收藏');  // 空状态提示
    return;
  }
  // 渲染行 + 工具栏（删除/导出/编辑/多选），与普通文件夹一致
}
```

**资源收藏视图**（`ui/views/backgrounds-view.js` L403-406）：

```js
displayItems = bgNames.filter((n) => favs.includes(n));   // 数据源筛选
displayTitle = "⭐ 收藏";                                  // 标题
```

**关键点：**
- 收藏视图 = **普通视图 + 数据源过滤**，渲染函数复用同一套（行渲染、工具栏、拖拽逻辑全不变）
- 空状态给引导文案（告诉用户怎么添加收藏）
- 判断当前视图是否收藏视图用 `state.selectedFolder === "__favorites__"`（资源用 `state.selectedBgFolder` 等）

### 3.5 收藏星标 CSS — `style.css`

```css
/* L1367-1388：星标按钮 */
.cfm-row-star {
  color: rgba(255, 255, 255, 0.2);           /* 未收藏：浅灰 */
  cursor: pointer;
  transition: color 0.2s, transform 0.2s;
}
.cfm-row-star:hover {
  color: #f9e2af;                             /* 悬停：金色 */
  transform: scale(1.2);
}
.cfm-row-star.cfm-star-active {
  color: #f9e2af;                             /* 已收藏：金色 */
}
.cfm-row-star.cfm-star-active:hover {
  color: #fab387;                             /* 已收藏悬停：橙色（暗示可取消） */
}

/* L2338-2352（移动端）：放大触摸区域、禁用 hover 残留 */
@media (max-width: 768px) {
  .cfm-row-star { font-size: 18px; padding: 4px 8px; }
}
```

---

## 四、可复用清单（直接照抄）

### 纯函数（无 DOM 依赖，可直接拷）

| 函数 | 文件 | 行 | 作用 |
|---|---|---|---|
| `getMultiDragDataCore` | `features/selection/mode.js` | L101-115 | 构造多选拖拽数据 |
| `toggleFavoriteCore` | `features/favorites/favorites.js` | L25-36 | 角色收藏切换 |
| `getFavoriteCharactersCore` | 同上 | L38-41 | 收藏角色列表 |
| `toggleResFavoriteCore` | 同上 | L59-65 | 资源收藏切换 |
| `RESOURCE_FAVORITE_KEYS` | 同上 | L3-11 | 资源→收藏字段映射 |

### 视觉片段（HTML + CSS 直接搬）

| 内容 | 位置 | 说明 |
|---|---|---|
| 多选 ghost `📦 共 N 项` | `features/dragdrop/desktop.js` L46-67 | setDragImage 自定义拖拽图像 |
| 三区域判定 `relativeY` | `ui/tree/tree-view.js` L260-315 | before/after/into 三分 |
| 三态 CSS（蓝/紫 inset 线） | `style.css` L299-316、L440-458 | drop-before/after/target/forbidden |
| 落点脉冲闪烁 | `features/dragdrop/drop-zones.js` + `style.css` | 金色 1s 脉动 |
| 星标 CSS | `style.css` L1367-1388 | 灰→金 hover 放大 |
| 收藏入口置顶 CSS | `style.css` L2064-2068 | 分割线 |
| 拖拽源半透明 | `style.css` L975-990 | `.cfm-dragging { opacity: 0.4 }` |

### 通用模式（结构照抄）

1. **三区块左栏树**：收藏置顶（星标+计数）→ 文件夹递归树 → 未归类固定底部（box-open 图标+计数+移入靶子）
2. **收藏视图 = 数据源过滤**：`displayItems = all.filter(n => favs.includes(n))` + `⭐ 收藏` 标题 + 空状态引导
3. **星标三处同步**：自身 class/图标/title → 左栏计数 → 收藏视图重渲染
4. **多选拖拽链路**：`getMultiDragData(singleData)` → `pcDragStart(e, dragData)`（ghost 视觉）→ drop 时读 `data.multiSelect ? data.selectedIds : [data.avatar]` → `pcDragEnd()` 清理 + 闪烁

---

## 五、小说阅读器落地建议

### 5.1 拖拽视觉直接移植

小说阅读器（书架/章节列表）的拖拽视觉不需要任何酒馆原生 API：

- **书架项拖拽**：照抄 `pcDragStartCore` 的 ghost 逻辑（`📦 共 N 项`），data 结构 `{ type: "book", id, multiSelect?, selectedIds?, count? }`
- **文件夹拖拽**：照抄三区域判定 + 三态 CSS，禁止判定用 `wouldCreateCycle` 思路（自己写 id 环检测）
- **落点反馈**：照抄 `flashDraggedElement`（注入 keyframes + 重试等待元素）

### 5.2 左栏三段式照抄

- 收藏入口：`data-id="__favorites__"` + 星标 + 计数，点击切到收藏视图
- 未归类入口：`data-id="__uncategorized__"` + 计数，作为移出文件夹的 drop 目标（`moveToFolder(null)`）
- 收藏/未归类都是**伪节点**（特殊 id），不落真实文件夹数据，纯视图层概念

### 5.3 收藏实现直接照抄

小说阅读器把「书签/收藏」映射到同一套模式：

```js
// 存储：settings[extensionName].favorites 已是成熟方案（含防抖保存）
const nowFav = toggleFavoriteCore(bookId, deps);   // 返回布尔
```

- 星标交互、三处同步、收藏视图过滤、空状态提示，全部照抄
- 注意 CFM 的收藏存的是**名称/avatar**，若小说阅读器需要按章节收藏，存「书 id + 章节 id」的对象数组即可，切换逻辑同理

### 5.4 聊天记录视图的参考价值

`ui/views/chatlogs-view.js` 的结构（角色头部 + 聊天文件夹树 + 未归类 + 右栏聊天行）与小说阅读器的「角色 → 聊天」两级浏览**高度相似**，且聊天行已实现：
- 当前聊天高亮 `cfm-chatlog-current`（仅当前角色 + `getCurrentChatId()` 匹配）
- 聊天行 dragstart 多选识别（L438-455）：`collectCurrentSelection()` 若含当前项且 size > 1 → `multiSelect: true`

> 这是小说阅读器最值得先读的文件，因为它的数据模型（角色 + 聊天文件列表）与「小说（角色）+ 章节（聊天）」几乎一一对应。

---

## 附：本文档涉及文件清单

| 文件 | 关键位置 |
|---|---|
| `features/dragdrop/desktop.js` | L14-68 ghost 视觉、L110+ dragend 清理 |
| `features/dragdrop/drop-zones.js` | L5-28 样式注入、L107-159 闪烁 |
| `features/selection/mode.js` | L101-115 多选拖拽数据 |
| `features/favorites/favorites.js` | 全文件 66 行收藏核心 |
| `ui/tree/tree-view.js` | L46-166 左栏三段式、L260-315 三区域、L321-394 drop |
| `ui/list/list-view.js` | L162-209 收藏视图、L585-612 星标 |
| `ui/views/backgrounds-view.js` | L403-406 收藏筛选、L642-663 资源星标、L710-716 拖拽绑定 |
| `ui/views/chatlogs-view.js` | L100-257 左栏、L392-461 右栏与多选拖拽 |
| `ui/modal/shell.js` | L202-215 双栏骨架 |
| `style.css` | L299-316/L440-458 三态、L975-990 拖拽源、L1367-1388 星标、L2064-2068 收藏入口 |

