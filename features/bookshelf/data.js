// features/bookshelf/data.js
// 数据获取层：全部角色、某角色聊天列表、完整消息数组。
// 依赖注入 deps：getStContext / getRequestHeaders / getPastCharacterChatsFunc

/**
 * 获取全部角色列表。
 * @param {object} deps 依赖注入
 * @returns {Array<object>} 角色数组（元素含 avatar/name/chat 等字段）
 */
export function getCharactersCore(deps) {
  const ctx = deps.getStContext();
  return Array.isArray(ctx?.characters) ? ctx.characters : [];
}

/**
 * 获取指定角色（按角色索引）的聊天列表。
 * 优先 ST 内置 getPastCharacterChats（带缓存），失败时回退 /api/characters/chats。
 * @param {object} deps 依赖注入
 * @param {number} charIdx 角色索引
 * @param {string} avatar 角色头像文件名（用于回退 API）
 * @returns {Promise<Array>} 聊天数组，每项含 file_name / chat_items / last_mes / file_size 等
 */
export async function getCharChatsCore(deps, charIdx, avatar) {
  const getChats = deps.getPastCharacterChatsFunc?.();
  if (typeof getChats === "function") {
    try {
      const list = await getChats(charIdx);
      if (Array.isArray(list) && list.length) return list;
    } catch (err) {
      console.warn("[NovelReader] getPastCharacterChats 失败，回退 API:", err);
    }
  }
  // 回退：POST /api/characters/chats
  const headers = deps.getRequestHeaders();
  try {
    const res = await fetch("/api/characters/chats", {
      method: "POST",
      headers,
      body: JSON.stringify({ avatar_url: avatar }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } catch (err) {
    console.warn("[NovelReader] 聊天列表 API 失败:", err);
    return [];
  }
}

/**
 * 获取某聊天完整消息数组（POST /api/chats/get）。
 * 注意：file_name 必须带 .jsonl 扩展名。
 * @param {object} deps 依赖注入
 * @param {string} avatar 角色头像文件名
 * @param {string} fileName 聊天文件名（带 .jsonl）
 * @returns {Promise<Array<object>>} 消息数组（mes.name / mes.is_user / mes.mes 等）
 */
export async function getChatMessagesCore(deps, avatar, fileName) {
  const headers = deps.getRequestHeaders();
  try {
    const res = await fetch("/api/chats/get", {
      method: "POST",
      headers,
      body: JSON.stringify({ avatar_url: avatar, file_name: fileName }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } catch (err) {
    console.warn("[NovelReader] 读取聊天内容失败:", avatar, fileName, err);
    return [];
  }
}
