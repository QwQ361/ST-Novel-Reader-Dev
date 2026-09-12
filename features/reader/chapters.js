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
 * 生成章节显示标题（取章内第一条角色消息的说话人；无角色则取首条说话人）。
 * @param {{messages: Array<object>}} chapter 章节对象
 * @param {object} [options]
 * @param {string} [options.userName="你"] 用户显示名（说话人标签兜底）
 * @param {string} [options.fallback="无标题"] 无任何消息时的标题
 * @returns {string} 章节标题（不含「第 N 章」前缀，前缀由调用方拼接）
 */
export function getChapterTitle(chapter, options = {}) {
  const { userName = "你", fallback = "无标题" } = options;
  const firstChar = chapter.messages.find((m) => !m.is_user && !m.is_system);
  const first = chapter.messages[0];
  if (firstChar) return firstChar.name || fallback;
  if (first) return first.name || userName || fallback;
  return fallback;
}
