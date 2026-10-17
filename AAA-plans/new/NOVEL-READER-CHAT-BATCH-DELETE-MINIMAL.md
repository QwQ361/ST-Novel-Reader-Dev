# 小说阅读器 · 聊天记录批量删除（最基础实现）

> 本文档只讲「最基础、最基础」的聊天记录批量删除：勾选 → 确认 → 逐条删除 → 刷新。
> 剥离了 CFM 的框选、全选、进度遮罩、备注清理、缓存失效等增强，只保留能跑通的最小链路。
> 来源：`ui/views/chat-sublist.js`（批量 UI）+ `features/chatlogs/import-export.js`（删除核心）。

---

## 一、整体链路（最基础版）

```
勾选若干条聊天
   ↓
点击「删除」按钮
   ↓
confirm() 确认
   ↓
for 循环逐条调用删除 API
   ↓
刷新列表
```

**核心只有三件事：**
1. 用一个 `Set` 记住勾选了哪些聊天（用 `avatar::fileName` 作为唯一键）
2. 确认后 for 循环逐条删
3. 删完重新渲染列表

---

## 二、唯一键约定

CFM 用 **`avatar::fileName`** 作为一条聊天的唯一标识（跨角色也能区分）：

```js
const batchKey = `${avatar}::${chatName}`;   // 例："某个角色卡::2024-01-01 12:30"
```

- `avatar`：角色卡的 avatar 名（文件路径名）
- `chatName`：聊天文件名，**去掉 `.jsonl` 后缀**（`file_name.replace(".jsonl", "")`）

选中集合就是一个 `Set`：

```js
const selected = new Set();          // Set<string>，存 "avatar::chatName"
selected.add(`${avatar}::${chatName}`);  // 勾选
selected.delete(`${avatar}::${chatName}`); // 取消勾选
```

---

## 三、删除按钮 + 确认（最基础版）

```js
deleteBtn.on("click", async () => {
  // 1. 过滤出当前角色名下的选中项（只删本角色的聊天）
  const toDelete = Array.from(selected).filter((k) => k.startsWith(avatar + "::"));

  // 2. 空选保护
  if (toDelete.length === 0) {
    toastr.warning("请先选择要删除的聊天记录");
    return;
  }

  // 3. 确认（cfmConfirm 本质就是原生 confirm + 简繁转换）
  if (!confirm(`确定要删除选中的 ${toDelete.length} 条聊天记录吗？\n此操作不可撤销！`)) {
    return;
  }

  // 4. 逐条删除
  let successCount = 0;
  for (const key of toDelete) {
    const fn = key.split("::")[1];               // 取出文件名
    if (await deleteChatFile(avatar, fn)) successCount++;
  }

  // 5. 反馈 + 刷新
  toastr.success(`已删除 ${successCount} 条聊天记录`);
  renderList();                                   // 重新渲染当前列表
});
```

> 上面的 `cfmConfirm(msg)` 等价于 [`ui/dialogs/confirm.js`](ui/dialogs/confirm.js:3) 的 `deps.confirm(deps.translate(msg))`，即原生 `confirm()`。最基础版直接用 `confirm()` 即可。

---

## 四、核心删除函数 `deleteChatFile`（最基础版）

来源：[`features/chatlogs/import-export.js`](features/chatlogs/import-export.js:28) L28-87。

CFM 原版做了「先试酒馆原生函数 → 失败回退 API」+ 备注清理 + 批量选中移除 + 缓存失效。**最基础版只需保留 API 删除**：

```js
async function deleteChatFile(avatar, chatFileName) {
  // 1. 找到角色索引（API 需要字符下标，或用 avatar 也行）
  const characters = getCharacters();               // 酒馆原生：拿全部角色
  const charIdx = characters.findIndex((c) => c.avatar === avatar);
  if (charIdx < 0) return false;

  // 2. 文件名去掉 .jsonl 后缀（API 期望带完整名，这里拼回去）
  const fileNameNoExt = chatFileName.replace(/\.jsonl$/i, "");

  // 3. 直接调酒馆原生删除接口
  const ctx = getContext();                          // 酒馆原生上下文
  const response = await fetch("/api/chats/delete", {
    method: "POST",
    headers: ctx.getRequestHeaders(),               // 带 CSRF/认证头
    body: JSON.stringify({
      chatfile: fileNameNoExt + ".jsonl",          // 完整文件名
      avatar_url: avatar,                          // 角色 avatar 名
    }),
  });

  return response.ok;                               // 成功返回 true
}
```

### 关键 API

| 项 | 值 |
|---|---|
| 端点 | `POST /api/chats/delete` |
| 请求体 | `{ chatfile: "xxx.jsonl", avatar_url: "角色avatar名" }` |
| 请求头 | `ctx.getRequestHeaders()`（酒馆上下文，含必要认证） |
| 返回 | `response.ok`（HTTP 200 即成功） |

### 关于酒馆原生函数（可选，非必须）

CFM 优先调用酒馆原生 `deleteCharacterChatByName(charIdx, fileNameNoExt)`，失败才回退 API。来源 [`integrations/sillytavern.js`](integrations/sillytavern.js:33)：

```js
deleteCharacterChatByNameFunc = scriptModule.deleteCharacterChatByName;
```

**最基础版可以完全不用它**，直接走 `/api/chats/delete` 即可，两个原因：
1. 原生函数签名（charIdx + 无后缀名）容易踩坑
2. 直接 API 调用最直观，且 CFM 本身就把它当「回退方案」——说明它足够可靠

---

## 五、CFM 原版的增强项（不必照搬，按需加）

| 增强 | 位置 | 说明 |
|---|---|---|
| 全选/全不选按钮 | `chat-sublist.js` L162-176 | 遍历当前列表 add/delete 到 Set |
| 框选（shift 区间） | `chat-sublist.js` L177-182 | 额外一个 range 状态 |
| 进度遮罩 | `showBatchProgressOverlay` → `features/transfer/entries.js` L1229 | `actionLabel + total`，循环里 `update(processed)` |
| 备注清理 | `import-export.js` L72-77 | 删除后同步删 `cfmChatNotes` |
| 缓存失效 | `import-export.js` L80 | `invalidateChatCache(avatar)` 删后重建缓存 |
| 批量选中移除 | `import-export.js` L79 | 删成功后从 Set 移除 |

> 小说阅读器做「最基础」版时，以上全部可以省略。真正需要的只有：Set 选中的、`confirm()`、for 循环调 `/api/chats/delete`、`renderList()`。

---

## 六、单条删除（顺带）

同文件 [`ui/views/chat-sublist.js`](ui/views/chat-sublist.js:412) L412-414，就是复用同一个 `deleteChatFile`：

```js
if (await deleteChatFile(avatar, chatName)) {
  toastr.success(`已删除: ${chatName}`);
}
```

---

## 七、小说阅读器落地（最基础版代码骨架）

```js
// ===== 状态 =====
const selectedChats = new Set();   // "avatar::chatName"

// ===== 勾选切换 =====
function toggleChat(avatar, chatName) {
  const key = `${avatar}::${chatName}`;
  if (selectedChats.has(key)) selectedChats.delete(key);
  else selectedChats.add(key);
  renderList();
}

// ===== 批量删除 =====
async function batchDeleteChats(avatar) {
  const toDelete = Array.from(selectedChats).filter((k) => k.startsWith(avatar + "::"));
  if (toDelete.length === 0) { toastr.warning("请先选择"); return; }
  if (!confirm(`删除 ${toDelete.length} 条聊天？不可撤销！`)) return;

  let ok = 0;
  for (const key of toDelete) {
    const fn = key.split("::")[1];
    if (await deleteChatFile(avatar, fn)) ok++;
  }
  toastr.success(`已删除 ${ok} 条`);
  renderList();
}

// ===== 核心删除（见第四节） =====
async function deleteChatFile(avatar, chatFileName) {
  const fileNameNoExt = chatFileName.replace(/\.jsonl$/i, "");
  const response = await fetch("/api/chats/delete", {
    method: "POST",
    headers: getContext().getRequestHeaders(),
    body: JSON.stringify({ chatfile: fileNameNoExt + ".jsonl", avatar_url: avatar }),
  });
  return response.ok;
}
```

---

## 附：涉及文件清单

| 文件 | 关键位置 | 作用 |
|---|---|---|
| `ui/views/chat-sublist.js` | L124-131 批量模式开关、L141-176 全选、L259-290 批量删除按钮 | 批量删除 UI |
| `features/chatlogs/import-export.js` | L28-87 `deleteChatFile` | 删除核心 |
| `integrations/sillytavern.js` | L33 `deleteCharacterChatByName` | 酒馆原生删除函数（可选） |
| `ui/dialogs/confirm.js` | L3-4 `cfmConfirmCore` | 确认弹窗（本质 confirm） |
| `features/transfer/entries.js` | L1229 `showBatchProgressOverlay` | 进度遮罩（可选增强） |
