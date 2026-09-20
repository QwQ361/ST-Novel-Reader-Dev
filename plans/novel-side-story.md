# 番外（Side Story）功能实施计划

> 目标：围绕「番外的标注与记录番外指令」构建完整功能。让用户可在酒馆聊天楼层中标注番外、隐藏楼层、将 user 指令收入全局指令库，并在小说阅读器目录中以「番外」形式展示（支持主线/番外筛选）。

---

## 一、需求梳理（已与用户确认）

### 1. 总开关（可选功能）

- 设置页（阅读器选项弹窗）新增「启用番外功能」开关，**默认关闭**。
- 关闭时：楼层番外按钮、目录番外标记、指令库入口**全部隐藏**（不打扰不需要的用户）。
- 开启时：以下全部番外相关功能出现。

### 2. 楼层番外标注按钮

- 位置：ST 楼层操作栏 `.extraMesButtons`（消息三点菜单内），新增「标注为番外」按钮。
- 语义（与分章一致，user+char 一对）：
  - 点击 **char 楼层**：标记该 char 楼层 + 关联上一楼 user 楼层 → 构成一个番外单元。
  - 点击 **user 楼层**：标记该 user 楼层 + 关联下一楼 char 楼层 → 构成一个番外单元。
- 标注动作三合一（同时执行）：
  1. **标记**：写入 ST 消息 `mes.extra.novelExtra`（轻量标记）。
  2. **隐藏**：调用 `hideChatMessageRange` 把相关楼层设为 `is_system=true`（即「从信息词中排除消息」，不影响阅读器渲染）。
  3. **入指令库**：将 user 楼层文本收入番外指令库（按文本去重，已存在则不重复入库）。

### 3. 取消标注

- 楼层操作栏按钮变为「取消番外标注」。
- 点击后弹出确认框（`window.confirm`）：
  - 撤标记 + 撤隐藏（恢复 `is_system=false`）。
  - 确认框询问「是否同时移出指令库？」→ 是则移除指令库对应条目，否则保留。

### 4. 阅读器目录番外显示

- 被标注为番外的章节，目录标题由「第N章」变为「番外」。
- 标题：优先从 user 楼层正文的自定义标签（与自动识别标题同一标签 `chapterTitleTag`）提取；无标签则只显示「番外」。
- **番外不计入章节数**（`totalChapters` 只统计主线章节）。
- 目录页新增筛选：**都看 / 只看主线 / 只看番外**（仅启用番外功能时显示筛选）。
  - 只看主线：番外章节完全隐藏。
  - 只看番外：只显示番外章节。
- 点击「番外」条目：正文正常渲染番外内容（与阅读普通章节一致，编号显示为「番外」而非「第N章」）。

### 5. 番外指令库

- **全局汇总**：所有角色、所有聊天的番外 user 指令统一收进一个库。
- **只存文本**：指令库仅存 user 指令的文本内容 + 可选的名称/分类，不关联原聊天位置。
- **分类树**：无限层级（文件夹式嵌套，参考 CFM `buildFolderTreeHtml`）。
  - 默认分类「未分类」。
  - 可手动创建分类、嵌套子分类、给分类改名、删除分类。
- **指令操作**：可创建指令（手写）、可导入（txt）、可改名、可删除、可归类。
- **入口位置**：输入框工具行（`#rightSendForm`）注入「指令库」按钮，独立于阅读器。
- **点击指令**：指令文本**追加**到输入框末尾（输入框为空则直接填入）。
- **去重**：按 user 指令文本（trim 后）完全一致去重。

---

## 二、数据设计

### 1. 番外标记（存 ST 消息 `extra` 字段）

```
mes.extra.novelExtra = {
  fw: true,          // side-story 标记
  uid: "fw_1678...", // 唯一 id（取消标注定位用）
  linked: 3,         // 关联楼层索引（user+char 中的另一条）
  title: "标题"      // 可选，自动提取的自定义标签内容；无则省略
}
```

- **只挂在 char 楼层**（或 user 楼层被点击时按规则归一：始终把标记放 char 那条，user 靠 `linked` 引用）。
- 体积：约 80 字节/条，一万条仅 ~1MB，无溢出风险。
- 存储：写入 ST 全局 `chat[mesId].extra` 后调用 `saveChatConditional()` 持久化，随聊天文件跨设备同步。
- 阅读器读消息时直接可见标记（`/api/chats/get` 会返回 `extra`）。

### 2. 番外指令库（存 `extension_settings`）

命名空间：`extension_settings[EXT_NAME].novelSideStory`

```
novelSideStory = {
  categories: {                          // 分类树（文件夹式）
    "cat_123": { id, parentId: null, name: "日常番外", sortOrder: 0 },
    "cat_456": { id, parentId: "cat_123", name: "恋爱", sortOrder: 0 }
  },
  commands: {                            // 指令库（全局）
    "cmd_789": {
      id: "cmd_789",
      text: "（user 指令原文）",
      name: "可选名称",                   // 用户给指令取的名字
      categoryId: "cat_123" | null,      // null = 未分类
      createdAt: 1234567890
    }
  }
}
```

- 全局一份，跨角色/聊天共享。
- 分类树结构直接对齐 CFM 的 `{ id: { parentId, sortOrder, name } }` 模式，复用现有 `getChildIds` 逻辑思想。

### 3. 设置项（`extension_settings[EXT_NAME]`）

```
g.sideStoryEnabled = false   // 启用番外功能（默认关闭）
```

---

## 三、模块划分（features/side-story/）

```
features/side-story/
  index.js        # createSideStoryCore：数据层 + 指令库 API
  mark.js         # 楼层标注/取消标注逻辑（调用 ST hideChatMessageRange + saveChatConditional）
  command-lib.js  # 指令库数据（分类树 CRUD + 指令 CRUD + 去重）
  panel.js        # 指令库浮动面板 UI（分类树 + 指令列表 + 输入框填充）
  inject.js       # 楼层操作栏按钮注入 + 输入框工具行按钮注入
```

### 各模块职责

**`features/side-story/mark.js`**

- `markAsSideStory(mesId)`：给定楼层 index，解析出 user+char 对 → 写 `extra.novelExtra` → 隐藏 → 入指令库。
- `unmarkSideStory(mesId)`：撤标记 + 撤隐藏 + （确认后）移出指令库。
- 依赖注入：`getChat()`（读 ST 全局 chat）、`hideChatMessageRangeFunc`、`saveChatConditionalFunc`、`commandLib`。
- 楼层配对规则（与 `splitChapters` 一致）：
  - 点击 char（`is_user=false`）：配对其上一楼最近一条 user（若紧邻）。
  - 点击 user（`is_user=true`）：配对其下一楼最近一条 char（若紧邻）。
  - 标记统一挂在 char 那条的 `extra` 上。

**`features/side-story/command-lib.js`**

- 分类树 CRUD：`listCategories / createCategory / renameCategory / deleteCategory / moveCategory`。
- 指令 CRUD：`listCommands / createCommand / updateCommand / deleteCommand / setCommandCategory`。
- 去重：`addFromMessage(text)` → trim 后查重，存在则跳过。
- 惰性初始化 `novelSideStory` 表，遵循现有 bookmarks/progress 的 `table()` 模式。

**`features/side-story/inject.js`**

- `injectMessageButton()`：向每个楼层 `.extraMesButtons` 追加「标注番外/取消」按钮（事件委托 `$(document).on('click', '.novel-side-story-btn')`）。
- `injectCommandLibButton()`：向 `#rightSendForm` 注入指令库入口按钮。
- `refreshButtonStates()`：根据 `sideStoryEnabled` + 楼层是否已标注，切换按钮状态。

**`features/side-story/panel.js`**

- 指令库浮动面板：左侧分类树（复用 CFM tree 模式）+ 右侧指令列表 + 顶部搜索。
- 操作：新建分类/改名/删除、新建指令/改名/删除、拖动或右键归类、点击指令追加到输入框。
- 注入点：挂在 `document.body` 的 fixed 浮动层（参照 `novel-cfm-panel` 定位逻辑）。

**`features/side-story/index.js`**

- 组装以上模块，导出 `createSideStoryCore(deps)`。
- 提供 `isEnabled()`、`getMarkedMessages()`、`openPanel()` 等聚合 API。

---

## 四、阅读器改造（features/reader/ + index.js）

### 1. 分章逻辑扩展（`features/reader/chapters.js`）

- 新增 `isSideStoryChapter(chapter)`：检查章内 char 消息的 `mes.extra.novelExtra.fw`。
- 在 `loadChat` 分章后，为每章标注 `isSideStory`：
  - 番外章 = 章内含 fw 标记的章节。
  - 番外章不计入主线章节计数，但保留原始分章序列（`index` 仍为原始顺序，目录过滤时重新编号展示）。

### 2. 目录渲染（`index.js` `renderTocPage`）

- 目录头部：启用番外功能时，新增筛选器「都看 / 只看主线 / 只看番外」（状态存 `state.tocFilter`）。
- 筛选逻辑：
  - 只看主线：过滤掉 `isSideStory` 章节。
  - 只看番外：只保留 `isSideStory` 章节。
  - 番外条目显示「番外」+（可选）标题，主线显示「第N章」（番外不计入 N 的序号）。
- 分页/章数统计按当前筛选结果计算。

### 3. 正文渲染（`index.js` 阅读页）

- 番外章标题显示「番外」而非「第N章」；其余渲染管线不变。

### 4. 章节计数与进度

- `totalChapters` = 主线章节数（番外不计入）。
- 进度保存仍用原始 `chapter.index`（稳定键），避免切换筛选后进度错乱。

---

## 五、设置页改造（`index.js` `openGlobalSettings`）

- 新增「番外功能」区块：
  - 主开关：启用番外功能。
  - 说明文字：开启后显示楼层番外按钮、目录番外标记、指令库入口。
- 仅在开启时展示次级选项（如后续需要的「番外标签名」等，本期可不加）。
- `getGlobalSettings()` 增加默认值 `g.sideStoryEnabled = false`。

---

## 六、依赖注入与装配（`index.js`）

新增：

```js
const sideStory = createSideStoryCore({
  ...deps,
  getChat: () => window.chat,                    // ST 全局消息数组
  getHideChatRange: () => hideChatMessageRangeFunc,  // integrations 新增
  getSaveChatConditional: () => saveChatConditionalFunc, // integrations 新增
  getInputTextarea: () => document.getElementById('send_textarea'),
  getEnabled: () => getGlobalSettings().sideStoryEnabled,
});
```

`integrations/sillytavern.js` 新增访问器：

- `hideChatMessageRangeFunc()` → `chats.js` 的 `hideChatMessageRange`。
- `saveChatConditionalFunc()` → `script.js` 的 `saveChatConditional`。

初始化时调用 `sideStory.injectAll()`（楼层按钮事件委托 + 输入框按钮），并在设置开关变化时 `sideStory.refresh()`。

---

## 七、关键文件变更清单

| 文件                                 | 变更                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| `features/side-story/index.js`       | 新建，功能聚合                                       |
| `features/side-story/mark.js`        | 新建，楼层标注/取消                                  |
| `features/side-story/command-lib.js` | 新建，指令库数据                                     |
| `features/side-story/panel.js`       | 新建，指令库面板 UI                                  |
| `features/side-story/inject.js`      | 新建，按钮注入                                       |
| `features/reader/chapters.js`        | 新增 `isSideStoryChapter`                            |
| `features/reader/index.js`           | `loadChat` 标注章节 isSideStory                      |
| `index.js`                           | 目录筛选、正文番外标题、设置项、装配                 |
| `integrations/sillytavern.js`        | 新增 hideChatMessageRange/saveChatConditional 访问器 |
| `style.css`                          | 番外按钮/指令库面板/目录筛选样式                     |
| `README.md`                          | 文档补充                                             |

---

## 八、风险与边界

1. **`extra` 字段兼容**：`mes.extra.novelExtra` 命名空间独立，与 ST 及他扩展不冲突；删除插件后仅遗留无效字段，不影响聊天。
2. **隐藏与阅读器**：`is_system` 隐藏只影响 AI 上下文，阅读器读完整数组仍显示番外内容（符合需求）。
3. **配对边界**：点击的楼层若缺少配对楼层（如第一条消息是 char 无上一 user），仅标记本身楼层，跳过隐藏与入库（提示用户）。
4. **去重可靠性**：按 trim 后全文一致去重；空文本不入库。
5. **目录重新编号**：主线章节序号在筛选「只看主线」时连续编号；番外章保持「番外」标记；切换筛选不破坏进度 key。
6. **设置开关即时性**：切换开关后，已打开的阅读器目录立即刷新；楼层按钮状态即时切换。
