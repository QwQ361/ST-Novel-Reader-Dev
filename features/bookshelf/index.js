// features/bookshelf/index.js
// 书架功能聚合入口：组装数据层 + 缓存，导出 createBookshelfCore。
// 依赖注入 deps（由 index.js 提供）：
//   getStContext / getRequestHeaders / getPastCharacterChatsFunc / getChatMessages 等
// 注意：UI 层已由 index.js 的状态机全屏 UI 接管（角色卡片网格 / 聊天卡片），
//       本模块只负责数据获取与缓存。

import { createChatCacheCore } from "./cache.js";
import {
  getCharactersCore,
  getCharChatsCore,
  getChatMessagesCore,
} from "./data.js";

/**
 * 创建书架核心（数据层）。
 * @param {object} deps 依赖注入
 * @returns {object} 书架 API
 */
export function createBookshelfCore(deps) {
  // 聊天列表缓存（TTL 60s）
  const chatCache = createChatCacheCore({
    ttl: 60_000,
    fetcher: (avatar) => {
      const chars = getCharactersCore(deps);
      const idx = chars.findIndex((c) => c.avatar === avatar);
      return getCharChatsCore(deps, idx >= 0 ? idx : 0, avatar);
    },
  });

  return {
    getCharacters: () => getCharactersCore(deps),
    getCharChats: (charIdx, avatar) =>
      chatCache.get(avatar || getCharactersCore(deps)[charIdx]?.avatar),
    getChatMessages: (avatar, fileName) =>
      getChatMessagesCore(deps, avatar, fileName),
    invalidate: (avatar) => chatCache.invalidate(avatar),
    clearCache: () => chatCache.clear(),
  };
}
