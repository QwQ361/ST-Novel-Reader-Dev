// features/side-story/command-lib.js
// 番外指令库数据层：分类树（无限层级文件夹式）+ 指令（全局汇总，只存文本）。
// 数据存于 extension_settings[extName].novelSideStory，随 ST 设置自动保存。
// 存储结构：
//   novelSideStory = {
//     categories: {                       // 分类树（文件夹式，参考 CFM）
//       "cat_123": { id, parentId: null, name: "日常番外", sortOrder: 0, pinned: false },
//       "cat_456": { id, parentId: "cat_123", name: "恋爱", sortOrder: 0, pinned: false }
//     },
//     commands: {                         // 指令库（全局，跨聊天汇总）
//       "cmd_789": {
//         id: "cmd_789",
//         text: "（user 指令原文）",
//         name: "可选名称",                 // 用户给指令取的名字
//         categoryId: "cat_123" | null,   // null = 未分类
//         favorite: false,                 // 收藏（指令行星标，置顶显示）
//         createdAt: 1234567890
//       }
//     }
//   }
// 去重：按 user 指令文本（trim 后）完全一致去重。

/** 生成唯一 id（时间戳 + 随机段，可跨标签页防撞） */
function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * 创建番外指令库核心。
 * @param {object} deps 依赖注入
 * @param {string} deps.extName 插件扩展名（用于 extension_settings 命名空间）
 * @param {Function} deps.getSettings   () => object  读取 extension_settings（含目标命名空间）
 * @param {Function} deps.saveSettings  () => void   保存设置（saveSettingsDebounced）
 * @returns {object} command-lib API
 */
export function createCommandLibCore(deps) {
  const { extName, getSettings, saveSettings } = deps;

  /** 读取指令库表（惰性初始化） */
  function table() {
    const s = getSettings();
    if (!s[extName]) s[extName] = {};
    if (!s[extName].novelSideStory) s[extName].novelSideStory = {};
    const t = s[extName].novelSideStory;
    if (!t.categories) t.categories = {};
    if (!t.commands) t.commands = {};
    return t;
  }

  // ---------------- 分类树 ----------------

  /** 列出全部分类（返回分类对象映射副本） */
  function listCategories() {
    return { ...table().categories };
  }

  /**
   * 创建分类。
   * @param {string|null} parentId 父分类 id（null = 顶层）
   * @param {string} name 分类名
   * @returns {object|null} 新分类对象；name 为空或父分类不存在返回 null
   */
  function createCategory(parentId, name) {
    const t = table();
    const n = String(name || "").trim();
    if (!n) return null;
    if (parentId && !t.categories[parentId]) return null;
    const cat = { id: uid("cat"), parentId, name: n, sortOrder: 0 };
    t.categories[cat.id] = cat;
    saveSettings();
    return cat;
  }

  /**
   * 重命名分类。
   * @param {string} id 分类 id
   * @param {string} name 新分类名
   * @returns {boolean} 是否成功
   */
  function renameCategory(id, name) {
    const t = table();
    const cat = t.categories[id];
    if (!cat) return false;
    const n = String(name || "").trim();
    if (!n) return false;
    cat.name = n;
    saveSettings();
    return true;
  }

  /**
   * 删除分类：其下所有子分类递归删除；其下指令归入「未分类」。
   * @param {string} id 分类 id
   * @returns {boolean} 是否成功
   */
  function deleteCategory(id) {
    const t = table();
    if (!t.categories[id]) return false;
    // 收集所有后代 id（含自身）
    const doomed = new Set();
    const collect = (cid) => {
      if (doomed.has(cid)) return;
      doomed.add(cid);
      for (const c of Object.values(t.categories)) {
        if (c.parentId === cid) collect(c.id);
      }
    };
    collect(id);
    // 后代下的指令归入未分类
    for (const cmd of Object.values(t.commands)) {
      if (doomed.has(cmd.categoryId)) cmd.categoryId = null;
    }
    for (const cid of doomed) delete t.categories[cid];
    saveSettings();
    return true;
  }

  /**
   * 移动分类到新父分类（防环：不能移到自身或其子孙下）。
   * @param {string} id 分类 id
   * @param {string|null} newParentId 新父分类 id（null = 顶层）
   * @returns {boolean} 是否成功
   */
  function moveCategory(id, newParentId) {
    const t = table();
    const cat = t.categories[id];
    if (!cat) return false;
    if (newParentId) {
      if (!t.categories[newParentId]) return false;
      // 防环：newParentId 是 id 的子孙则拒绝
      let cursor = newParentId;
      while (cursor) {
        if (cursor === id) return false;
        cursor = t.categories[cursor]?.parentId ?? null;
      }
    }
    cat.parentId = newParentId;
    saveSettings();
    return true;
  }

  /**
   * 同级重排：把分类 id 移到目标分类 targetId 的前/后（同一父分类下）。
   * 仅允许在 pinned 状态一致的分类之间排序（置顶分类 / 普通分类各自成组）。
   * 防环：targetId 不能是 id 自身或其子孙。
   * @param {string} id 要移动的分类 id
   * @param {string} targetId 目标分类 id
   * @param {"before"|"after"} position 插入到目标前/后
   * @returns {boolean} 是否成功
   */
  function reorderCategory(id, targetId, position) {
    const t = table();
    const cat = t.categories[id];
    const target = t.categories[targetId];
    if (!cat || !target) return false;
    if (id === targetId) return false;
    // 防环：targetId 是 id 的子孙则拒绝
    let cursor = targetId;
    while (cursor) {
      if (cursor === id) return false;
      cursor = t.categories[cursor]?.parentId ?? null;
    }
    // pinned 分组必须一致（置顶分类只能在置顶分类间排序）
    if (Boolean(cat.pinned) !== Boolean(target.pinned)) return false;
    const parentId = target.parentId ?? null;
    cat.parentId = parentId;
    // 收集同级（排除自身），按当前 sortOrder 稳定排序
    const siblings = Object.values(t.categories)
      .filter((c) => (c.parentId ?? null) === parentId && c.id !== id)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const idx = siblings.findIndex((c) => c.id === targetId);
    if (idx < 0) return false;
    const insertAt = position === "before" ? idx : idx + 1;
    siblings.splice(insertAt, 0, cat);
    siblings.forEach((c, i) => {
      c.sortOrder = i;
    });
    saveSettings();
    return true;
  }

  /**
   * 取某分类的全部直接子分类 id（置顶 pinned 排前；同级按 sortOrder 稳定排序）。
   * @param {string|null} parentId 父分类 id（null = 顶层）
   * @returns {Array<string>} 子分类 id 列表
   */
  function getChildCategoryIds(parentId) {
    const t = table();
    return Object.values(t.categories)
      .filter((c) => (c.parentId ?? null) === (parentId ?? null))
      .sort((a, b) => {
        const pa = a.pinned ? 0 : 1;
        const pb = b.pinned ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.sortOrder - b.sortOrder;
      })
      .map((c) => c.id);
  }

  /**
   * 切换分类置顶（pinned）。置顶分类在树中排最前。
   * @param {string} id 分类 id
   * @returns {boolean} 切换后是否为置顶
   */
  function toggleCategoryPin(id) {
    const t = table();
    const cat = t.categories[id];
    if (!cat) return false;
    cat.pinned = !cat.pinned;
    saveSettings();
    return cat.pinned;
  }

  /**
   * 取某分类的全部后代 id（含自身）。
   * @param {string} id 分类 id
   * @returns {Array<string>} 后代 id 列表（含自身）
   */
  function getDescendantCategoryIds(id) {
    const t = table();
    const out = [];
    const collect = (cid) => {
      out.push(cid);
      for (const c of Object.values(t.categories)) {
        if (c.parentId === cid) collect(c.id);
      }
    };
    collect(id);
    return out;
  }

  // ---------------- 指令 ----------------

  /** 列出全部指令（返回指令对象映射副本） */
  function listCommands() {
    return { ...table().commands };
  }

  /** 列出某分类（含其全部后代分类）下的指令，按创建时间倒序 */
  function listCommandsByCategory(categoryId) {
    const t = table();
    const catIds =
      categoryId == null
        ? null // null = 未分类，仅匹配 categoryId === null
        : new Set(getDescendantCategoryIds(categoryId));
    return Object.values(t.commands)
      .filter((cmd) => {
        const cid = cmd.categoryId ?? null;
        if (categoryId == null) return cid === null;
        return catIds.has(cid);
      })
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /**
   * 创建指令（手动创建 / 导入）。
   * @param {string} text 指令文本
   * @param {object} [options]
   * @param {string} [options.name] 指令名称（可选）
   * @param {string|null} [options.categoryId] 所属分类（null = 未分类）
   * @returns {object|null} 新指令对象；文本为空返回 null
   */
  function createCommand(text, options = {}) {
    const t = table();
    const txt = String(text || "").trim();
    if (!txt) return null;
    const categoryId = options.categoryId ?? null;
    if (categoryId && !t.categories[categoryId]) return null;
    const cmd = {
      id: uid("cmd"),
      text: txt,
      name: String(options.name || "").trim(),
      categoryId,
      favorite: Boolean(options.favorite),
      createdAt: Date.now(),
    };
    t.commands[cmd.id] = cmd;
    saveSettings();
    return cmd;
  }

  /**
   * 按文本内容查重（trim 后完全一致）。
   * @param {string} text 指令文本
   * @returns {boolean} 已存在则 true
   */
  function existsByText(text) {
    const t = table();
    const txt = String(text || "").trim();
    if (!txt) return false;
    return Object.values(t.commands).some(
      (cmd) => String(cmd.text || "").trim() === txt,
    );
  }

  /**
   * 从消息文本加入指令库（番外标注自动入库用；按文本去重）。
   * 未提供名称时自动命名为「未命名-N」（N 为自增序号），避免 name 为空
   * 导致批量重命名时把指令正文误识别为公共前/后缀。
   * @param {string} text 指令文本（user 楼层正文）
   * @param {object} [options] 同 createCommand
   * @returns {object|null} 已存在返回 null（不入库）；新增返回新指令
   */
  function addFromMessage(text, options = {}) {
    if (existsByText(text)) return null;
    let name = String(options.name || "").trim();
    if (!name) {
      let n = 1;
      while (existsByName(`未命名-${n}`)) n += 1;
      name = `未命名-${n}`;
    }
    return createCommand(text, { ...options, name });
  }

  /**
   * 按名称查重（trim 后完全一致）。
   * @param {string} name 指令名称
   * @returns {boolean} 已存在则 true
   */
  function existsByName(name) {
    const t = table();
    const n = String(name || "").trim();
    if (!n) return false;
    return Object.values(t.commands).some(
      (cmd) => String(cmd.name || "").trim() === n,
    );
  }

  /**
   * 更新指令（文本 / 名称 / 分类）。
   * @param {string} id 指令 id
   * @param {object} patch { text?, name?, categoryId? }（categoryId 传 null 表示未分类）
   * @returns {boolean} 是否成功
   */
  function updateCommand(id, patch = {}) {
    const t = table();
    const cmd = t.commands[id];
    if (!cmd) return false;
    if (patch.text !== undefined) {
      const txt = String(patch.text || "").trim();
      if (!txt) return false;
      cmd.text = txt;
    }
    if (patch.name !== undefined) cmd.name = String(patch.name || "").trim();
    if (patch.favorite !== undefined) cmd.favorite = Boolean(patch.favorite);
    if (patch.categoryId !== undefined) {
      const cid = patch.categoryId ?? null;
      if (cid && !t.categories[cid]) return false;
      cmd.categoryId = cid;
    }
    saveSettings();
    return true;
  }

  /**
   * 切换指令收藏，返回切换后是否为已收藏。
   * @param {string} id 指令 id
   * @returns {boolean} 切换后是否为已收藏（失败返回 false）
   */
  function toggleFavorite(id) {
    const t = table();
    const cmd = t.commands[id];
    if (!cmd) return false;
    cmd.favorite = !cmd.favorite;
    saveSettings();
    return cmd.favorite;
  }

  /**
   * 收藏指令列表（按收藏时间倒序）。
   * @returns {Array<object>} 收藏的指令对象数组
   */
  function listFavoriteCommands() {
    const t = table();
    return Object.values(t.commands)
      .filter((cmd) => cmd.favorite)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /** 收藏指令数量 */
  function listFavoriteCount() {
    return Object.values(table().commands).filter((cmd) => cmd.favorite).length;
  }

  /** 删除指令 */
  function deleteCommand(id) {
    const t = table();
    if (!t.commands[id]) return false;
    delete t.commands[id];
    saveSettings();
    return true;
  }

  /** 清空指令库（保留分类树） */
  function clearCommands() {
    table().commands = {};
    saveSettings();
  }

  return {
    listCategories,
    createCategory,
    renameCategory,
    deleteCategory,
    moveCategory,
    reorderCategory,
    toggleCategoryPin,
    getChildCategoryIds,
    getDescendantCategoryIds,
    listCommands,
    listCommandsByCategory,
    createCommand,
    existsByText,
    existsByName,
    addFromMessage,
    updateCommand,
    toggleFavorite,
    listFavoriteCommands,
    listFavoriteCount,
    deleteCommand,
    clearCommands,
  };
}
