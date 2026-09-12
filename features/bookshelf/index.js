// features/bookshelf/index.js
// 书架功能聚合入口：组装数据层 + 缓存 + UI 层，导出 createBookshelfCore。
// 依赖注入 deps（由 index.js 提供）：
//   getStContext / getRequestHeaders / getPastCharacterChatsFunc / getChatMessages 等

import { createChatCacheCore } from "./cache.js";
import {
  getCharactersCore,
  getCharChatsCore,
  getChatMessagesCore,
} from "./data.js";
import { createBookshelfUI } from "./ui.js";

/**
 * 创建书架核心。
 * @param {object} deps 依赖注入
 * @returns {object} 书架 API
 */
export function createBookshelfCore(deps) {
  const { cfmT = (t) => t } = deps;

  // 聊天列表缓存（TTL 60s）
  const chatCache = createChatCacheCore({
    ttl: 60_000,
    fetcher: (avatar) => {
      const chars = getCharactersCore(deps);
      const idx = chars.findIndex((c) => c.avatar === avatar);
      return getCharChatsCore(deps, idx >= 0 ? idx : 0, avatar);
    },
  });

  // UI 核心
  const ui = createBookshelfUI({
    getCharacters: () => getCharactersCore(deps),
    getCharChats: (charIdx, avatar) =>
      chatCache.get(avatar || deps.getCharacters?.()[charIdx]?.avatar),
    onSelectChar: (charIdx, char) => {
      ui.renderChats(deps.getChatsContainer?.(), charIdx, char);
    },
    onSelectChat: (char, chat) => {
      deps.onOpenChat?.(char, chat);
    },
    cfmT,
  });

  /**
   * 渲染整个书架（角色列表 + 聊天列表）。
   * @param {HTMLElement} charsContainer 角色列表容器
   * @param {HTMLElement} chatsContainer 聊天列表容器
   */
  function render(charsContainer, chatsContainer) {
    ui.bindEvents(charsContainer, chatsContainer);
    ui.renderCharacters(charsContainer);
  }

  return {
    render,
    getCharacters: () => getCharactersCore(deps),
    getCharChats: (charIdx, avatar) =>
      chatCache.get(avatar || getCharactersCore(deps)[charIdx]?.avatar),
    getChatMessages: (avatar, fileName) =>
      getChatMessagesCore(deps, avatar, fileName),
    invalidate: (avatar) => chatCache.invalidate(avatar),
    clearCache: () => chatCache.clear(),
  };
}
