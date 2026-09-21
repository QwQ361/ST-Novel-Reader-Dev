# 小说阅读器：批量重命名操作（增加/删除前后缀、逐个重命名）可复用总结

> 面向新插件「酒馆小说阅读器」的批量重命名功能代码复用清单。
> 本文件聚焦 **CFM（AAAA-ST-Folder-Manager-V2）中不涉及酒馆原生资源的批量重命名实现**（增加前缀 / 增加后缀 / 删除前缀 / 删除后缀 / 逐个重命名），可直接照搬或改造复用。
>
> ⚠️ **明确不涉及**：聊天记录文件的真实改名（`renameGroupOrCharacterChatFunc` / `ctx.renameChat`）、`chatGroups` 文件夹映射、`pinnedChats` 置顶、备注迁移等酒馆原生资源 API。本文档只总结**纯前端 UI / 字符串算法 / 批量执行模式**三部分。

---

## 0. 总览：批量重命名的五种操作

CFM 的批量重命名弹窗支持以下 5 种操作（来源：[`features/chatlogs/rename.js`](../features/chatlogs/rename.js) L253-414）：

| 操作       | action 值    | 说明                               |
| ---------- | ------------ | ---------------------------------- |
| 增加前缀   | `add-prefix` | 在 baseName 前面加一段文本         |
| 增加后缀   | `add-suffix` | 在 baseName 后面加一段文本         |
| 删除前缀   | `del-prefix` | 去掉开头的公共前缀（支持自动检测） |
| 删除后缀   | `del-suffix` | 去掉结尾的公共后缀（支持自动检测） |
| 逐个重命名 | `individual` | 每行单独指定新名称，留空则跳过     |

**整体设计**：弹窗（收集意图）与执行（真正改名）严格分离。

- 弹窗只返回结果对象：`{ mode:"batch", action, text }` 或 `{ mode:"individual", renameMap }`
- 执行层拿到结果后再遍历计算新名字并调用真正的改名函数
- 这样弹窗 + 算法 + 执行模式可以 100% 复用，只需替换"真正改名的函数"

---

## 1. 文件拆分工具函数（纯字符串，直接抄）

来源：[`features/chatlogs/api.js`](../features/chatlogs/api.js) L3-20

把 `xxx.jsonl` 拆成 `baseName`（无扩展名部分）与 `ext`（扩展名部分），这样加/删前后缀只作用于 baseName，扩展名永远保留：

```js
function splitChatlogFileName(fileName) {
  const safeName = String(fileName || "");
  const lastDot = safeName.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === safeName.length - 1) {
    return { fullName: safeName, baseName: safeName, ext: "", displayName: safeName };
  }
  return {
    fullName: safeName,
    baseName: safeName.slice(0, lastDot),
    ext: safeName.slice(lastDot),           // 含点，如 ".jsonl"
    displayName: safeName.slice(0, lastDot),
  };
}
```

> 阅读器改造：若你的书架/收藏名**不带扩展名**，可直接用 `{ baseName: name, ext: "" }` 或简化为 `String(name || "")`。

---

## 2. 自动检测公共前缀 / 公共后缀（纯算法，直接抄）

### 2.1 核心算法

来源：[`features/backgrounds/rename.js`](../features/backgrounds/rename.js) L435-458

```js
// 求公共前缀（传入 baseName 数组）
function findCommonPrefix(names) {
  if (names.length === 0) return "";
  let prefix = names[0];
  for (let i = 1; i < names.length; i++) {
    while (names[i].indexOf(prefix) !== 0) {
      prefix = prefix.substring(0, prefix.length - 1);  // 逐个砍掉末尾字符
      if (!prefix) return "";
    }
  }
  return prefix;
}

// 求公共后缀（技巧：先把每个字符串反转，求公共前缀，再反转回来）
function findCommonSuffix(names) {
  if (names.length === 0) return "";
  const reversed = names.map((name) => name.split("").reverse().join(""));
  let suffix = reversed[0];
  for (let i = 1; i < reversed.length; i++) {
    while (reversed[i].indexOf(suffix) !== 0) {
      suffix = suffix.substring(0, suffix.length - 1);
      if (!suffix) return "";
    }
  }
  return suffix.split("").reverse().join("");
}
```

**算法要点**：

- 公共前缀：以第一个名为初始值，逐个与后续名字比较，`indexOf !== 0` 就砍掉末尾一个字符，直到匹配或为空。
- 公共后缀：**反转后复用求前缀逻辑**，再反转回来，避免单独写一套逻辑。
- 时间复杂度 O(N×L)，对批量选中（通常十几个）足够快。

### 2.2 在弹窗中的用法

来源：[`features/chatlogs/rename.js`](../features/chatlogs/rename.js) L331-363

删除前缀/后缀操作时，自动检测公共前后缀，渲染成**可点击胶囊**，点击直接填入输入框：

```js
// 选择 del-prefix 时：
const baseNames = names.map((n) => splitChatlogFileName(n).baseName);
const commonPrefix = findCommonPrefix(baseNames);
if (commonPrefix) {
  detected.html(
    `<span class="cfm-rename-detect-item" data-value="${escapeHtml(commonPrefix)}">${escapeHtml(commonPrefix)}</span>`,
  );
  autoDetect.show();
} else {
  detected.html('<span class="cfm-rename-detect-none">未检测到公共前缀</span>');
  autoDetect.show();
}
// del-suffix 同理，用 findCommonSuffix
```

```js
// 点击胶囊 → 填入输入框
overlay.on("click", ".cfm-rename-detect-item", function () {
  overlay.find("#cfm-chatlog-rename-text").val($(this).data("value"));
});
```

### 2.3 检测胶囊 CSS（照抄级）

来源：[`style.css`](../style.css) L5343-5375

```css
.cfm-rename-auto-detect { display: flex; flex-direction: column; gap: 6px; }

.cfm-rename-detect-item {
  background: rgba(137, 180, 250, 0.15);
  color: #89b4fa;
  padding: 2px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
}
.cfm-rename-detect-item:hover { background: rgba(137, 180, 250, 0.3); }

.cfm-rename-detect-none {
  color: #a6adc8;
  font-size: 12px;
  opacity: 0.8;
}
```

---

## 3. 批量重命名弹窗（JS，Promise 模式）

来源：[`features/chatlogs/rename.js`](../features/chatlogs/rename.js) L253-414

### 3.1 弹窗结构

```html
<div class="cfm-edit-popup-overlay">
  <div class="cfm-edit-popup">
    <div class="cfm-edit-popup-title">批量重命名聊天记录</div>

    <!-- ① 名称预览列表 -->
    <div class="cfm-edit-popup-names">…前 5 个 + "...等共 N 个"…</div>

    <!-- ② 操作类型下拉 -->
    <div class="cfm-edit-popup-field">
      <label>操作类型</label>
      <select class="cfm-edit-input" id="cfm-chatlog-rename-action">
        <option value="add-prefix">增加前缀</option>
        <option value="add-suffix">增加后缀</option>
        <option value="del-prefix">删除前缀</option>
        <option value="del-suffix">删除后缀</option>
        <option value="individual">逐个重命名</option>
      </select>
    </div>

    <!-- ③ 文本输入区（前 4 种操作共用） -->
    <div class="cfm-edit-popup-field" id="cfm-chatlog-rename-text-field">
      <label id="cfm-chatlog-rename-text-label">前缀内容</label>
      <input type="text" class="cfm-edit-input" id="cfm-chatlog-rename-text" placeholder="输入前缀内容">
    </div>

    <!-- ④ 自动检测公共前后缀区（仅 del-prefix / del-suffix 显示） -->
    <div class="cfm-edit-popup-field cfm-rename-auto-detect" style="display:none;">
      <label>自动检测到的公共前/后缀</label>
      <div id="cfm-chatlog-rename-detected" class="cfm-rename-detected"></div>
    </div>

    <!-- ⑤ 逐个重命名表格区（仅 individual 显示） -->
    <div class="cfm-rename-individual-field" id="cfm-chatlog-rename-individual-field">
      <label>逐个指定新名称（留空则不修改）</label>
      <div class="cfm-rename-individual-list">…每行一个…</div>
    </div>

    <div class="cfm-edit-popup-actions">
      <button class="cfm-btn cfm-edit-popup-cancel">取消</button>
      <button class="cfm-btn cfm-edit-popup-confirm">确认</button>
    </div>
  </div>
</div>
```

### 3.2 弹窗 UI 动态切换逻辑（核心）

来源：[`rename.js`](../features/chatlogs/rename.js) L296-367

**关键点**：用 `updateRenameUI()` 一个函数统一控制 ③④⑤ 三个区的显隐与文案，切换操作类型时立即刷新：

```js
function updateRenameUI() {
  const action = overlay.find("#cfm-chatlog-rename-action").val();
  const textLabel = overlay.find("#cfm-chatlog-rename-text-label");
  const textInput = overlay.find("#cfm-chatlog-rename-text");
  const autoDetect = overlay.find(".cfm-rename-auto-detect");
  const detected = overlay.find("#cfm-chatlog-rename-detected");
  const textField = overlay.find("#cfm-chatlog-rename-text-field");
  const individualField = overlay.find("#cfm-chatlog-rename-individual-field");
  const namesBlock = overlay.find(".cfm-edit-popup-names");

  if (action === "individual") {
    // 只显示逐个重命名表格，隐藏其它
    textField.hide();
    autoDetect.hide();
    namesBlock.hide();
    individualField.show();
    individualField.find(".cfm-rename-new-input").first().focus();
  } else {
    // 显示文本输入区
    individualField.hide();
    textField.show();
    namesBlock.show();
    if (action === "add-prefix") {
      textLabel.text("前缀内容");
      textInput.attr("placeholder", "输入要添加的前缀");
      autoDetect.hide();
    } else if (action === "add-suffix") {
      textLabel.text("后缀内容");
      textInput.attr("placeholder", "输入要添加的后缀");
      autoDetect.hide();
    } else if (action === "del-prefix") {
      textLabel.text("要删除的前缀");
      textInput.attr("placeholder", "输入要删除的前缀，或点击下方自动检测结果");
      // ……此处自动检测公共前缀并渲染（见 §2.2）……
    } else if (action === "del-suffix") {
      textLabel.text("要删除的后缀");
      textInput.attr("placeholder", "输入要删除的后缀，或点击下方自动检测结果");
      // ……此处自动检测公共后缀并渲染（见 §2.2）……
    }
  }
}
// 绑定：切换下拉即刷新
overlay.find("#cfm-chatlog-rename-action").on("change", updateRenameUI);
updateRenameUI();
```

### 3.3 Promise 模式与结果返回

来源：[`rename.js`](../features/chatlogs/rename.js) L373-414

```js
return new Promise((resolve) => {
  overlay.find(".cfm-edit-popup-cancel").on("click", () => {
    overlay.remove();
    resolve(null);
  });
  // 遮罩点击关闭（校验 target 类名，避免点卡片内部误关）
  overlay.find(".cfm-edit-popup-overlay").on("click", (e) => {
    if ($(e.target).hasClass("cfm-edit-popup-overlay")) {
      overlay.remove();
      resolve(null);
    }
  });
  overlay.find(".cfm-edit-popup-confirm").on("click", () => {
    const action = overlay.find("#cfm-chatlog-rename-action").val();
    if (action === "individual") {
      // 收集逐个重命名的映射：留空的行不收集
      const renameMap = {};
      overlay.find(".cfm-rename-individual-row").each(function () {
        const input = $(this).find(".cfm-rename-new-input");
        const oldName = input.data("old-name");
        const newBaseName = input.val().trim();
        const ext = String(input.data("ext") || "");
        if (newBaseName) renameMap[oldName] = `${newBaseName}${ext}`;
      });
      overlay.remove();
      resolve({ mode: "individual", renameMap });
    } else {
      const text = overlay.find("#cfm-chatlog-rename-text").val().trim();
      overlay.remove();
      resolve({ mode: "batch", action, text });
    }
  });
  // 键盘：Enter 确认 / Escape 取消
  overlay.find("#cfm-chatlog-rename-text").on("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); overlay.find(".cfm-edit-popup-confirm").trigger("click"); }
    if (e.key === "Escape") { overlay.find(".cfm-edit-popup-cancel").trigger("click"); }
  });
});
```

**返回值设计（关键接口）**：

- 批量操作 → `resolve({ mode: "batch", action: "add-prefix"|"add-suffix"|"del-prefix"|"del-suffix", text: "输入内容" })`
- 逐个重命名 → `resolve({ mode: "individual", renameMap: { 旧名: 新名, … } })`
- 取消 → `resolve(null)`

---

## 4. 逐个重命名表格（JS + CSS）

### 4.1 行渲染

来源：[`rename.js`](../features/chatlogs/rename.js) L253-258

```js
const individualListHtml = nameMeta
  .map((item) =>
    `<div class="cfm-rename-individual-row">` +
      `<span class="cfm-rename-old-name" title="${escapeHtml(item.fullName)}">${escapeHtml(item.displayName)}</span>` +
      `<span class="cfm-rename-arrow">→</span>` +
      `<input type="text" class="cfm-rename-new-input" placeholder="留空则不修改" data-old-name="${escapeHtml(item.fullName)}" data-ext="${escapeHtml(item.ext)}" value="">` +
    `</div>`,
  )
  .join("");
```

> 每行用 `data-old-name`（原完整名）与 `data-ext`（扩展名）携带数据，确认时从 `data-*` 读取，无需闭包捕获。

### 4.2 CSS（照抄级）

来源：[`style.css`](../style.css) L5377-5442

```css
/* 表格容器：限高滚动 */
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
.cfm-rename-arrow {
  color: #a6adc8;
  font-size: 12px;
  flex-shrink: 0;
}
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
.cfm-rename-new-input:focus {
  border-color: #89b4fa;
  outline: none;
}
```

### 4.3 名称预览列表（≤5 个 + 折叠提示）

来源：[`rename.js`](../features/chatlogs/rename.js) L180-195

```js
const nameListHtml =
  nameMeta.length <= 5
    ? nameMeta.map((item) =>
        `<div class="cfm-edit-name-item" title="${escapeHtml(item.fullName)}">${escapeHtml(item.displayName)}</div>`).join("")
    : nameMeta.slice(0, 5).map((item) =>
        `<div class="cfm-edit-name-item" title="${escapeHtml(item.fullName)}">${escapeHtml(item.displayName)}</div>`).join("") +
      `<div class="cfm-edit-name-item cfm-edit-name-more">...等共 ${nameMeta.length} 个聊天记录</div>`;
```

预览列表 CSS（来源：[`style.css`](../style.css) L4313-4333）：

```css
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
```

---

## 5. 批量执行逻辑（五种操作的计算 + 统计汇总）

来源：[`rename.js`](../features/chatlogs/rename.js) L417-549

### 5.1 新名字计算（核心：加/删前后缀）

```js
const { baseName, ext } = splitChatlogFileName(oldName);

if (action === "add-prefix") {
  newName = text + baseName + ext;                 // 前缀 + 原名 + 扩展名
} else if (action === "add-suffix") {
  newName = baseName + text + ext;                 // 原名 + 后缀 + 扩展名
} else if (action === "del-prefix") {
  if (!baseName.startsWith(text)) { skipped++; continue; }  // 不匹配就跳过
  newName = baseName.substring(text.length) + ext;          // 砍掉前缀
} else if (action === "del-suffix") {
  if (!baseName.endsWith(text)) { skipped++; continue; }    // 不匹配就跳过
  newName = baseName.substring(0, baseName.length - text.length) + ext;
}
```

**要点**：
- 所有操作都**只改 baseName，保留 ext**，避免破坏扩展名。
- 删除操作先校验 `startsWith` / `endsWith`，不匹配的项**跳过**而非报错。
- 使用 `String.prototype.substring` 而非 `slice` 均可，注意字符按 code unit 切割，中文无影响。

### 5.2 批量执行 + 统计汇总模式

```js
async function executeBatchRename(names, result) {
  let success = 0, skipped = 0, failed = 0;

  async function renameOne(oldName, newName) {
    if (!newName) return "skip-empty";
    if (newName === oldName) return "skip-same";
    const ok = await doRename(oldName, newName);   // ← 替换成你的业务
    return ok ? "success" : "failed";
  }

  if (result.mode === "single") {
    // 单条：直接改，给 toastr 反馈
    const renamed = await renameOne(names[0], result.newName);
    if (renamed.status === "skip-same") { cfmToastr.info("名称未变更"); return; }
    if (renamed.status === "success") cfmToastr.success(`已将「...」重命名为「...」`);
    else cfmToastr.error("重命名失败");
    return;
  }

  if (result.mode === "batch") {
    const { action, text } = result;
    if (!text) { cfmToastr.warning("请输入内容"); return; }
    for (const oldName of names) {
      let newName;
      // ……用 §5.1 的计算逻辑得到 newName（含 skipped++）……
      const renamed = await renameOne(oldName, newName);
      if (renamed.status === "success") success++;
      else if (renamed.status === "skip-empty" || renamed.status === "skip-same") skipped++;
      else failed++;
    }
    let msg = `批量重命名完成：成功 ${success} 个`;
    if (skipped > 0) msg += `，跳过 ${skipped} 个`;
    if (failed > 0) msg += `，失败 ${failed} 个`;
    if (success > 0) cfmToastr.success(msg);
    else if (failed > 0) cfmToastr.warning(msg);
    else cfmToastr.info(msg);
    return;
  }

  if (result.mode === "individual") {
    const { renameMap } = result;
    // 遍历 renameMap，对每个有值的旧名改名，统计同上
    for (const oldName of names) {
      const newName = renameMap[oldName];
      if (!newName) { skipped++; continue; }
      const renamed = await renameOne(oldName, newName);
      // ……统计同上，最后 toastr 汇总……
    }
  }
}
```

**复用要点**：
- `renameOne` 统一封装"跳过 / 成功 / 失败"三种状态判定。
- toastr 按"有无成功 / 有无失败"分级：成功>0 → success，失败>0 → warning，全跳过 → info。
- **真正改数据的只有 `doRename` 一处**，替换成你自己的存储读写即可，其余 100% 复用。

---

## 6. 弹窗通用 CSS（遮罩 / 卡片 / 输入 / 按钮）

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

/* 字段区 */
.cfm-edit-popup-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.cfm-edit-popup-field label {
  font-size: 12px;
  color: #a6adc8;
}

/* 输入框 / 下拉 */
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

---

## 7. 给小说阅读器的落地建议

### 7.1 直接照搬清单

| # | 复用内容 | 来源 | 依赖酒馆原生? |
|---|---|---|---|
| 1 | 文件拆分 `splitChatlogFileName` | `features/chatlogs/api.js` L3-20 | 否 |
| 2 | 公共前/后缀检测 `findCommonPrefix/Suffix` | `features/backgrounds/rename.js` L435-458 | 否 |
| 3 | 批量弹窗 Promise 骨架 + `updateRenameUI` 动态切换 | `features/chatlogs/rename.js` L253-414 | 否 |
| 4 | 检测胶囊 + 点击填入 | `rename.js` L331-363 + `style.css` L5343-5375 | 否 |
| 5 | 逐个重命名表格 | `rename.js` L253-258 + `style.css` L5377-5442 | 否 |
| 6 | 新名字计算（加/删前后缀） | `rename.js` L478-497 | 否 |
| 7 | 批量执行统计 + toastr 汇总 | `rename.js` L417-549 | 否 |
| 8 | 弹窗遮罩/卡片/输入/按钮 CSS | `style.css` L4183-4426 | 否 |

### 7.2 需要替换的部分

- **`doRename(oldName, newName)`**：换成你自己的书架/收藏存储读写（**不涉及酒馆原生资源**）。
- **`splitChatlogFileName`**：如果名字不带扩展名，简化成 `String(name || "")`。
- **`renameOne` 里的备注/chatGroups 迁移**：`rename.js` 中 `renameChatFile`（L75-116）调用了酒馆原生 `renameGroupOrCharacterChatFunc` / `ctx.renameChat`，**不要照抄**；若你的业务需要同步迁移自己存储里的关联数据，用你自己的逻辑替代。

### 7.3 最小可跑示例（组装思路）

```js
async function showBatchRename(names) {
  const result = await showBatchRenamePopup(names);   // §3 弹窗，返回结果或 null
  if (!result) return;
  await executeBatchRename(names, result);            // §5 执行，内部只调你的 doRename
  renderMyList();                                     // 你的列表重绘
}
```

> 整个"批量重命名"能力 = 弹窗（§3）+ 算法（§2/§5.1）+ 执行统计（§5.2）+ CSS（§4.2/§6），四块互相解耦、全部不依赖酒馆原生资源，可直接移植。
