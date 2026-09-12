// features/reader/index.js
// 小说阅读器功能聚合入口：读取完整消息数组 + 安全渲染 + 打开原聊天。
// 依赖注入 deps：
//   getChatMessages(avatar, fileName)  读完整消息数组（由 bookshelf 提供）
//   renderMarkdown(markdown)           Markdown 安全渲染管线（由 integrations 提供）
//   openCharacterChat / selectCharacterById
//   tc(text) 简繁转换 / cfmT(text) 界面文本

import { renderMessage, renderMessagesBatched } from "./render.js";

/**
 * 创建小说阅读器核心。
 * @param {object} deps 依赖注入
 * @returns {object} reader API
 */
export function createReaderCore(deps) {
  const { cfmT = (t) => t, tc = (t) => t } = deps;

  // 当前正在渲染的聊天标识（用于并发竞态防护）
  let currentRequest = { avatar: "", fileName: "" };

  /**
   * 加载并渲染某聊天的完整正文。
   * @param {HTMLElement} container 正文容器（.novel-reader-body）
   * @param {object} options
   * @param {string} options.avatar 角色头像文件名
   * @param {string} options.fileName 聊天文件名（带 .jsonl）
   * @param {string} [options.title] 标题
   * @param {boolean} [options.showSystem] 是否显示系统消息（默认 true）
   * @returns {Promise<number>} 渲染的消息总数
   */
  async function openChat(container, options = {}) {
    const {
      avatar,
      fileName,
      title = "",
      showSystem = true,
      onRendered,
    } = options;
    const reqId = `${avatar}|${fileName}`;
    currentRequest = { avatar, fileName };

    container.innerHTML = `<div class="novel-loading">${cfmT("加载正文…")}</div>`;

    const messages = await deps.getChatMessages(avatar, fileName);

    // 竞态防护：如果加载期间用户切换了聊天，丢弃本次结果
    if (
      currentRequest.avatar !== avatar ||
      currentRequest.fileName !== fileName
    ) {
      return 0;
    }

    const filtered = showSystem
      ? messages
      : messages.filter((m) => !m.is_system);

    // 构建标题栏
    const header = document.createElement("div");
    header.className = "novel-reader-title";
    header.innerHTML = `
      <span class="novel-reader-title-text">${escapeTitle(title || fileName)}</span>
      <span class="novel-reader-title-meta">${filtered.length} ${cfmT("条消息")}</span>
    `;

    const body = document.createElement("div");
    body.className = "novel-reader-body novel-scroll";

    container.innerHTML = "";
    container.appendChild(header);
    container.appendChild(body);

    await renderMessagesBatched(
      { ...deps, renderMarkdown: deps.renderMarkdown },
      body,
      filtered,
      {
        batchSize: 200,
        tc,
        onProgress: (done, total) => {
          const meta = header.querySelector(".novel-reader-title-meta");
          if (meta) meta.textContent = `${done}/${total} ${cfmT("渲染中…")}`;
        },
      },
    );

    // 渲染完成，更新计数并回到顶部
    const meta = header.querySelector(".novel-reader-title-meta");
    if (meta) meta.textContent = `${filtered.length} ${cfmT("条消息")}`;
    body.scrollTop = 0;

    // 通知调用方正文容器已就绪（用于绑定滚动进度监听等）
    onRendered?.(body);

    return filtered.length;
  }

  /**
   * 打开原聊天（跳转 ST 主界面）。
   * @param {number} charIdx 角色索引
   * @param {string} fileName 聊天文件名（带 .jsonl，内部去除扩展名）
   */
  async function openOriginalChat(charIdx, fileName) {
    const fileNameNoExt = String(fileName || "").replace(/\.jsonl$/i, "");
    const selectChar = deps.selectCharacterById;
    const openChat = deps.openCharacterChat;
    if (typeof selectChar !== "function" || typeof openChat !== "function") {
      console.warn("[NovelReader] 缺少 selectCharacterById/openCharacterChat");
      return;
    }
    try {
      await selectChar(charIdx);
      await openChat(fileNameNoExt);
    } catch (err) {
      console.warn("[NovelReader] 打开原聊天失败:", err);
    }
  }

  /** 取消当前渲染（供关闭弹窗时调用） */
  function abort() {
    currentRequest = { avatar: "", fileName: "" };
  }

  return { openChat, openOriginalChat, abort, renderMessage };
}

/**
 * 标题转义（标题来自文件名，仅做文本安全）。
 * @param {string} str
 * @returns {string}
 */
function escapeTitle(str) {
  return String(str ?? "")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, "\x26quot;");
}
