# 小说阅读器：单条聊天删除 / 重命名 / 操作后同步 实施计划

> 需求：在插件内部直接重命名 / 删除聊天记录。
> 参考文档：`NOVEL-READER-CHAT-DELETE-RENAME-SYNC.md`（基于 CFM 的最小化实现）。
> 本文档为可执行蓝图，供 Code 模式按步骤实施。

## 0. 目标与原则

1. **功能层保持纯净**：删除/重命名函数只做「执行 + 清理/迁移关联元数据 + 失效缓存 + 返回 true/false」，**不负责重绘 UI**；重绘由调用方（UI 事件处理器）成功后触发。与参考文档第 7.1 条一致。
2. **双保险调用**：优先 ST 原生函数（`deleteCharacterChatByName` / `renameGroupOrCharacterChat`），异常或缺失时回退 HTTP API。每步失败有 `console.warn` + `toastr` 提示。
3. **key 归一化**：内部元数据（书签/进度）统一用**带 `.jsonl` 的完整文件名**作为 key（沿用现有 `avatar::fileName` 约定）；仅在与 ST 原生接口 / HTTP API 边界处去除 `.jsonl`。
4. **删除当前阅读聊天 → 跳转兜底**：删除前捕获当前聊天标识，删到当前项则重拉列表并回聊天列表页（不调用 ST `doNewChat`，避免干扰 ST 主界面当前聊天，见 §6 说明）。

## 1. ST 集成层扩展

文件：[`integrations/sillytavern.js`](integrations/sillytavern.js:35)（沿用现有 `_scriptModule` 缓存模式）

新增三个函数访问器（`script.js` 命名导出，模块命名空间上取值 + `window` 兜底）：

| 访问器                             | 返回             | 对应 ST 函数（已确认存在）                                                                                                                                   |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deleteCharacterChatByNameFunc()`  | `Function\|null` | [`deleteCharacterChatByName(characterId, fileName)`](../../../../script.js:1362)（`fileName` **不含** `.jsonl`）                                             |
| `renameGroupOrCharacterChatFunc()` | `Function\|null` | [`renameGroupOrCharacterChat({characterId, groupId, oldFileName, newFileName, loader})`](../../../../script.js:10598)（`old/newFileName` **不含** `.jsonl`） |
| `doNewChatFunc()`                  | `Function\|null` | [`doNewChat({deleteCurrentChat})`](../../../../script.js:10558)                                                                                              |

注意：`deleteCharacterChatByName` 需要一个能定位角色的 `characterId`（即字符索引字符串）。阅读器已知 `charIdx`，直接 `String(charIdx)` 传入即可（ST 内部用 `characters[characterId]`）。

## 2. 新增 features/chatlogs/index.js —— 聊天操作核心

新建 `features/chatlogs/index.js`，导出 `createChatlogsCore(deps)`。**依赖注入 deps**：

- `getStContext` / `getRequestHeaders`（ST 集成层）
- `deleteCharacterChatByNameFunc` / `renameGroupOrCharacterChatFunc` / `doNewChatFunc`（ST 访问器）
- `getCharacters: () => Array`（角色数组，供 `findIndex` 反查索引）
- `invalidateChat(avatar, fileName)` / `refreshCharChats(charIdx, avatar)`（bookshelf 提供，见 §4）
- `bookmarks`（`clearByChat` / `renameKey`）、`progress`（`renameKey`）、`clearByAvatar` 兜底
- `saveSettings`（`saveSettingsDebounced`）

### 2.1 `deleteChatFile(avatar, chatFileName)` → `Promise<boolean>`

```
1. 查角色索引：getCharacters().findIndex(c => c.avatar === avatar)；<0 返回 false
2. fileNameNoExt = chatFileName.replace(/\.jsonl$/i, "")
3. 原生优先：
     const fn = deps.deleteCharacterChatByNameFunc?.()
     if (fn) try { await fn(String(charIdx), fileNameNoExt) } catch → console.warn + 回退 HTTP
     无原生函数 → 直接 fetch POST /api/chats/delete
        body: { chatfile: fileNameNoExt + ".jsonl", avatar_url: avatar }
        headers: getRequestHeaders()；!res.ok 或 json.error → 返回 false + toastr.error
4. 成功后同步清理关联元数据：
     bookmarks.clearByChat(avatar, chatFileName)   // 删除该聊天的全部书签
     progress.clear(avatar, chatFileName)          // 删除该聊天的阅读进度
     deps.saveSettings?.()
5. 缓存失效并立即重拉：await deps.invalidateChat(avatar, chatFileName)
6. toastr.success("已删除聊天")
7. return true
```

### 2.2 `renameChatFile(avatar, oldFileName, newName)` → `Promise<boolean>`

```
1. 查角色索引；<0 返回 false
2. 归一化：newName = String(newName).trim()；oldNoExt = oldFileName 去 .jsonl；newNoExt = newName 去 .jsonl
   若 newNoExt 为空 → toastr.error("名称不能为空")，返回 false
   若 oldNoExt === newNoExt（忽略大小写）→ toastr.warning("新名称与原名相同")，返回 false
3. 原生优先：
     const fn = deps.renameGroupOrCharacterChatFunc?.()
     if (fn) try { await fn({ characterId: String(charIdx), groupId: null,
                             oldFileName: oldNoExt, newFileName: newNoExt, loader: false }) }
     else 回退 ctx.renameChat（见 2.3）
     catch → console.warn + toastr.error + 返回 false
4. 成功后同步迁移关联元数据（key 从 old 完整名 → new 完整名）：
     bookmarks.renameKey(avatar, oldFileName, newFileName)
     progress.renameKey(avatar, oldFileName, newFileName)
     deps.saveSettings?.()
5. 缓存失效：await deps.invalidateChat(avatar, oldFileName)   // 重拉列表，新名生效
6. toastr.success("已重命名")
7. return true
```

### 2.3 回退分支 ctx.renameChat（原生缺失时）

`ctx.renameChat(oldNoExt, newNoExt)` 只能重命名**当前打开**的聊天（内部用 `this_chid`）。当阅读器正在阅读的就是该聊天时，直接调用；否则需先 `openCharacterChatFunc()` 切过去再改名、改完切回（参考 CFM 逻辑）。**由于原生函数在现代 ST 几乎总是存在，回退分支做简化实现**：

- 仅当 `ctx` 当前聊天 id（`ctx.getCurrentChatId?.()`）与 `oldNoExt` 一致时直接 `ctx.renameChat(oldNoExt, newNoExt)`；
- 不一致时：`openCharacterChatFunc()(oldNoExt)` → `await ctx.renameChat(oldNoExt, newNoExt)`（切回原聊天可跳过，阅读器随后会失效缓存并重绘）。

### 2.4 输出

```js
return { deleteChatFile, renameChatFile };
```

## 3. 关联元数据扩展

### 3.1 features/bookmarks/index.js

在现有 [`createBookmarksCore`](features/bookmarks/index.js:21) 返回值中新增：

- `clearByChat(avatar, fileName)`：删除 `avatar::fileName` 整键的书签（若存在），`saveSettings()`。
- `renameKey(avatar, oldFileName, newFileName)`：把 `avatar::oldFileName` 整键搬到 `avatar::newFileName`，删除旧键，`saveSettings()`。

> 现有 `clearByAvatar(avatar)` 已存在，用于删除整个角色的兜底，无需改动。

### 3.2 features/progress/index.js

在现有 [`createProgressCore`](features/progress/index.js:14) 返回值中新增：

- `renameKey(avatar, oldFileName, newFileName)`：迁移 `avatar::oldFileName` 进度到 `avatar::newFileName`，删除旧键，`saveSettings()`。
- `clear(avatar, fileName)` 已存在（删除单聊天进度），删除聊天时直接复用。

## 4. 书架数据层扩展（缓存失效 + 立即重拉）

文件：[`features/bookshelf/index.js`](features/bookshelf/index.js:20)（在 `createBookshelfCore` 内新增）

```js
// 单聊天内容缓存失效（书签/进度迁移后，正文缓存不再命中）
invalidateChat: (avatar, fileName) => {
  contentCache.invalidate(avatar, fileName);   // 只清该聊天的正文缓存
  chatCache.invalidate(avatar);                // 聊天列表缓存一并失效
},
// 失效后立即重拉当前角色聊天列表（供 UI 重绘，避免列表数据缺失）
refreshCharChats: async (charIdx, avatar) => {
  chatCache.invalidate(avatar);
  const list = await getCharChatsCore(deps, charIdx, avatar);
  chatCache.setResolved(avatar, list);          // 见下方说明
  return list;
},
```

**关键补充**：现有 [`createChatCacheCore`](features/bookshelf/cache.js:13) 只暴露 `get/peek/invalidate/clear`，`invalidate` 后下一次 `get` 会重新拉取，但**无法把新列表写回缓存供 `peek` 同步读取**。而 UI 层依赖 `state.currentChats`（独立于缓存）渲染，所以：

- UI 层重绘直接用 `refreshCharChats` 的返回值更新 `state.currentChats`，不必依赖缓存 `peek`。
- 因此在 `cache.js` 的 `createChatCacheCore` 中新增 `setResolved(avatar, list)`：把已解析数组写入缓存条目（若条目存在则更新其 `value`；否则新建一个条目）——供 `refreshCharChats` 使用，保持缓存与 `peek` 一致。

## 5. index.js 组装与 UI 接入

### 5.1 组装 chatlogsCore（在 deps 定义后）

```js
import { createChatlogsCore } from "./features/chatlogs/index.js";
// ...
const chatlogs = createChatlogsCore({
  ...deps,
  getCharacters: () => ctx.characters,
  deleteCharacterChatByNameFunc,
  renameGroupOrCharacterChatFunc,
  doNewChatFunc,
  invalidateChat: (avatar, fileName) => bookshelf.invalidateChat(avatar, fileName),
  refreshCharChats: (charIdx, avatar) => bookshelf.refreshCharChats(charIdx, avatar),
  bookmarks,
  progress,
});
```

> `deleteCharacterChatByNameFunc` 等需先从 `integrations/sillytavern.js` 导入。

### 5.2 聊天卡片行内删除 / 重命名按钮

修改 [`renderChatListGrid`](index.js:710)（聊天卡片网格）。每个卡片：

- 卡片底部追加 `.novel-card-actions` 操作条，含两个小按钮：**重命名**（SVG 铅笔）、**删除**（SVG 垃圾桶）。**图标用 SVG 而非 emoji**（定义见 §6.1）。
- 操作条**始终常显**（不依赖 hover，移动端一致），与现有 `.novel-card-meta` 相邻。
- 点击操作按钮 `e.stopPropagation()`，防止触发卡片 click → `openToc`。
- 卡片 click 仍为 `openToc`（保持现状）。
- **删除流程**：
  1. `createChoiceDialog` 确认弹窗：「删除聊天《xx》？此操作不可恢复。其书签与阅读进度将一并删除。」选项 `取消 / 删除`（删除为主按钮）。
  2. 确认后 `await chatlogs.deleteChatFile(char.avatar, fileName)`。
  3. 成功 → `const list = await bookshelf.refreshCharChats(charIdx, char.avatar)`；`state.currentChats = list`；`renderChatListGrid(searchInputEl.value)`（重绘）。
- **重命名流程**：
  1. `createOverlayDialog`（compact）弹窗，内含输入框（预填旧名去 `.jsonl`）+「取消 / 确定」。
  2. 确定后 `await chatlogs.renameChatFile(char.avatar, fileName, newName)`。
  3. 成功 → 同删除：刷新列表 + 重绘。

### 5.2.1 新增 SVG 图标常量（非 emoji）

在 [`index.js`](index.js:75) 的 `BOOKMARK_SVG` / `PIN_SVG` 旁新增（沿用同样的描边风格）：

```js
// 重命名图标（铅笔，描边风格，与收藏一致）
const RENAME_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
// 删除图标（垃圾桶，描边风格）
const DELETE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';
```

> 卡片操作条、目录页按钮、阅读页按钮统一复用这两个图标，保持视觉一致。

### 5.3 目录页 / 阅读页顶部「删除 / 重命名」按钮（针对当前阅读聊天）

两个入口均**受设置页开关控制**（默认不显示，见 §5.6），按钮用 `RENAME_SVG` / `DELETE_SVG` 图标：

- **目录页**（[`renderTocPage`](index.js:796) 的 `.novel-toc-head`）：在「收藏」按钮（[`index.js:814`](index.js:814)）**旁边**追加「删除」与「重命名」两个图标按钮（`data-action="chat-delete"` / `data-action="chat-rename"`），作用于 `state.currentChat` / `state.currentChar`。
- **阅读页**（[`features/reader/index.js:116`](features/reader/index.js:116) 渲染的 `.novel-chapter-subtitle` 行，即「第N章」标题）：在标题右侧追加「删除」「重命名」图标按钮，**尺寸比「第N章」标题小**（字体与按钮均小于章标题，视觉上不抢标题）。
  - 注意：正文页由 `reader.renderChapter` 渲染，而按钮事件需要 `state` 与 `chatlogs` —— 渲染后通过回调（`onRendered`）或 `querySelector` 事件委托绑定。
- 两个入口的删除 / 重命名流程与 5.2 完全一致（复用同一组处理函数）。
- **删除当前阅读聊天后的跳转**：
  1. 删除成功后，若 `state.page === "toc" || state.page === "reader"` 且删除的正是 `state.currentChat.file_name` → `refreshCharChats` 重拉 → `state.currentChats = list` → `setPage("chats")` 并 `renderChatListGrid("")`；`state.currentChar` 保留。
  2. `reader.abort()` 防止残留渲染；toastr 提示「已删除聊天，返回聊天列表」。
- **重命名当前阅读聊天后**：顶栏标题、目录/正文页的聊天名需同步更新 —— 重拉列表后 `state.currentChat.file_name = newName`（或直接重新 `openToc` 加载新名），并 `reader.loadChat({avatar, fileName: newName})` 重建 reader 缓存。

> **说明（与参考文档 2.2 的差异）**：CFM 删除当前聊天后调用 `doNewChat` 新建聊天，因为它操作的是 ST 主界面当前打开的聊天。而小说阅读器是**独立的全屏阅读界面**，删除后直接回到该角色的聊天列表页更符合阅读器语境，且不干扰 ST 主界面当前聊天状态，故不调用 `doNewChatFunc`。（`doNewChatFunc` 访问器仍实现，供未来需要时使用。）

### 5.3.1 设置页开关：目录页 / 阅读页操作按钮显示控制

设置页（[`index.js:1315`](index.js:1315) 附近的 `.novel-settings-row` 区块）新增两个 `novel-switch` 开关，**默认不勾选**，持久化到 `extension_settings[EXT_NAME]`：

| 设置字段                  | 默认  | 说明                                       |
| ------------------------- | ----- | ------------------------------------------ |
| `g.showTocChatActions`    | false | 目录页顶部是否显示删除 / 重命名按钮        |
| `g.showReaderChatActions` | false | 阅读页「第N章」旁是否显示删除 / 重命名按钮 |

- 在 `getGlobalSettings()`（[`index.js:180`](index.js:180)）中补默认值：`if (g.showTocChatActions === undefined) g.showTocChatActions = false;`（同理 `showReaderChatActions`）。
- 渲染目录页 / 阅读页时，根据开关决定是否插入按钮（关闭时不生成 DOM，保持页面干净）。
- 保存逻辑沿用现有设置页 checkbox 的 `change` → `saveSettingsDebounced` 模式（见 [`index.js:1549`](index.js:1549) 附近的自动识别标题开关处理）。
- **注意**：卡片行内操作条**不受此开关控制**（始终显示，见 §5.2）。

### 5.4 事件订阅补充（被动同步）

在 [`subscribeEvents`](index.js:2279) 中追加：

- `events.on(types.CHAT_DELETED, ...)`：延迟 300ms 后清缓存（`bookshelf.clearCache()` + 该角色 `invalidateChat`）；若阅读器弹窗打开且在 chats/toc/reader 页，重拉当前角色列表并重绘（聊天可能被 ST 主界面删除）。
- `events.on(types.CHAT_RENAMED, ...)`：同样延迟清缓存；若当前角色受影响，刷新列表重绘。

> 需要判断 `types.CHAT_DELETED` / `types.CHAT_RENAMED` 是否存在（老版本 ST 可能没有），不存在则跳过监听。

### 5.5 全局 API

`window.NovelReader` 追加 `chatlogs`（暴露 `deleteChatFile` / `renameChatFile`）。

## 6. 弹窗与确认（复用现有基建）

- **确认弹窗**：直接用 [`createChoiceDialog`](ui/modal/index.js:301)，无需新代码。
- **重命名输入弹窗**：用 [`createOverlayDialog`](ui/modal/index.js:71)（`compact: true`）手动拼输入框 + 按钮行。Enter 键提交，Escape 关闭。
- 新弹窗属于小尺寸，复用现有 `.novel-dialog-compact` / `.novel-btn` 样式，不需要新 CSS（除操作按钮样式外）。

## 7. style.css 新增样式

在卡片网格样式区块（[`style.css`](style.css:250) 附近）追加：

```css
/* ---- 聊天卡片行内操作条（重命名 / 删除）—— 始终常显，SVG 图标 ---- */
.novel-card-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.novel-card-actions .novel-card-act-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 6px;
  font-size: 0.78rem;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--novel-fg, var(--SmartThemeBodyColor, #ddd)) 20%, transparent);
  background: transparent;
  color: var(--novel-fg, var(--SmartThemeBodyColor, #ddd));
  cursor: pointer;
}
.novel-card-actions .novel-card-act-btn svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.novel-card-actions .novel-card-act-btn:hover {
  border-color: var(--SmartThemeMainColor, #4f8cff);
  color: var(--SmartThemeMainColor, #4f8cff);
}
.novel-card-actions .novel-card-act-btn.danger:hover {
  border-color: #e5484d;
  color: #e5484d;
}

/* ---- 目录页头部操作按钮（收藏旁；受设置开关控制，默认不渲染） ---- */
.novel-toc-chat-actions {
  display: inline-flex;
  gap: 4px;
  margin-left: auto; /* 与收藏按钮保持在同一行右端 */
}
.novel-toc-chat-actions .novel-toc-act-btn,
.novel-chapter-chat-actions .novel-chapter-act-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--novel-fg, var(--SmartThemeBodyColor, #ddd)) 20%, transparent);
  background: transparent;
  color: var(--novel-fg, var(--SmartThemeBodyColor, #ddd));
  cursor: pointer;
}
.novel-toc-chat-actions .novel-toc-act-btn svg,
.novel-chapter-chat-actions .novel-chapter-act-btn svg {
  width: 15px;
  height: 15px;
}
.novel-toc-chat-actions .novel-toc-act-btn:hover,
.novel-chapter-chat-actions .novel-chapter-act-btn:hover {
  border-color: var(--SmartThemeMainColor, #4f8cff);
  color: var(--SmartThemeMainColor, #4f8cff);
}
.novel-toc-chat-actions .novel-toc-act-btn.danger:hover,
.novel-chapter-chat-actions .novel-chapter-act-btn.danger:hover {
  border-color: #e5484d;
  color: #e5484d;
}

/* ---- 阅读页「第N章」旁操作按钮（尺寸小于章标题） ---- */
.novel-chapter-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.novel-chapter-head .novel-chapter-subtitle {
  flex: 1; /* 标题占主位 */
}
.novel-chapter-chat-actions {
  display: inline-flex;
  gap: 4px;
}
/* 按钮小于章标题：章标题约 1.1rem，按钮 0.8rem */
.novel-chapter-chat-actions .novel-chapter-act-btn {
  width: 24px;
  height: 24px;
}
.novel-chapter-chat-actions .novel-chapter-act-btn svg {
  width: 13px;
  height: 13px;
}
```

## 8. 需要改动 / 新增的文件清单

| 文件                               | 操作 | 内容                                                                                                       |
| ---------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| `features/chatlogs/index.js`       | 新增 | `createChatlogsCore`：`deleteChatFile` / `renameChatFile`                                                  |
| `integrations/sillytavern.js`      | 修改 | 新增 3 个函数访问器（delete / rename / doNewChat）                                                         |
| `features/bookmarks/index.js`      | 修改 | 新增 `clearByChat` / `renameKey`                                                                           |
| `features/progress/index.js`       | 修改 | 新增 `renameKey`                                                                                           |
| `features/bookshelf/cache.js`      | 修改 | 新增 `setResolved(avatar, list)`                                                                           |
| `features/bookshelf/index.js`      | 修改 | 新增 `invalidateChat` / `refreshCharChats`                                                                 |
| `index.js`                         | 修改 | 组装 chatlogsCore、`RENAME_SVG`/`DELETE_SVG` 常量、卡片操作条、目录/阅读页按钮、设置项、事件订阅、全局 API |
| `features/reader/index.js`         | 修改 | 阅读页「第N章」行渲染操作按钮（受 `showReaderChatActions` 开关控制）                                       |
| `style.css`                        | 修改 | 卡片操作条（常显+SVG）、目录页按钮、阅读页按钮样式                                                         |
| `plans/chat-delete-rename-sync.md` | 修改 | 本文档（实施蓝图）                                                                                         |

## 9. 实施顺序（Code 模式执行）

1. **底层先做**：`sillytavern.js` 访问器 → `bookmarks/progress` 元数据方法 → `bookshelf/cache.js` 的 `setResolved` → `bookshelf/index.js` 的 `invalidateChat` / `refreshCharChats`。
2. **核心功能**：新建 `features/chatlogs/index.js`（`createChatlogsCore`，功能层纯净，不触碰 UI）。
3. **图标常量**：在 `index.js` 顶部新增 `RENAME_SVG` / `DELETE_SVG`（§5.2.1）。
4. **设置项**：`getGlobalSettings` 补 `showTocChatActions` / `showReaderChatActions` 默认值；设置页新增两个开关。
5. **组装**：`index.js` 导入并创建 `chatlogsCore`。
6. **UI**：聊天卡片操作条（常显 + SVG）→ 目录页收藏旁按钮 → 阅读页「第N章」旁按钮 → 删除当前聊天跳转 / 重命名当前聊天刷新。
7. **样式**：`style.css` 操作条 / 目录页按钮 / 阅读页按钮样式（§7）。
8. **事件**：`subscribeEvents` 补 `CHAT_DELETED` / `CHAT_RENAMED`。
9. **收尾**：全局 API + README 更新。

## 10. 验收标准

- [x] 聊天列表卡片可重命名（行内按钮 → 输入弹窗 → 列表新名生效，书签/进度 key 迁移）。
- [x] 聊天列表卡片可删除（确认弹窗 → 删除成功 → 列表移除该聊天，书签/进度清除）。
- [x] 卡片操作条**始终常显**，图标为 **SVG 铅笔 / 垃圾桶**（非 emoji），点击不触发打开聊天。
- [x] 目录页「收藏」按钮旁显示删除 / 重命名按钮（针对当前阅读聊天），可操作成功；关闭开关后按钮消失。
- [x] 阅读页「第N章」标题旁显示删除 / 重命名按钮（尺寸小于章标题），可操作成功；关闭开关后按钮消失。
- [x] 删除当前阅读聊天后自动回到聊天列表页，`reader.abort()` 无残留渲染，toastr 提示。
- [x] 重命名当前阅读聊天后顶栏标题、目录/正文页聊天名同步更新，reader 缓存重建。
- [x] ST 主界面删除 / 重命名聊天后，阅读器弹窗打开时列表自动同步（事件被动刷新）。
- [x] 无 ST 原生函数时回退 HTTP API 仍可用；失败有 toastr 提示。

## 11. 关键风险与对策

| 风险                                                              | 对策                                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `deleteCharacterChatByName` 的 `characterId` 语义（可能不是索引） | 已核对源码：`characters[characterId]` 数组下标，传 `String(charIdx)` 正确；失败时回退 HTTP API                    |
| `ctx.renameChat` 只能重命名当前打开聊天                           | 回退分支仅在当前聊天一致时直接调用；不一致时先 `openCharacterChat` 切过去（原生函数存在时走原生，此分支极少触发） |
| 缓存 `peek` 拿不到重拉结果                                        | 新增 `setResolved` 写回缓存；UI 直接使用 `refreshCharChats` 返回值更新 `state.currentChats`                       |
| 老版本 ST 无 `CHAT_DELETED` / `CHAT_RENAMED` 事件类型             | 监听前先判断 `types.X` 是否存在，不存在则跳过                                                                     |
| 删除当前阅读聊天后残留正文渲染                                    | 删除后调用 `reader.abort()` 并 `setPage("chats")` 重绘                                                            |

## 12. 实施完成记录

> 实际实施与蓝图的主要差异记录（2026-09）。

1. **`CHAT_DELETED` / `CHAT_RENAMED` payload 语义已核实**（[`script.js`](../../../../public/script.js:10598) / [`script.js`](../../../../public/script.js:1362)）：
   - `CHAT_DELETED`：emit 参数为**不带 `.jsonl` 的文件名**（无 avatar 信息，ST 设计限制）→ 事件处理中仅能做「当前阅读聊天是否被删」判断（匹配文件名），删除其它角色聊天时只失效缓存；无法做书签/进度清理。
   - `CHAT_RENAMED`：emit 参数为 `{ avatarId /* avatar 文件名 */, groupId, oldFileName /* 带 .jsonl */, newFileName /* 带 .jsonl */ }` → 可精确迁移书签/进度 key（幂等，本插件自身操作触发时无副作用）。
2. **事件监听不设 300ms 延迟**：`CHAT_DELETED` / `CHAT_RENAMED` 由 ST 原生 `deleteCharacterChatByName` / `renameGroupOrCharacterChat` 在 API 调用完成后 emit，数据已落盘，无需延迟；`CHAT_CHANGED` / `CHARACTER_RENAMED` 保持原有 300ms。
3. **`refreshCharChats` 参数顺序**：实际签名为 `refreshCharChats(charIdx, avatar)`（`charIdx` 在前）。事件处理器中 `state.currentCharIdx` 始终与 `state.currentChar.avatar` 对应，可直接使用。
4. **`renameChatFile` 成功后 ST 会 emit `CHAT_RENAMED`**：本插件自己的重命名操作会同时触发被动事件分支。已保证幂等（书签/进度迁移重复执行无副作用；当前聊天重命名分支判断 `file_name === 旧名` 在 `doRenameChat` 已提前更新为**新名**，不会二次重载）。
5. **`deleteChatFile` 成功后 ST 会 emit `CHAT_DELETED`**：同样幂等（当前聊天分支在 `doDeleteChat` 已清空 `state.currentChat`，事件分支不会重复跳转）。
6. **全局 API**：`window.NovelReader.chatlogs` 已暴露 `{ deleteChatFile, renameChatFile }`。
7. **设置项**：`showTocChatActions` / `showReaderChatActions` 默认 `false`，仅控制目录页 / 阅读页按钮；聊天卡片行内操作条始终常显不受开关影响。
