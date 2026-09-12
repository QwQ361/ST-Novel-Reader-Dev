// features/bookshelf/ui.js
// 书架 UI 渲染层：左侧角色列表 + 中部聊天列表。
// 全部输出经 escapeHtml 转义；事件通过委托绑定（data-* 属性）。

import { escapeHtml, truncateText } from "../../utils/text.js";
import { formatFileSize, formatTimestamp } from "../../utils/time.js";

/**
 * 创建书架 UI 核心。
 * @param {object} deps 依赖注入
 * @param {Function} deps.getCharacters  () => Array<object> 角色列表
 * @param {Function} deps.getCharChats  (charIdx, avatar) => Promise<Array> 聊天列表
 * @param {Function} deps.onSelectChar  (charIdx, char) => void 选中角色回调
 * @param {Function} deps.onSelectChat  (char, chat) => void 选中聊天回调
 * @param {Function} deps.cfmT          (text) => string 界面文本转换
 */
export function createBookshelfUI(deps) {
  const {
    getCharacters,
    getCharChats,
    onSelectChar,
    onSelectChat,
    cfmT = (t) => t,
  } = deps;

  let selectedCharIdx = -1;

  /**
   * 渲染角色列表。
   * @param {HTMLElement} container 容器元素
   * @param {number} [activeIdx] 当前选中角色索引
   */
  function renderCharacters(container, activeIdx) {
    const chars = getCharacters();
    selectedCharIdx = activeIdx ?? selectedCharIdx;
    if (!chars.length) {
      container.innerHTML = `<div class="novel-empty">${escapeHtml(cfmT("暂无角色"))}</div>`;
      return;
    }
    container.innerHTML = chars
      .map(
        (c, i) => `
      <div class="novel-char-item${i === selectedCharIdx ? " active" : ""}" data-char-idx="${i}">
        <div class="novel-char-name">${escapeHtml(c.name || cfmT("未命名"))}</div>
      </div>`,
      )
      .join("");
  }

  /**
   * 渲染某角色的聊天列表（异步拉取）。
   * @param {HTMLElement} container 容器元素
   * @param {number} charIdx 角色索引
   * @param {object} char 角色对象
   */
  async function renderChats(container, charIdx, char) {
    // 记录选中角色（聊天点击事件依赖它判断当前角色）
    selectedCharIdx = charIdx;
    container.innerHTML = `<div class="novel-loading">${escapeHtml(cfmT("加载聊天列表…"))}</div>`;
    const list = await getCharChats(charIdx, char.avatar);
    if (!list.length) {
      container.innerHTML = `<div class="novel-empty">${escapeHtml(cfmT("暂无聊天记录"))}</div>`;
      return;
    }
    container.innerHTML = list
      .map((chat) => {
        const fileName = chat.file_name || "";
        const lastMes = chat.last_mes || "";
        const count = chat.chat_items || chat.message_count || 0;
        const size = formatFileSize(chat.file_size);
        const date = formatTimestamp(
          chat.last_mes_timestamp ?? chat.create_date,
        );
        return `
        <div class="novel-chat-item" data-file="${escapeHtml(fileName)}">
          <div class="novel-chat-title">${escapeHtml(truncateText(fileName.replace(/\.jsonl$/i, ""), 40))}</div>
          <div class="novel-chat-preview">${escapeHtml(truncateText(lastMes, 80))}</div>
          <div class="novel-chat-meta">${count ? escapeHtml(cfmT(`${count} 条消息`)) : ""}${size ? " · " + escapeHtml(size) : ""}${date ? " · " + escapeHtml(date) : ""}</div>
        </div>`;
      })
      .join("");
  }

  /**
   * 事件委托：绑定角色/聊天点击。
   * @param {HTMLElement} charsContainer 角色列表容器
   * @param {HTMLElement} chatsContainer 聊天列表容器
   */
  function bindEvents(charsContainer, chatsContainer) {
    charsContainer.addEventListener("click", (e) => {
      const item = e.target.closest(".novel-char-item");
      if (!item) return;
      const idx = Number(item.dataset.charIdx);
      const chars = getCharacters();
      const char = chars[idx];
      if (!char) return;
      onSelectChar(idx, char);
    });

    chatsContainer.addEventListener("click", (e) => {
      const item = e.target.closest(".novel-chat-item");
      if (!item || selectedCharIdx < 0) return;
      const chars = getCharacters();
      const char = chars[selectedCharIdx];
      if (!char) return;
      onSelectChat(char, { file_name: item.dataset.file });
    });
  }

  return { renderCharacters, renderChats, bindEvents };
}
