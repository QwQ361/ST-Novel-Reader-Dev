// features/reader/render.js
// 小说正文渲染层。
// 关键安全点：Markdown → HTML 必须走独立安全管线 renderMarkdown
// （ST 的 converter/showdown + encodeStyleTags + DOMPurify.sanitize + decodeStyleTags），
// 禁止直接 innerHTML 原始消息。
// ⚠️ 不能复用 ST 的 messageFormatting：它严重依赖全局 chat 数组（chat.map / getRegexedString /
// chat[messageId]?.extra?.type），只能渲染「当前打开的聊天」，渲染非当前聊天时返回空。

/**
 * 单条消息渲染为安全的 HTML。
 * @param {object} deps 依赖注入
 * @param {object} mes 消息对象（ST 原始消息：name / is_user / is_system / mes / send_date / swipes）
 * @param {object} [options]
 * @param {string} [options.userName] 用户显示名（说话人标签兜底）
 * @param {Function} [options.tc] 简繁转换函数
 * @returns {string} 安全的 HTML 字符串（已 sanitize）
 */
export function renderMessage(deps, mes, options = {}) {
  const { renderMarkdown = null } = deps;
  const { tc = (t) => t, floor = null } = options;

  const name = mes.name || options.userName || "?";
  const isUser = Boolean(mes.is_user);
  const isSystem = Boolean(mes.is_system);

  let bodyHtml = "";
  try {
    // 独立管线：converter → encodeStyleTags → DOMPurify.sanitize → decodeStyleTags
    // 不触碰全局 chat，可渲染任意聊天的消息。
    if (typeof renderMarkdown === "function") {
      bodyHtml = renderMarkdown(mes.mes || "");
    } else {
      // 兜底：无渲染管线时只转义纯文本
      bodyHtml = escapeHtmlFallback(mes.mes || "");
    }
  } catch (err) {
    console.warn("[NovelReader] renderMarkdown 失败，回退转义输出:", err);
    bodyHtml = escapeHtmlFallback(mes.mes || "");
  }

  // 简繁转换（针对说话人标签；正文 HTML 已在管线内处理）
  const label = tc(name);
  // 楼层 + 时间戳：#楼层 年/月/日 时:分（本地时区；无效值兜底显示原文）
  const time = mes.send_date
    ? escapeHtmlFallback(formatFloorTime(floor, mes.send_date))
    : "";

  const cls = [
    "novel-msg",
    isUser ? "novel-msg-user" : "",
    isSystem ? "novel-msg-system" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `
    <div class="${cls}" data-id="${escapeHtmlFallback(String(mes.mesId ?? ""))}">
      <div class="novel-msg-head">
        <span class="novel-msg-name">${escapeHtmlFallback(label)}</span>
        ${time ? `<span class="novel-msg-time">${time}</span>` : ""}
      </div>
      <div class="novel-msg-body">${bodyHtml}</div>
    </div>`;
}

/**
 * 将消息数组分批渲染到容器（避免一次性插入上万条 DOM 卡死）。
 * @param {object} deps 依赖注入
 * @param {HTMLElement} container 目标容器
 * @param {Array<object>} messages 消息数组
 * @param {object} [options] 见 renderMessage
 * @param {number} [options.batchSize=200] 每批渲染条数
 * @returns {Promise<void>} 渲染完成
 */
export async function renderMessagesBatched(
  deps,
  container,
  messages,
  options = {},
) {
  const { batchSize = 200, onProgress, startIndex = 0 } = options;
  const total = messages.length;

  // 用 DocumentFragment 累积，避免多次重排
  let fragment = document.createDocumentFragment();
  let pending = 0;

  for (let i = 0; i < total; i += 1) {
    const mes = messages[i];
    if (!mes) continue;
    const wrapper = document.createElement("div");
    // 楼层号 = 章起始偏移 + 章内序号 + 1（与搜索楼层号一致）
    wrapper.innerHTML = renderMessage(deps, mes, {
      ...options,
      floor: startIndex + i + 1,
    });
    // wrapper 只含一个子节点（novel-msg），取其首个元素挂载
    const node = wrapper.firstElementChild;
    if (node) {
      fragment.appendChild(node);
      pending += 1;
    }

    // 每 batchSize 条挂载一次，让出主线程
    if (pending >= batchSize) {
      container.appendChild(fragment);
      fragment = document.createDocumentFragment();
      pending = 0;
      onProgress?.(i + 1, total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (pending > 0) {
    container.appendChild(fragment);
  }
}

/**
 * 纯文本兜底转义（messageFormatting 不可用时的最后防线）。
 * @param {string} str
 * @returns {string}
 */
function escapeHtmlFallback(str) {
  // 用字符串拼接构造实体，避免工具/编辑器对字面量做实体解码
  const AMP = "&" + "amp;";
  const QUOT = "&" + "quot;";
  return String(str ?? "")
    .replace(/&/g, AMP)
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, QUOT);
}

/**
 * 楼层 + 消息时间戳：#楼层 年/月/日 时:分（本地时区）。
 * ST 消息的 send_date 形如 "2026-09-07T11:37:16.293Z"（ISO 8601 UTC）。
 * 解析失败 → 返回原文兜底。
 * @param {number|null|undefined} floor 楼层号（消息在完整数组中的序号，1 起）
 * @param {string|number|Date} value
 * @returns {string}
 */
function formatFloorTime(floor, value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value ?? "");
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const timePart = `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
  return floor != null && floor > 0 ? `#${floor} ${timePart}` : timePart;
}
