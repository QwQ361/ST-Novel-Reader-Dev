# 功能规划：新楼层生成结束/被截断 → 红点闪烁通知

## 1. 背景与目标

用户全屏使用小说阅读器时，酒馆（SillyTavern）在后台生成新楼层（角色回复）或生成被截断时，用户往往注意不到。

**目标**：当酒馆任意聊天生成结束或被截断时，若阅读器弹窗处于打开状态，显示**顶栏红点闪烁 + 屏幕角落气泡**通知，提醒用户"有新内容生成了"。点击气泡即关闭阅读器弹窗（等同右上角关闭按钮），让用户回到酒馆查看新内容；**不做"查看最新章"跳转**。

## 2. 已确认的需求决策

| 决策点   | 结论                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------- |
| 通知形式 | 顶栏红点闪烁 + 屏幕角落气泡（气泡可点击/关闭）                                                     |
| 触发范围 | **不做当前阅读聊天区分**——酒馆任何聊天生成结束都通知                                               |
| 截断判定 | **不区分正常/截断**——`GENERATION_ENDED` 或 `GENERATION_STOPPED` 都统一触发红点闪烁                 |
| 打开时   | 仅当阅读器弹窗打开（`dialogRef` 存在）时通知；阅读器关闭时不打扰                                   |
| 气泡交互 | 点击气泡 = **关闭阅读器弹窗**（等同右上角关闭按钮，`closeReaderDialog`）；**不做"查看最新章"跳转** |
| 静默期   | 生成结束后若用户重新打开/查看，红点应能清除                                                        |

## 3. 技术可行性（已调研确认）

- **ST 事件**（`window.SillyTavern.getContext().eventSource` / `eventTypes`）：
  - `GENERATION_STARTED` `(type, options, dryRun)` — 每次生成开始；`dryRun` 为 true 表示提示词查看器预览，**应忽略**
  - `GENERATION_ENDED` `(chatLength)` — 在 `hideStopButton()` 中触发，表示 UI 生成状态结束（正常流式结束 / 出错 / 停止之后）
  - `GENERATION_STOPPED` — 在 `stopGeneration()`（用户点击停止）中触发
  - `MESSAGE_RECEIVED` `(mesId)` — 单条消息完成写入时触发
- **弹窗结构**（`ui/modal/index.js` 的 `createOverlayDialog`）：
  - `.novel-overlay`（z-index 100010）→ `.novel-dialog` → `.novel-shell` → `.novel-topbar`
  - 顶栏 `topbarEl` 已由 `openReaderDialog()` 创建，可在 `.novel-topbar-settings` 区域追加红点
- **数据刷新链路**：阅读器通过 `POST /api/chats/get` + 缓存读取（`bookshelf.getChatMessages`，TTL 5 分钟 + file_size 失效）。生成结束后需 `bookshelf.refreshChatMessages(avatar, fileName)` 强制失效重拉 + `reader.loadChat(...)` 重新分章，才能看到新楼层。
- **跳转最新章**：`openChapter(chapterIndex)`（[`index.js:1491`](../index.js:1491)）可跳转任意章；`reader.getChatInfo().chapters.length` 可获取总章数。

## 4. 设计方案

### 4.1 新增核心模块 `features/gen-notify/index.js`

遵循插件既有约定（`createXxxCore(deps)` 工厂函数 + 依赖注入），提供**纯净状态机与通知数据**，不直接操作弹窗 DOM（UI 装配留在主入口 index.js）。

```js
export function createGenNotifyCore(deps) {
  // deps:
  //   getStContext   -> () => window.SillyTavern.getContext()  （拿 eventSource / eventTypes）
  //   getSettings    -> () => extension_settings （读取开关）
  // 内部状态：
  //   pending        计数：待通知的生成结束次数（红点角标数字）
  // 方法：
  //   subscribe()    订阅 GENERATION_STARTED / GENERATION_ENDED / GENERATION_STOPPED
  //   consume()      返回并清零 pending（供 UI 读取）
  //   clear()        清零 pending
  //   getPending()   返回当前 pending
}
```

**事件处理逻辑**：

1. `GENERATION_STARTED`：
   - 若 `dryRun` 为 true → 忽略（提示词查看器不通知）
   - 否则标记 `generating = true`（用于状态机，可将来扩展；当前需求下主要用于过滤无关 ENDED）

2. `GENERATION_ENDED` / `GENERATION_STOPPED`：
   - 若 `generating` 为 false 且之前没有 STARTED → 忽略（避免误触发，例如别的扩展触发的空事件）
   - 否则 `pending += 1`，置 `generating = false`，调用 `deps.onNotify()` 回调（由主入口传入：检查弹窗打开则显示红点+气泡）

**说明**：按需求"不做区分"，`pending` 只累加计数；红点与气泡用**统一红色**即可。若将来需要区分"正常/截断"，可在此模块分别计数，本次不做。

### 4.2 主入口 `index.js` 装配

在 `createExtension` 内部新增：

1. **实例化**：`const genNotify = createGenNotifyCore({ getStContext, getSettings, onNotify: () => showGenNotifyUi() });`

2. **订阅事件**：在 `subscribeEvents()` 中调用 `genNotify.subscribe()`（内部用 `eventSource.on(types.GENERATION_STARTED/ENDED/STOPPED)`）。

3. **顶栏红点 DOM**：在 `openReaderDialog()` 创建顶栏时，向 `.novel-topbar-settings` 追加一个红点徽标：

   ```html
   <span class="novel-gen-dot" style="display:none" title="有新楼层生成"></span>
   ```

   - 默认隐藏；`genNotify.getPending() > 0` 时显示，并带闪烁动画 class。
   - **位置（用户优化）**：红点作为角标挂在 × 关闭按钮右上角 —— `<span class="novel-gen-dot" data-gen-dot>` 移入 `.novel-icon-close`（`position: relative`）内部，红点自身 `position: absolute; top:-3px; right:-3px`，`pointer-events: none` 不拦截 × 点击。

4. **角落气泡 DOM**：创建一个挂到 `dlg.dialog`（随弹窗一起）右下角的通知气泡：

   ```html
   <div class="novel-gen-toast" style="display:none">
     <span class="novel-gen-toast-text">有新楼层生成</span>
     <span class="novel-gen-toast-close" title="关闭阅读器">×</span>
   </div>
   ```

   - **点击气泡任意位置**：调用 `closeReaderDialog()` 关闭阅读器弹窗（等同右上角关闭按钮；**不做"查看最新章"跳转**）。点击后弹窗关闭，一并 `genNotify.clear()` + 隐藏红点。
   - 气泡显示后开启定时自动收起（如 8 秒后淡出隐藏，但红点保留直到用户查看/关闭弹窗）。

5. **清除时机**：
   - 点击气泡 → 关闭阅读器弹窗 + `genNotify.clear()` + 隐藏红点
   - 弹窗关闭（`dlg.onClose`）→ 清除（下次打开重新累计）
   - （可选）打开阅读器时若已累计，红点即显示

6. **设置项**（`getGlobalSettings()` + 设置面板 `renderSettingsPanel`）：
   - `g.genNotifyEnabled`（默认 true）：总开关，关闭后不订阅/不显示
   - （可选）`g.genNotifyAutoHide`（默认 true）：气泡是否自动收起

### 4.3 `style.css` 新增样式

参考已有的 `@keyframes novel-highlight-flash` 动画先例：

```css
/* 关闭按钮作为红点角标定位锚点 */
.novel-icon-close { position: relative; }

/* 红点角标：挂在 × 关闭按钮右上角 */
.novel-gen-dot {
  display: block; /* span 默认 inline 会忽略宽高，必须 block 化 */
  position: absolute;
  top: -3px; right: -3px;
  width: 10px; height: 10px; border-radius: 50%;
  background: #e53935; /* 红色 */
  box-shadow: 0 0 6px rgba(229,57,53,.8);
  animation: novel-gen-dot-blink 1s infinite;
  pointer-events: none; /* 不拦截 × 按钮点击 */
}
@keyframes novel-gen-dot-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: .25; }
}

/* 角落气泡：absolute 定位到最近定位祖先（dialog）右下角，置于弹窗内容之上。
   - 全屏：.novel-dialog 无 position → 相对 .novel-overlay(fixed, 全屏) → 视口右下角
   - 悬浮窗：.novel-dialog-floating 是 fixed 定位上下文 → 悬浮窗内右下角，随窗口跟随
   - 置顶：气泡在 dialog 内随 .novel-dialog-floating 一起恢复 pointer-events:auto → 可点击 */
.novel-gen-toast {
  position: absolute; right: 24px; bottom: 24px; z-index: 100020;
  background: var(--novel-panel-bg, #1e2430); color: #eee;
  border: 1px solid rgba(229,57,53,.6); border-radius: 10px;
  padding: 12px 14px; box-shadow: 0 6px 20px rgba(0,0,0,.4);
  display: flex; align-items: center; gap: 12px;
  animation: novel-gen-toast-in .25s ease-out;
}
@keyframes novel-gen-toast-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
```

**注意（最终实现）**：气泡用 `position: absolute` 挂到 **`dlg.dialog`**（见 8.1 第 2 点的 v2 修复）。初版 `position: fixed` 挂 `dlg.overlay` 在悬浮窗下有两个 Bug：① 定位视口右下角而非悬浮窗内；② 置顶时 overlay `pointer-events:none` 导致无法点击。改为 absolute 挂 dialog 后：全屏相对 overlay 定位到视口右下角（表现不变）、悬浮窗定位到窗内右下角并随窗口跟随、置顶时随 dialog 恢复交互。**实施时已验证**：全屏/悬浮窗/置顶三种场景均正常（见 8.2）。

## 5. 实施步骤

1. **新增 `features/gen-notify/index.js`**：`createGenNotifyCore` 状态机 + 事件订阅 + `pending` 计数（见 4.1）。
2. **主入口 `index.js` 装配**：
   - 顶部导入 `createGenNotifyCore`
   - 实例化并传入 `onNotify` 回调
   - `subscribeEvents()` 中调用 `genNotify.subscribe()`
   - `openReaderDialog()` 顶栏追加红点 DOM
   - 弹窗内追加角落气泡 DOM + 点击事件（关闭阅读器弹窗）
   - `dlg.onClose` 清理
   - `getGlobalSettings()` 增加 `genNotifyEnabled` 默认 true
   - `renderSettingsPanel` + 事件绑定增加开关
3. **`style.css`**：新增红点闪烁动画与气泡样式（见 4.3），注意验证 `position: fixed` 挂载兼容性。
4. **测试**：
   - 阅读器打开时，酒馆生成一条新回复 → 顶栏红点闪烁 + 右下角气泡出现
   - 点击气泡 → 阅读器弹窗关闭（等同右上角关闭按钮）
   - 点击停止生成 → 同样触发通知
   - 阅读器关闭时生成 → 不打扰
   - `dryRun`（提示词查看器）→ 不触发
   - 开关关闭后不触发

## 6. 涉及文件

| 文件                           | 改动                                    |
| ------------------------------ | --------------------------------------- |
| `features/gen-notify/index.js` | **新增**：生成事件状态机 + pending 计数 |
| `index.js`                     | 装配：导入/实例化/订阅/DOM/设置项       |
| `style.css`                    | 红点闪烁动画 + 气泡样式                 |
| `manifest.json`                | 无需改动（模块打包方式不变）            |

## 7. 边界与风险

- **误触发防护**：`GENERATION_ENDED` 可能由非本插件/干跑场景触发，用 `generating` 标记 + `dryRun` 过滤。
- **fixed 定位兼容性**：`.novel-dialog` 若含 `transform`，`position: fixed` 子元素会错误定位，需改挂 `body`。
- **多次生成**：`pending` 累加计数，红点角标可显示数字（本次可选做：气泡显示"N 次生成"）。

## 8. 实施实测结论（浏览器验证，2026-09-24）

### 8.1 实际实现与规划的关键差异

1. **事件移除 API**：ST 的 `eventSource` 是 **EventEmitter 风格**，原型链方法为 `["constructor","on","makeLast","makeFirst","removeListener","emit","emitAndWait","once"]`，**没有 `off` 方法**。初始实现调用 `events.off(...)` 导致 `Uncaught TypeError: events.off is not a function`，会使 `dlg.onClose` 中断、`dialogRef = null` 未执行，弹窗无法再次打开。修复为 `const remove = events.removeListener || events.off;`（见 `features/gen-notify/index.js` 的 `unsubscribe`）。

2. **气泡挂载节点（v2 修复）**：规划中建议挂 `dlg.dialog` 或 `dlg.overlay`。初版挂 **`dlg.overlay`** + `position: fixed`（视口右下角），全屏正常。
   - **发现 Bug（悬浮窗）**：① 气泡 `fixed` 定位到**视口右下角**，悬浮窗是居中小窗口，气泡在窗外；② 悬浮窗**置顶**时 `.novel-overlay-floating.novel-overlay-pinned { pointer-events: none }`（点击穿透，只给 `.novel-dialog-floating` 恢复 `auto`），气泡挂在 overlay 上被点击穿透 → 无法点击。
   - **v2 修复**：改为挂 **`dlg.dialog`** + `position: absolute`（`right:24px; bottom:calc(24px + safe-area)`，`z-index:100020`）。定位到最近定位祖先：
     - 全屏：`.novel-dialog` 无 `position`（static）→ 向上到 `.novel-overlay`（fixed，铺满视口）→ **视口右下角**（表现与 fixed 一致）；
     - 悬浮窗：`.novel-dialog-floating` 是 `position: fixed`（定位上下文）→ 气泡固定在**悬浮窗内右下角**，随窗口拖动/缩放跟随；
     - 置顶：气泡在 dialog 内，随 `.novel-dialog-floating { pointer-events: auto }` 一起恢复交互 → **可点击**。
   - 已验证：全屏 `toastNearBottomRight: true`；悬浮窗 `toastInsideDialog: true`；置顶时 `toastPointerEvents: "auto"`。

3. **订阅时机（v2 修复）**：
   - v1：`bindGenNotifyUi(dlg)`（打开阅读器时）才 `subscribe()`，`dlg.onClose` 时 `unsubscribe()`。
   - **发现 Bug**：用户"先发送消息再打开弹窗"时，生成事件发生在未订阅期间被全部错过 → 无红点/气泡。
   - **v2 修复**：改为**插件启动时（"启动"区，`initButton()` 之后）常驻订阅**（`genNotify.subscribe()`），弹窗关闭期间后台持续累计未读计数（`genNotifyUi` 为 null，`onNotify` 无副作用）；`bindGenNotifyUi` 不再 `subscribe`，改为打开时检查 `genNotify.getPending() > 0` 则立即显示红点+气泡；`dlg.onClose` 不再 `unsubscribe`（只清 UI 引用/定时器/计数）。
   - **验证幂等**：`subscribe()` 内部先 `unsubscribe()` 再订阅，多次 open/close 周期监听器数量不变（实测 `GENERATION_STARTED` 监听器 open/close 前后 `delta: 0`）。

4. **开关与 DOM 解耦**：`bindGenNotifyUi` **始终创建红点 + 气泡 DOM**（与 `genNotifyEnabled` 开关解耦），开关只控制 `subscribe/unsubscribe`。避免"关闭开关 → 再打开"时气泡 DOM 缺失。

5. **计数文案**：气泡文本按 `pending` 显示"有新楼层生成" / "有 N 次新楼层生成"（`pending > 1` 时）。

6. **清理时机**：`dlg.onClose` 中 `genNotify.clear()`（清零未读计数）+ 清除气泡定时器 + 置空 `genNotifyUi`/`genToastEl` 引用；**不再 `unsubscribe`**（订阅常驻，见第 3 点 v2 修复）。

### 8.2 浏览器回归测试结果（全部通过）

| 场景                             | 结果                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常 `GENERATION_ENDED`          | ✅ 红点闪烁 + 气泡"有新楼层生成"                                                                                                                                  |
| `GENERATION_STOPPED`（手动停止） | ✅ 触发，计数累计（"有 2 次新楼层生成"）                                                                                                                          |
| `dryRun`（提示词查看器预览）     | ✅ 不触发                                                                                                                                                         |
| 孤立 ENDED（无前置 STARTED）     | ✅ 不触发（`generating` 标记过滤）                                                                                                                                |
| 设置面板开关关闭                 | ✅ 红点/气泡隐藏、订阅取消                                                                                                                                        |
| 开关关闭后生成结束               | ✅ 不触发                                                                                                                                                         |
| 重新打开开关                     | ✅ 订阅恢复、触发正常                                                                                                                                             |
| 阅读器关闭期间生成               | ✅ 完全不打扰（无气泡 DOM、UI 引用为 null）                                                                                                                       |
| 重新打开阅读器                   | ✅ 红点保持隐藏（关闭时已清零）、订阅常驻不重建                                                                                                                   |
| 重开后生成结束                   | ✅ 正常触发                                                                                                                                                       |
| 点击气泡                         | ✅ 关闭阅读器弹窗（等同右上角关闭按钮）                                                                                                                           |
| `events.off` 修复后弹窗反复开关  | ✅ 控制台无错误                                                                                                                                                   |
| **先发送再打开弹窗（时序 Bug）** | ✅ **后台累计未读 → 打开弹窗立即显示红点+气泡**                                                                                                                   |
| **弹窗关闭期间累计多次生成**     | ✅ 计数累计，打开后显示"有 N 次新楼层生成"                                                                                                                        |
| **开关关闭时后台生成**           | ✅ 不累计（零订阅）；重开开关后恢复订阅                                                                                                                           |
| **订阅幂等性**                   | ✅ open/close 周期监听器数量不变（delta 0）                                                                                                                       |
| **悬浮窗：气泡在窗内（Bug）**    | ✅ **气泡 absolute 定位到悬浮窗内右下角**（`toastInsideDialog: true`），随窗口拖动/缩放跟随                                                                       |
| **悬浮窗：置顶时气泡可点击**     | ✅ **置顶时 overlay 点击穿透（`pointer-events:none`），但气泡在 dialog 内随 `.novel-dialog-floating` 恢复交互（`toastPointerEvents: "auto"`），点击正常关闭弹窗** |
| **悬浮窗：气泡点击关闭弹窗**     | ✅ 点击气泡 → 弹窗/遮罩/红点全部移除（`dialogClosed: true`）                                                                                                      |
| **全屏回归：气泡仍视口右下角**   | ✅ `toastNearBottomRight: true`（视口 1288×702，气泡 right:1264/bottom:684），点击关闭正常                                                                        |
| **悬浮窗修复后控制台**           | ✅ 无插件相关错误（仅 ST 自身弃用警告）                                                                                                                           |

### 8.3 遗留可选项（本次未做）

- 红点角标数字显示（当前红点为纯圆点，气泡文本含计数）。
- 气泡自动收起时长设置项（当前固定 8 秒）。
