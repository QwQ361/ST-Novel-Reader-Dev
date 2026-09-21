# 番外指令库：分类（文件夹）→ tag（标签）改造方案

## 一、目标

将番外指令库当前的「左右分栏 + 文件夹分类树」模式，改造为 **tag（标签）模式**：

- 用户可以为指令标记 **多个 tag**（多对多）
- 新标记入库 / 新创建的指令 **默认无 tag**
- 用户可以 **创建 / 重命名 / 删除 tag**
- **去掉左右分栏**，改为单列流式布局
- 默认显示全部指令，通过 **tag 下拉筛选 + 搜索** 叠加过滤

## 二、现状（改造前）

### 数据层 [`features/side-story/command-lib.js`](features/side-story/command-lib.js)

- `novelSideStory.categories`：无限层级文件夹树（`parentId` / `sortOrder` / `pinned`）
- `novelSideStory.commands`：每条指令含单个 `categoryId`（一对一）
- 分类 API：`listCategories` / `createCategory` / `renameCategory` / `deleteCategory` / `moveCategory` / `reorderCategory` / `toggleCategoryPin` / `getChildCategoryIds` / `getDescendantCategoryIds` / `listCommandsByCategory`
- 指令 API：`createCommand(text, {categoryId})` / `updateCommand(id, {categoryId})` / `addFromMessage` / `listCommandsByCategory` / `listCommands` / 收藏系列 / `deleteCommand` / `clearCommands`

### UI 层 [`features/side-story/panel.js`](features/side-story/panel.js)

- 双栏：左 `novel-ss-tree-col`（分类树）+ 右 `novel-ss-list-col`（指令列表）
- 分类树交互：展开/收起、置顶（pinned）、拖拽（子分类/同级排序/移入）、新建子分类、重命名、删除、未分类节点
- 指令列表：点击填入输入框、收藏星标、重命名、删除、批量操作（全选/框选/重命名/删除）、拖拽归类、txt 导入、新建指令

### 样式 [`style.css`](style.css) 2945-3530 行

- 双栏布局：`.novel-ss-body`（flex）/ `.novel-ss-tree-col`（260px）/ `.novel-ss-list-col`
- 分类树：`.novel-ss-cat-row` 系列 / 箭头 / 图标 / 计数 / 置顶 / 未分类 / 拖拽视觉
- 指令行 / 批量工具栏 / 收藏星标 / 批量重命名弹窗

### 消费方

- [`features/side-story/mark.js`](features/side-story/mark.js:174)：标注时 `commandLib.addFromMessage(userText, { name: "" })` 入库
- [`index.js`](index.js:263)：`createCommandLibCore` 装配；[`index.js`](index.js:331) 取消标注时 `commandLib.deleteCommand`

## 三、目标（改造后）设计

### 3.1 数据层：新存储结构

```js
novelSideStory = {
  tags: {
    "tag_abc": { id: "tag_abc", name: "日常", createdAt: 1234567890 }
  },
  commands: {
    "cmd_xyz": {
      id: "cmd_xyz",
      text: "（指令原文）",
      name: "可选名称",
      tagIds: ["tag_abc", "tag_def"],   // 多对多，默认 []
      favorite: false,
      createdAt: 1234567890
    }
  }
}
```

### 3.2 数据迁移（惰性一次性）

在 `table()` 首次访问时执行 `ensureMigration()`：

1. 若 `categories` 存在且 `tags` 不存在：
   - 遍历所有分类（含子分类），**拍平**为 tag（`name` 保留；父子同名时子分类加父名前缀防冲突）
   - 每条指令：`categoryId` → 对应 tag id，写入 `tagIds` 数组
2. 迁移完成后删除 `categories` 字段
3. 幂等：仅执行一次

### 3.3 API 变更（command-lib.js）

**删除**（分类树相关）：
`listCategories` / `createCategory` / `renameCategory` / `deleteCategory` / `moveCategory` / `reorderCategory` / `toggleCategoryPin` / `getChildCategoryIds` / `getDescendantCategoryIds` / `listCommandsByCategory`

**新增**（tag 相关）：

| API                        | 说明                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `listTags()`               | 全部 tag 映射副本                                                                                                             |
| `createTag(name)`          | 创建单个 tag（空名/null 返回 null；同名查重）                                                                                 |
| `createTags(names)`        | **批量创建**：接收数组或逗号分隔字符串（支持中英文逗号 `，` `,`），逐条 trim 后批量创建；空名/重复跳过；返回新建 tag 对象数组 |
| `renameTag(id, name)`      | 重命名（trim 后查重）                                                                                                         |
| `deleteTag(id)`            | 删除单个 tag，并从所有指令 `tagIds` 移除                                                                                      |
| `deleteTags(ids)`          | **批量删除**：接收 tag id 数组，逐个删除并从所有指令 `tagIds` 移除；返回成功删除数量                                          |
| `listCommandsByTag(tagId)` | 含该 tag 的指令（按 createdAt 倒序）                                                                                          |
| `listUntaggedCommands()`   | 无任何 tag 的指令（倒序）                                                                                                     |
| `listAllCommands()`        | 全部指令（倒序）                                                                                                              |

**修改**：

- `createCommand(text, { name?, tagIds?, favorite? })`：`tagIds` 数组，默认 `[]`；移除 `categoryId`
- `updateCommand(id, { text?, name?, tagIds?, favorite? })`：`tagIds` 整体替换；移除 `categoryId`

**保留**：`listCommands` / `existsByText` / `existsByName` / `addFromMessage`（默认无 tag）/ `toggleFavorite` / `listFavoriteCommands` / `listFavoriteCount` / `deleteCommand` / `clearCommands`

### 3.4 UI 层：新面板布局（panel.js）

```
┌──────────────────────────────────────────────┐
│ 番外指令库                    [🏷️管理tag] [✕] │  ← toolbar
├──────────────────────────────────────────────┤
│ [🔍 搜索指令…]  [tag下拉▼ (全部/未标记/各tag)] │  ← 搜索行 + tag 筛选
├──────────────────────────────────────────────┤
│ [批量工具栏: 全选/框选/重命名/删除 (批量模式)]  │
│ 指令列表（单列，默认全部，倒序）：              │
│   [tag] [tag]  指令名称 / 指令文本   ⭐ ✎ 🗑   │
│   ...                                        │
└──────────────────────────────────────────────┘
```

**toolbar**：关闭（✕）按钮左侧新增「🏷️ 管理 tag」按钮 → 打开 tag 管理弹窗。

**tag 管理弹窗**（新增）：

- 顶部标题「管理标签」+ 关闭按钮
- **批量新增**：底部多行输入框（textarea 或 input），支持**逗号分隔一次创建多个**（如「tag1，tag2，tag3」，中英文逗号均可），点「＋ 新增标签」批量创建；创建后清空输入框、刷新列表与指令行 tag 胶囊
- **列表**：每个 tag 一行（带复选框）`[☐] [tag名] [✎重命名] [🗑删除]`
- **批量删除工具栏**（列表中）：**全选 / 框选 / 反选** 三个按钮
  - 全选：勾选所有 tag
  - 框选：拖拽选择区域内的 tag（参照指令批量框选交互）
  - 反选：翻转所有 tag 的勾选态
- **删除确认**：点「🗑 删除选中」或单个 tag 的删除按钮时，先 `window.confirm` 确认（提示「确定删除选中的 N 个标签？该操作将从所有指令中移除这些标签」）
- **重命名**：单个 tag 行的 ✎ 触发 prompt 重命名
- 遮罩点击 / 取消 / Esc 关闭

**搜索行 + tag 筛选**：

- **搜索框支持两种筛选方式**（并存，取并集）：
  1. **文本匹配**：按指令 text / name 模糊匹配（原有逻辑保留）
  2. **手动输入 tag 名**：用户在搜索框输入的内容若与某 tag 名匹配，同时筛选出含有该 tag 的指令
     - 实现：搜索时遍历 `listTags()`，将 tag 名包含搜索词（或精确相等，见下）的 tag id 收集为 `matchTagIds`；过滤条件 = `(text/name 包含搜索词) OR (tagIds 与 matchTagIds 有交集)`
- 搜索框旁新增 **tag 下拉选择框**（compact）：选项 = 「全部 tag」「未标记」+ 所有 tag
- 选中某 tag → 过滤仅含该 tag 的指令；选中「未标记」→ 仅无 tag 指令；「全部 tag」→ 不按 tag 过滤
- tag 下拉筛选与搜索为 **AND** 叠加（下拉选某 tag + 搜索词 → 指令须含该 tag 且满足搜索词）
- 下拉框选中非「全部 tag」时，旁边显示 ✕ 清除按钮
- 示例：现有 tag「tag1」，用户在搜索框手打「tag1」→ 筛选出含有 tag1 的指令（即使指令文本不含「tag1」字样）

**指令行**：

- 指令行内显示该指令的 tag 胶囊（多个则横排；无 tag 不显示）
- 点击 tag 胶囊 → 将 tag 下拉框选中该 tag，实现筛选跳转（并清除搜索词）
- 点击指令主体 → 追加到输入框（保留）
- 收藏星标 / 重命名 / 删除（保留）
- 批量模式保留（全选 / 框选 / 重命名 / 删除）
- **指令行操作区新增「🏷️ 标签」按钮**（悬停显示，与收藏/重命名/删除同级）→ 打开**指令 tag 管理弹窗**（列出所有 tag 供勾选/取消，保存后写入该指令 `tagIds`）
- **批量模式新增「批量设置标签」按钮**：选中多条指令后统一添加/移除指定 tag（弹窗内「为选中 N 条指令 添加 tag / 移除 tag」）

**移除**：

- `renderTree` 全部逻辑（分类树渲染）
- 展开/收起全部、置顶、新建子分类、重命名/删除分类
- 分类拖拽（moveCategory / reorderCategory）
- 指令拖拽归类（拖到分类/未分类）
- 未分类节点、收藏树节点（收藏保留为筛选视图入口？—— 收藏作为筛选选项保留在 tag 下拉？）

> 注：收藏视图（`__favorites__`）建议保留，作为 tag 下拉框中的固定选项「⭐ 收藏」，或 toolbar 中保留星标入口。**实现时二选一，推荐并入 tag 下拉框选项。**

**状态变量**：

- `selectedCategoryId` → `selectedFilter`：`null`=全部 / `"__untagged__"`=未标记 / `"__favorites__"`=收藏 / `"tag_xxx"`=某 tag
- 移除 `expandedSet` / `dragCatId` / `dragCmdId` / `dragCmdIds` / `clearDropIndicators` / `getDropZone` / `setMultiDragGhost` / `flashDragTarget` 等拖拽相关

### 3.5 样式（style.css）

**删除**：双栏布局（`.novel-ss-tree-col` / `.novel-ss-list-col` 合并为单列）、分类树系列（`.novel-ss-cat-row` / 箭头 / 图标 / 计数 / 置顶 / 未分类 / 拖拽视觉 for cat）

**新增**：

- `.novel-ss-tag`（tag 胶囊：圆角、小号、主题色描边）
- `.novel-ss-tag-filter`（tag 下拉选择框，compact）
- `.novel-ss-tag-filter-clear`（✕ 清除）
- `.novel-ss-tag-manage`（管理弹窗，可复用 `.novel-ss-edit-popup` 结构）
- 指令行内 tag 胶囊布局

**保留**：指令行 / 批量工具栏 / 收藏星标 / 批量重命名弹窗 / 空态提示

**移动端适配**：单列布局天然自适应；面板全屏化逻辑保留

### 3.6 消费方检查

| 文件                                         | 现状                                  | 影响                                |
| -------------------------------------------- | ------------------------------------- | ----------------------------------- |
| [`mark.js`](features/side-story/mark.js:174) | `addFromMessage(userText, {name:""})` | 不传 tag → 默认无 tag，**无需改动** |
| [`index.js`](index.js:263)                   | `createCommandLibCore` 装配           | 签名不变，**无需改动**              |
| [`index.js`](index.js:331)                   | `deleteCommand`                       | 保留，**无需改动**                  |

## 四、实施步骤（Todo）

1. **数据层**：`command-lib.js` 迁移 `categories` → `tags`（多对多 `tagIds`）
2. **数据迁移**：惰性一次性迁移旧 `categories` → `tags`（拍平层级，指令 `categoryId` → `tagIds`），迁移后清理 `categories`
3. **UI 布局**：`panel.js` 去掉左右分栏，改为单列流式布局
4. **Toolbar**：新增「管理 tag」按钮 + tag 管理弹窗（新增/重命名/删除）
5. **tag 筛选**：搜索栏旁 tag 下拉选择框（全部/未标记/各 tag）+ ✕ 清除，与搜索 AND 叠加
6. **指令行**：显示 tag 胶囊（点击跳转筛选），保留点击填入/收藏/重命名/删除
7. **删除分类树逻辑**：移除 `renderTree` / 展开收起 / 置顶 / 分类拖拽 / 指令拖拽归类 / 新建子分类 / 未分类节点
8. **保留功能适配**：收藏视图 / 搜索 / 批量操作 / txt 导入 / 新建指令（默认无 tag）
9. **样式**：`style.css` 移除双栏样式，新增 tag 胶囊 / 管理弹窗 / 筛选样式，移动端适配
10. **消费方检查**：`mark.js` / `index.js` 适配确认
11. **测试验证**：迁移、tag 增删改、筛选、搜索叠加、批量操作等场景手动测试

## 五、风险与注意

- **迁移幂等**：`ensureMigration` 必须保证只执行一次，且旧数据缺失时容错
- **同名 tag**：`createTag` / `renameTag` 需查重（trim 后一致拒绝）
- **删除 tag**：必须同步清理所有指令的 `tagIds`，避免脏引用
- **搜索兼容**：搜索框按 text/name 模糊匹配逻辑保留，tag 筛选用下拉框独立控制，两者 AND
- **收藏视图**：作为 tag 下拉固定选项保留，避免功能回退
