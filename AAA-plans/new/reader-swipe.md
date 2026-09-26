# 功能规划：小说阅读器查看/切换楼层其它 swipe

## 1. 背景与目标

当前阅读器渲染每条楼层时，只用 `mes.mes`（当前选中的 swipe 正文），`mes.swipes` 数组（楼层的其它版本）被完全忽略。用户在阅读时无法查看角色同一楼层的其它回复版本。

**目标**：在阅读器正文中，为**含多个版本**的楼层显示一个小切换条（如「‹ 1/3 ›」），点击即可在该楼层的各个 swipe 之间切换，形式类似酒馆消息的 swipe 条，直观且不打扰阅读。

## 2. 已确认的需求决策

| 决策点       | 结论                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| 交互形式     | 楼层底部显示小切换条「‹ 1/3 ›」，左右箭头切换（用户已确认，仿酒馆 swipe 条）                                       |
| 显示条件     | 仅当 `mes.swipes` 数组长度 > 1 时显示；单一版本不显示，不打扰                                                      |
| 默认显示     | 默认显示当前版本（`mes.swipe_id` 指向的版本，无 `swipe_id` 时显示 `mes.mes`）                                      |
| 切换行为     | 点击箭头仅在当前楼层内切换；切换后的正文就地替换，不改变分章、不改变其它楼层                                       |
| 切换后的状态 | 不写回酒馆（不改 `swipe_id`、不触发 ST 事件）；仅阅读器内临时查看，关闭重开恢复默认版本                            |
| 返回当前版本 | 切换条内提供「回到当前版本」按钮：一键把该楼层恢复为酒馆最初选中的版本（`mes.swipe_id`），浏览完其它版本后快速复位 |
| 正则过滤     | 每次切换渲染时，新版本正文同样经过 `regexFilter`（与现有正文一致）                                                 |
| 两种阅读模式 | 分页（`renderChapter`）与滚动（`renderChapterBlock`）均生效，二者共用渲染函数                                      |
| 设置开关     | 设置页新增「楼层版本切换条」开关（**默认开启**；关闭后不渲染切换条）                                               |

## 3. 技术调研结论

### 3.1 数据已包含 swipes，无需改数据层

- 消息来自 [`getChatMessagesCore()`](features/bookshelf/data.js:71)（`POST /api/chats/get`），返回的是 ST 原始消息对象。
- ST 的楼层对象本身带 `swipes`（数组，全部版本正文）与 `swipe_id`（当前选中下标，可能为 undefined/旧格式用 `swipe_info`）。
- [`renderMessage()`](features/reader/render.js:18) 的注释也写明消息对象含 `swipes`。数据层、缓存层（bookshelf/cache.js）、分章逻辑（chapters.js）均无需改动。

### 3.2 渲染链路（两种模式共用）

```
renderChapter(container, idx)   ← 分页模式（index.js:182）
renderChapterBlock(container, idx) ← 滚动模式（reader/index.js:138 + scroll.js）
        └─ renderMessagesBatched(deps, body, chapter.messages, opts)  ← render.js:84
                └─ renderMessage(deps, mes, options)  ← render.js:18（逐条，纯字符串）
```

- 两条渲染路径都调用 `renderMessagesBatched`，**只需在 render.js 内改动**即可同时覆盖两种模式。
- 每条消息的 HTML 由 `renderMessage` 以字符串拼接生成，由 `renderMessagesBatched` 统一挂载。

### 3.3 正则与安全渲染

- 正文渲染已走独立安全管线 `renderMarkdown`（converter → encodeStyleTags → DOMPurify.sanitize → decodeStyleTags），切换版本复用同一管线即可。
- `regexFilter` 已在 `renderMessage` 内对 `mes.mes` 应用；swipe 版本切换渲染时同样要调用，保持一致。

### 3.4 事件绑定方式

- 现有 DOM 采用**纯字符串拼接** + 一次 `innerHTML` 挂载（`renderMessagesBatched` 用 `wrapper.innerHTML`）。
- 为兼容「批量渲染 + 滚动模式反复追加章节块」的架构，切换条点击采用**事件委托**：在 `.novel-msg-list`（body）容器上绑定一次 click，通过 `closest('[data-swipe-idx]')` 定位目标消息与目标版本。

## 4. 设计方案

### 4.1 `features/reader/render.js`

**改动 A：抽取 `renderTextBody(deps, text, options)` 辅助函数**

```js
/**
 * 将单段文本渲染为安全的正文 HTML（复用现有 renderMarkdown/escapeHtmlFallback 管线）。
 * @param {object} deps 依赖注入（renderMarkdown / regexFilter）
 * @param {string} text 消息正文（mes 或 swipes 中的某个版本）
 * @param {object} [options] 见 renderMessage
 * @returns {string} 安全 HTML
 */
function renderTextBody(deps, text, options = {}) {
  let t = text || "";
  if (typeof deps.regexFilter === "function" && t) {
    try {
      t = deps.regexFilter(t, options.avatar || "");
    } catch (err) {
      console.warn("[NovelReader] regexFilter 失败，使用原文:", err);
    }
  }
  try {
    if (typeof deps.renderMarkdown === "function") {
      return deps.renderMarkdown(t);
    }
  } catch (err) {
    console.warn("[NovelReader] renderMarkdown 失败，回退转义输出:", err);
  }
  return escapeHtmlFallback(t);
}
```

**改动 B：重构 `renderMessage`，支持 swipes**

- 计算楼层版本信息：

```js
// 楼层全部版本：优先 swipes 数组；无则视当前 mes 为唯一版本
const swipes = Array.isArray(mes.swipes) && mes.swipes.length > 1
  ? mes.swipes.map((s, i) => ({ text: s, index: i }))
  : [{ text: mes.mes || "", index: 0 }];

// 当前版本下标：优先 swipe_id（合法范围内），否则 0
let currentSwipe = 0;
if (Array.isArray(mes.swipes) && typeof mes.swipe_id === "number" &&
    mes.swipe_id >= 0 && mes.swipe_id < mes.swipes.length) {
  currentSwipe = mes.swipe_id;
}
```

- 正文 HTML 改为由 `renderTextBody(deps, swipes[currentSwipe].text, options)` 生成。
- 楼层 `data-*` 增加 `data-mes-id`（已有 `data-id`，但为兼容 `mesId` 缺失的场景，用 `mes.mesId ?? ''` 即可）与 `data-swipe-idx`（当前版本下标）。
- 仅当 `swipes.length > 1` 时，在 `.novel-msg-body` 之后追加切换条 HTML：

```html
<div class="novel-swipe-bar" data-swipe-bar>
  <button type="button" class="novel-swipe-btn" data-swipe-prev title="上一个版本">‹</button>
  <span class="novel-swipe-count">1/3</span>
  <button type="button" class="novel-swipe-btn" data-swipe-next title="下一个版本">›</button>
  <button type="button" class="novel-swipe-btn novel-swipe-reset" data-swipe-reset title="回到当前选中的版本">↺</button>
</div>
```

- 计数字段 `data-swipe-total`、`data-swipe-idx`、`data-swipe-origin`（酒馆原始 `swipe_id`）供切换/复位时更新（避免重新渲染整条）。
- **「回到当前版本」按钮（↺）**：语义 = 该楼层当前显示的是酒馆最初选中的版本（即 `swipe_id` 指向的版本）时置灰；用户浏览了其它版本后按钮可用，点击即恢复显示原始版本。数据来源为 `mes.swipe_id`（与默认显示同源）。

**改动 C：`renderMessagesBatched` 绑定切换条事件委托**

- 在分批挂载完成后，若容器尚未绑定过委托，则：

```js
container.addEventListener("click", (e) => {
  // 切换版本：‹ / ›
  const btn = e.target.closest("[data-swipe-prev], [data-swipe-next]");
  if (btn) {
    const msg = btn.closest(".novel-msg");
    if (!msg) return;
    const total = Number(msg.dataset.swipeTotal || 0);
    if (total < 2) return; // 无切换空间
    let idx = Number(msg.dataset.swipeIdx || 0);
    const dir = btn.hasAttribute("data-swipe-prev") ? -1 : 1;
    idx = (idx + dir + total) % total; // 循环切换
    switchMessageSwipe(deps, msg, idx);
    return;
  }

  // 回到当前版本：↺（恢复为酒馆最初选中的 swipe_id 版本）
  const reset = e.target.closest("[data-swipe-reset]");
  if (reset) {
    const msg = reset.closest(".novel-msg");
    if (!msg) return;
    const origin = Number(msg.dataset.swipeOrigin ?? 0);
    switchMessageSwipe(deps, msg, origin);
  }
});
```

- `switchMessageSwipe(deps, msgEl, idx)`：
  1. 从 `msgEl.dataset.mesId` 找回消息对象（见下），取 `swipes[idx]`。
  2. `msgEl.querySelector(".novel-msg-body").innerHTML = renderTextBody(deps, text, { avatar: msgEl.dataset.avatar })`。
  3. 更新 `msgEl.dataset.swipeIdx = String(idx)` 与 `.novel-swipe-count` 文本 `idx+1/total`。
  4. **更新 ↺ 按钮可用态**：`idx === origin` 时置灰（`disabled`），否则可用。
  5. 更新 prev/next 按钮 disabled 态（可选：不循环时首/尾禁用）。

- **回找消息对象的途径**（供 `switchMessageSwipe` 使用，避免依赖全局 chat 数组）：
  - 方案一（推荐）：`renderMessagesBatched` 内部维护 `Map<mesId, {mes, avatar, origin}>` 的引用表；`switchMessageSwipe` 优先查该表。
  - 方案二（兜底）：渲染时把当前版本正文文本存入 `msgEl.dataset` 之外，直接在 `msgEl` 上用 `data-swipe-texts` 存全部版本文本（JSON 转义）。缺点：大版本正文会导致 DOM data 属性膨胀。
  - **采用方案一**：在 `renderMessagesBatched` 中每次挂载节点时 `swipeRefs.set(mes.mesId ?? indexInChapter, { mes, avatar, origin: currentSwipe })`，key 用 `mes.mesId ?? \`m\${i}\``（章内唯一）。注意：`renderMessage` 输出的 `data-id` 目前用的是 `mes.mesId ?? ''`，为兼容 key，`renderMessage`需确保同一 key 逻辑（`data-id` 与 refs key 一致）。
  - `renderMessage` 需在楼层 HTML 上写 `data-swipe-origin="${currentSwipe}"`，与 `swipeRefs` 的 `origin` 一致，供 ↺ 按钮直接读取。

**边界情况**

- `mes.mesId` 缺失（老格式楼层）：key 用章内序号，仍可切换。
- `mes.swipes` 存在但 `swipe_id` 越界/非数字：默认显示 `mes.mes`（index 0），切换条仍可用。
- `mes.swipes` 全为空串：按多版本处理（显示切换条），与 ST 行为一致。
- 搜索高亮/定位：`scrollToMessage`/`renderChapter` 的 `highlightOffset` 按 DOM 子节点顺序定位，切换条作为 `.novel-msg` 的**子元素**（不增加同级节点），不影响 `body.children[offset]` 定位。

### 4.2 `style.css` 新增样式（适配主题变量）

在「小说消息」区块（style.css:837 附近）追加：

```css
/* ---------- 楼层版本切换条（swipe） ---------- */
.novel-swipe-bar {
  display: flex;
  width: fit-content;
  align-items: center;
  gap: 6px;
  margin: 6px auto 0;
  padding: 2px 8px;
  border: 1px solid
    color-mix(
      in srgb,
      var(--novel-fg, var(--SmartThemeBodyColor, #ddd)) 25%,
      transparent
    );
  border-radius: 999px;
  opacity: 0.75;
  transition: opacity 0.2s ease;
}
.novel-msg:hover .novel-swipe-bar {
  opacity: 1;
}
.novel-swipe-btn {
  background: transparent;
  border: none;
  color: var(--novel-accent, var(--novel-fg, var(--SmartThemeBodyColor, #ddd)));
  font-size: 1rem;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
  opacity: 0.8;
}
.novel-swipe-btn:hover:not(:disabled) {
  opacity: 1;
}
.novel-swipe-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.novel-swipe-count {
  font-size: 0.75rem;
  opacity: 0.6;
  min-width: 2.5em;
  text-align: center;
}
.novel-swipe-reset {
  /* 「回到当前版本」按钮：与计数用分隔线区分，置灰态更弱 */
  margin-left: 4px;
  padding-left: 8px;
  border-left: 1px solid
    color-mix(
      in srgb,
      var(--novel-fg, var(--SmartThemeBodyColor, #ddd)) 20%,
      transparent
    );
}
```

- 颜色沿用 `--novel-accent` / `--novel-fg` / `--SmartTheme*`，跟随内置主题与酒馆主题。
- 切换条为 `.novel-msg` 内联元素，不影响布局与消息定位。

### 4.3 设置开关「楼层版本切换条」（默认开启，必做）

在设置页「显示用户回复」之后、「删除与重命名按钮」之前新增一行开关，默认开启；关闭后正文不再渲染切换条（楼层恢复只显示当前版本，与现状一致）：

- `getGlobalSettings()` 增加默认值：`if (g.showSwipeBar === undefined) g.showSwipeBar = true;`（index.js:271 附近）
- 设置页 HTML 增加一行开关（仿「显示用户回复」样式，index.js:1966 附近）：

```html
<div class="novel-settings-row">
  <div class="novel-settings-label">楼层版本切换条</div>
  <label class="novel-switch">
    <input type="checkbox" class="novel-show-swipe-bar" ${g.showSwipeBar ? "checked" : ""} />
    <span class="novel-switch-track"></span>
    <span class="novel-switch-thumb"></span>
  </label>
  <div class="novel-settings-hint">开启后，含多个版本（swipe）的楼层底部显示「‹ 1/N ›」切换条，可查看其它版本并一键回到当前选中版本。</div>
</div>
```

- change 事件绑定（仿 `showReaderChatActions`，index.js:2328 附近）：保存设置；若在正文页则 `openChapter(state.currentChapter)` 重渲染当前章生效。
- `renderMessage` / `renderMessagesBatched` 通过 `deps.getShowSwipeBar`（或 options 传入）控制是否渲染切换条；关闭时整条逻辑退化为现状（只渲染 `mes.mes`），避免任何行为差异。

## 5. 涉及文件清单

| 文件                        | 改动                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `features/reader/render.js` | 新增 `renderTextBody`；重构 `renderMessage` 支持 swipes（含 ↺ 复位按钮）；`renderMessagesBatched` 增加事件委托与 swipeRefs |
| `style.css`                 | 新增 `.novel-swipe-bar` / `.novel-swipe-btn` / `.novel-swipe-count` / `.novel-swipe-reset` 样式                            |
| `index.js`                  | 设置默认值 `showSwipeBar` + 设置页 UI + change 事件绑定（重渲染当前章生效）                                                |

**不改动**：`features/bookshelf/*`（数据已含 swipes）、`features/reader/chapters.js`（分章与版本无关）、`features/reader/scroll.js`、`features/reader/index.js`（核心渲染函数签名不变）。

## 6. 测试要点

1. **分页模式**：打开含多版本楼层的聊天，正文楼层底部出现切换条；点击 ‹/› 切换内容正确，计数更新，切换不触发整章重渲染。
2. **滚动模式**：连续滚动阅读中，切换条同样可点击切换；新追加的章节块内切换条可正常使用（事件委托在每次渲染的容器上绑定）。
3. **↺ 回到当前版本**：默认显示酒馆选中版本（如 1/2）时 ↺ 置灰；切到 2/2 后 ↺ 可用，点击恢复 1/2 并重新置灰。
4. **设置开关**：默认开启；关闭后重渲染正文，切换条消失、楼层显示与现状完全一致；重新开启恢复。
5. **单一版本楼层**：不显示切换条。
6. **正则过滤**：开启酒馆正则时，切换后的版本正文同样被正则处理。
7. **主题适配**：内置主题与「跟随酒馆」模式下切换条颜色、可读性正常。
8. **边界**：无 `mesId` 的老楼层、`swipe_id` 越界（origin 回退 0）、swipes 含空串等场景不报错。
9. **搜索跳转**：搜索定位高亮不受切换条影响。
