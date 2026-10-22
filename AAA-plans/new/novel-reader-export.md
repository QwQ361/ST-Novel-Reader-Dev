# 新增导出文档功能（导出 txt）

## 需求回顾

1. **导出按钮位置**：目录页「收藏按钮」与「重命名」之间；若未勾选「在目录页显示删除与重命名按钮」（`showTocChatActions=false`），则在收藏按钮的右侧。
2. **导出格式**：txt。
3. **导出内容**：应用用户勾选的正则后的样子。格式：
   - `第一章`（有自动识别标题时，后跟章节标题名）
   - 第一章的内容
   - （五个空行）
   - `第二章` / 内容 /（五个空行）…以此类推，所有章节在同一 txt 文件。
4. **交互流程**：点击导出按钮后依次弹出两次 `window.confirm`：
   - ① 是否导出 user 回复？（否 → 只导出 char 的）
   - ② 是否导出 html 代码？（否 → 自动略过 html 代码块）
   - 都选择后自动下载 txt 文件。

## 澄清结论（用户已确认）

- **同时导出 user + char**：带说话人标签，标签用 `mes.name` 角色显示名，**人名标签单独成行**，正文另起一行。

  ```
  琳娜：
  正文内容

  user：
  用户回复内容
  ```

- **只导出 char**（第一个 confirm 选否）：**不带标签**，仅正文。
- **不需要章节列表/目录**，直接按章顺序输出。
- 章节内**每条消息（user/char 逐条）**之间空一行；章节之间五个空行。
- 所有章节（含番外）都在同一 txt 文件；按 `displayIndex` 顺序输出。
- **markdown 标记原样保留**：导出的是正则过滤后的 markdown 源码，`**加粗**`、`` `代码` ``、``` ```代码块 ``` 等标记不转换、不剥离（正则过滤的对象本就是 markdown 源码文本）。

## 输出格式细节

```
第一章 章节标题（仅 titleSource==="tag" 且 title 非空时附带标题）
消息1正文

消息2正文

（……消息间空一行……）




（五个空行）
第二章 章节标题
……
```

- 消息正文取 `mes.mes`（当前选中版本，与阅读显示一致；不展开 swipes 全部版本）。
- 只导出 char 时：跳过 `is_user` 消息，无标签。
- 同时导出时：`mes.name`（user 消息 name 为空则用 `deps.userName`）单独成行 + `：` + 空行 + 正文。
- 系统消息（`is_system`）与 char 同等对待（按阅读器的分章/显示逻辑处理）。
- 空正文消息跳过（或输出空段，实现时统一：无正文不输出该消息块）。

## 正则与 HTML 代码块处理

导出时逐条消息正文按以下顺序处理（与 [`renderTextBody()`](features/reader/render.js:27) 逻辑一致）：

1. **提取 html 代码块**：调用 [`preprocessHtmlApps(text)`](features/reader/iframe.js:47) 把 ` ```html ... ``` ` 代码块提取为占位符（`@@NOVEL_HTML_APP_n@@`），保护其不被正则命中。
2. **应用正则**：`regexCore.runRegexOnText(text, { avatar })`（复用 [`features/regex/index.js`](features/regex/index.js:403) 已勾选正则）。
3. **html 代码块还原 / 略过**：
   - confirm ② 选「导出 html」→ 将占位符替换回**原始代码块**（` ```html\n<code>\n``` `），即正文中以代码块形式原样输出。
   - confirm ② 选「否」→ 占位符替换为空字符串（略过 html 代码块）。

> 注意：导出的正文是**纯文本**（markdown 源码形态），不做 HTML 渲染；正则作用后的文本即最终导出文本。

## 实现位置与改动

### 1. 新增 [`features/export/index.js`](features/export/index.js)（新建文件）

导出核心逻辑，遵循项目「业务逻辑放 features/」约定，采用依赖注入模式：

```js
export function createExportCore(deps) {
  // deps 需要：
  //   getGlobalSettings / saveSettings（可能不需要）
  //   getChatInfo / getChatMessages：由 index.js 传入 reader/bookshelf
  //   regexFilter: (text, avatar) => string
  //   getHtmlAppEnabled
  //   userName
  return {
    async exportChat({ avatar, fileName, includeUser, includeHtml }) {
      // 1) 加载聊天完整消息（异步）
      //    deps.getChatMessages(avatar, fileName)
      //    或复用 reader.getChatInfo().chapters（若当前已加载该聊天）
      // 2) 分章：splitChapters(messages, { showUserReplies: includeUser })
      //    （不传 showUserReplies 时保留 user，只导出 char 时先过滤）
      // 3) 逐章拼接文本：
      //    章头 = "第{displayIndex}章" + (titleSource==='tag' && title ? ' ' + title : '')
      //    章节内逐消息：
      //      正文 = processText(mes.mes, includeHtml)
      //      带标签：nameLine = (mes.name || userName)
      //      输出：nameLine \n\n 正文 （仅 includeUser 且非 user 也带标签？
      //             —— 实际：仅当 includeUser=true 时 char/user 都带标签；includeUser=false 时无标签）
      //    消息间空一行
      // 4) 章节间五个空行
      // 5) 返回完整文本
    },
  };
}
```

**关键点**：`splitChapters` 已导出纯函数（[`features/reader/chapters.js:22`](features/reader/chapters.js:22)），可直接 import 复用；标题规则复用 [`buildChapterHeader`](features/reader/index.js:110) 的拼接逻辑（`第N章` + tag 标题）。

**标签规则细化**：

- `includeUser === true`：所有消息（user + char）都输出 `{name}：\n\n{正文}`。
- `includeUser === false`：只输出 char（`is_user` 跳过）且**无标签**，仅正文。

### 2. [`index.js`](index.js) 改动

**a. 新增下载图标 SVG 常量**（仿照 `BOOKMARK_SVG` / `RENAME_SVG`）：

```js
const EXPORT_SVG = '<svg ...download 图标.../>';
```

**b. 顶部导入**：`import { createExportCore } from "./features/export/index.js";`

**c. 依赖组装**（`deps` 区）：

```js
const exportCore = createExportCore({
  ...deps,
  getChatMessages: (avatar, fileName) => bookshelf.getChatMessages(avatar, fileName),
  regexFilter: (text, avatar) => regexCore.runRegexOnText(text, { avatar }),
});
```

**d. 目录头按钮插入**（[`renderTocPage()`](index.js:1462)）——在收藏按钮（1508 行）之后、`.novel-toc-chat-actions`（1510 行）之前插入：

```html
<button class="novel-toc-export-btn" title="导出聊天为 txt" data-action="export">${EXPORT_SVG}</button>
```

- 该按钮**始终显示**（不依赖 `showTocActions`），因此当 `showTocActions=false` 时自然落在收藏按钮右侧，符合需求 1。

**e. 事件绑定**（在 1521 行 bookmarks 绑定附近新增）：

```js
toc.querySelector('[data-action="export"]').addEventListener("click", (e) => {
  e.stopPropagation();
  handleExportChat();
});
```

**f. 导出处理函数**（新增，靠近 `confirmDeleteChat` 区域）：

```js
async function handleExportChat() {
  if (!state.currentChar || !state.currentChat) return;
  const includeUser = window.confirm("是否导出 user 回复？\n\n选择「确定」= 同时导出 user 与 char；\n选择「取消」= 只导出 char 消息。");
  const includeHtml = window.confirm("是否导出 html 代码？\n\n选择「确定」= 正文中保留 ```html 代码块；\n选择「取消」= 自动略过 html 代码块。");
  // 生成文本 + 下载（Blob + BOM + URL.createObjectURL）
}
```

### 3. [`style.css`](style.css) 新增样式

仿照 `.novel-toc-action`（[`style.css:644`](style.css:644)）新增 `.novel-toc-export-btn`：

- 尺寸/边框/圆角/hover 与 `.novel-toc-action` 一致（30×30 图标按钮）；
- `display:inline-flex; align-items:center; justify-content:center;`；
- 内置 svg 14×14 描边。

### 4. 下载工具（Blob）

```js
function downloadTextFile(filename, content) {
  // UTF-8 BOM（\uFEFF）保证 Windows 记事本正确识别中文
  const blob = new Blob(["\uFEFF" + content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

文件名：`${角色名}-${聊天文件名}.txt`（如 `琳娜-我的故事.txt`），从 `state.currentChar.name` 与 `state.currentChat.file_name` 取。

## 待实现清单

- [ ] 新建 [`features/export/index.js`](features/export/index.js)：`createExportCore`，含分章复用、逐消息正则+html 处理、章节文本拼接
- [ ] [`index.js`](index.js) 顶部：`EXPORT_SVG` 常量 + `createExportCore` import + deps 组装
- [ ] [`index.js`](index.js) [`renderTocPage()`](index.js:1462)：目录头插入导出按钮 + 事件绑定
- [ ] [`index.js`](index.js)：`handleExportChat()` 处理函数（两次 confirm + 下载），及 `downloadTextFile` 工具
- [ ] [`style.css`](style.css)：新增 `.novel-toc-export-btn` 样式
- [ ] 验证：按钮位置（两种 showTocActions 情况）、两次 confirm、正则应用、html 导出/略过、五个空行分隔、下载文件名与中文编码

## 边界情况

- **空聊天**：`info.chapters` 为空 → confirm 后提示「该聊天暂无内容」不下载。
- **正则异常**：`runRegexOnText` 内部已 try/catch（[`features/regex/index.js:421`](features/regex/index.js:421)），导出不阻断。
- **html 代码块无内容**：`preprocessHtmlApps` 已容错（`(?:```|$)`）。
- **user 消息 name 为空**：用 `deps.userName`（即 ST 的 `userName`，默认「你」）。
- **swipes 多版本**：只导出当前选中版本 `mes.mes`（与阅读显示一致）。
