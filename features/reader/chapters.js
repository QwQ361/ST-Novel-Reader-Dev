// features/reader/chapters.js
// 分章纯函数：把完整消息数组按「user+char 合并」规则切成章。
// 规则（用户明确指定）：
//   1. 一个角色(char)的连续对话为 1 章
//   2. 若 char 前面紧跟 user 对话，两者合并为 1 章
// 示例：
//   char1, user2, char2, user3, char3     → 第1章[char1] 第2章[user2,char2] 第3章[user3,char3]
//   user1, char1, user2, char2            → 第1章[user1,char1] 第2章[user2,char2]
//   user1, char1, user2, char2, user3     → 第1章[user1,char1] 第2章[user2,char2] 第3章[user3]
// 系统消息不特殊对待：按 is_user 正常参与分章（部分聊天把剧情正文标记为 is_system，
// 若把系统消息一律归并进当前章会导致大量轮次挤进一章）。
// 隐藏 user 回复（showUserReplies=false）：
//   先过滤掉全部 is_user 消息，剩余消息按「每条 char 单独成章」切分（system 也保留为独立章）。

/**
 * 将消息数组按分章规则切成章节。
 * @param {Array<object>} messages 完整消息数组（ST 原始消息：mes/is_user/is_system/name）
 * @param {object} [options]
 * @param {boolean} [options.showUserReplies=true] 是否保留 user 消息（false 时过滤 user，每条 char 单独成章）
 * @returns {Array<{index: number, messages: Array<object>}>} 章节数组（index 从 1 开始）
 */
export function splitChapters(messages, options = {}) {
  const { showUserReplies = true } = options;
  const chapters = [];
  let current = [];

  /** 封章：当前章非空则推入 chapters */
  const flush = () => {
    if (current.length) {
      chapters.push({ index: chapters.length + 1, messages: current });
      current = [];
    }
  };

  for (const mes of messages) {
    if (!mes) continue;
    const isUser = Boolean(mes.is_user);

    // 隐藏 user 回复：user 消息直接跳过
    if (!showUserReplies && isUser) continue;

    if (current.length === 0) {
      current.push(mes);
      continue;
    }

    const last = current[current.length - 1];
    const lastIsUser = Boolean(last.is_user);

    if (isUser) {
      // user 消息：若当前章最后已是 char（连续角色结束）→ 封章，user 前置到新章
      if (!lastIsUser) flush();
      current.push(mes);
    } else {
      // char 消息：若当前章最后已是 user → 合并（user+char 一章）；否则封章开新章
      if (lastIsUser) {
        current.push(mes);
      } else {
        flush();
        current.push(mes);
      }
    }
  }

  flush();
  return chapters;
}

/**
 * 从消息正文中提取自定义标签内的文字（用于「自动识别标题」）。
 * 例如 tag="bt" 时，`xxx<bt>第1章 序章</bt>yyy` → `第1章 序章`。
 * 规则：
 *   - 只取第一次出现的标签内容；标签名大小写不敏感
 *   - 支持标签带属性（如 <bt class="x">）
 *   - 找不到标签 → 返回空字符串（调用方回退到默认标题）
 *   - 标签内容两侧空白会被 trim，内容按原样保留（后续 escapeHtml 输出）
 * @param {string} text 消息正文（原始 Markdown/HTML 字符串）
 * @param {string} [tag="bt"] 标签名（不含尖括号）
 * @returns {string} 标签内文字；未匹配返回空字符串
 */
export function extractTagTitle(text, tag = "bt") {
  const t = String(text || "");
  if (!t) return "";
  const tagName = String(tag || "")
    .trim()
    .replace(/[<>\/]/g, ""); // 容错：去掉可能误输入的 < > /
  if (!tagName) return "";
  // 标签名转义正则元字符（如用户输入 b.t 之类），并忽略大小写
  const esc = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 开标签允许属性；结束标签严格匹配；不跨行（. 不含 \n，正文中标签通常单行）
  const re = new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${esc}>`, "i");
  const m = t.match(re);
  if (!m) return "";
  const inner = m[1] || "";
  return inner.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ""); // 去首尾空白/全角空格
}

/**
 * 生成章节显示标题（取章内第一条角色消息的说话人；无角色则取首条说话人）。
 * 若 options.tag 提供且章内消息正文包含该标签，则优先用标签内文字作为标题。
 * @param {{messages: Array<object>}} chapter 章节对象
 * @param {object} [options]
 * @param {string} [options.userName="你"] 用户显示名（说话人标签兜底）
 * @param {string} [options.fallback="无标题"] 无任何消息时的标题
 * @param {string} [options.tag=""] 自动识别标题标签名（空 = 不启用）；启用时优先取章内
 *   第一条角色消息正文中 <tag>...</tag> 内的文字作为标题
 * @returns {string} 章节标题（不含「第 N 章」前缀，前缀由调用方拼接）
 */
export function getChapterTitle(chapter, options = {}) {
  const { userName = "你", fallback = "无标题", tag = "" } = options;

  // 自动识别标题：从章内第一条「非 user 消息」的正文提取标签文字
  if (tag) {
    const firstTextMsg = chapter.messages.find(
      (m) => !m.is_user && String(m.mes || "").trim(),
    );
    if (firstTextMsg) {
      const extracted = extractTagTitle(firstTextMsg.mes, tag);
      if (extracted) return extracted;
    }
  }

  const firstChar = chapter.messages.find((m) => !m.is_user && !m.is_system);
  const first = chapter.messages[0];
  if (firstChar) return firstChar.name || fallback;
  if (first) return first.name || userName || fallback;
  return fallback;
}
