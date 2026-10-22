// features/export/index.js
// 聊天导出核心：把完整消息数组按分章规则切成章，逐条消息应用已勾选正则，
// 拼接为「章节标题 + 正文 + 五个空行」结构的纯文本，供 UI 层下载为 txt。
//
// 复用既有纯函数（不重复实现）：
//   splitChapters                     分章（features/reader/chapters.js）
//   getChapterTitle / stripChapterNumberPrefix / filterTitleText   章节标题识别与清理
//
// 依赖注入 deps：
//   getChatMessages(avatar, fileName)  读完整消息数组（由 bookshelf 提供）
//   regexFilter(text, avatar)          应用已勾选正则（由 regex core 提供）
//   userName                           用户显示名兜底（标签）
//   getChapterTitleTag()               自动识别标题标签（空 = 关闭）
//   getChapterTitleFilters()           标题过滤文字列表
//   getStripChapterPrefix()            是否剥离章号前缀（如「第一章：」）
//
// 分章始终按完整消息（含 user）进行，与阅读器目录一致；导出时按 includeUser
// 过滤章内消息（只导出 char 时跳过 user，章节边界不变）。

import {
  filterTitleText,
  getChapterTitle,
  splitChapters,
  stripChapterNumberPrefix,
} from "../reader/chapters.js";

// 章节之间分隔：五个空行
const CHAPTER_GAP = "\n\n\n\n\n";

// 提取 ```html 代码块的正则：捕获组为代码内容（不含围栏与首尾换行）
const HTML_FENCE_RE = /```\s*html[ \t]*\r?\n([\s\S]*?)(?:```|$)/gi;

/**
 * 提取 ```html 代码块为占位符（导出专用，独立于 reader/iframe 的 preprocessHtmlApps）。
 * 与渲染版的关键差异：
 *   - 占位符不带换行（`@@NOVEL_HTML_APP_n@@`），代码内容 trim 掉首尾换行，
 *     这样还原/略过时可精确控制，不会在正文中残留多余空行。
 * @param {string} text 原始 Markdown 文本
 * @returns {{ text: string, apps: Array<{code: string}> }}
 */
function extractHtmlApps(text) {
  const apps = [];
  const processed = String(text ?? "").replace(HTML_FENCE_RE, (match, code) => {
    const idx = apps.length;
    apps.push({ code: String(code).replace(/^\r?\n|\r?\n$/g, "") });
    return `@@NOVEL_HTML_APP_${idx}@@`;
  });
  return { text: processed, apps };
}

/**
 * 创建导出核心。
 * @param {object} deps 依赖注入
 * @returns {object} { exportChat }
 */
export function createExportCore(deps) {
  /**
   * 处理单条消息正文（与阅读器 renderTextBody 的正则/HTML 应用顺序一致）：
   *   1. 提取 ```html 代码块为占位符（先于正则，防止正则误删代码块内标签）
   *   2. 应用已勾选正则（markdown 源码原样保留）
   *   3. includeHtml=true → 还原为 ```html 代码块；false → 略过（占位符删除）
   * @param {string} text 消息正文（mes.mes）
   * @param {string} avatar 角色头像（决定启用哪些角色级正则）
   * @param {boolean} includeHtml 是否保留 html 代码块
   * @returns {string} 处理后的文本
   */
  function processMessageText(text, avatar, includeHtml) {
    let t = String(text || "");
    if (!t) return "";

    // 1) 提取 html 代码块为占位符（纯字母数字，不被任何正则命中）
    const { text: protectedText, apps } = extractHtmlApps(t);
    t = protectedText;

    // 2) 应用正则
    if (typeof deps.regexFilter === "function" && t) {
      try {
        t = deps.regexFilter(t, avatar || "");
      } catch (err) {
        console.warn("[NovelReader] 导出正则过滤失败，使用原文:", err);
      }
    }

    // 3) 还原 / 略过 html 代码块（占位符不带换行，直接替换即可）
    if (apps.length) {
      apps.forEach((app, i) => {
        const ph = `@@NOVEL_HTML_APP_${i}@@`;
        if (includeHtml) {
          // 还原为原始 ```html 代码块（补回围栏与换行）
          t = t.split(ph).join("```html\n" + app.code + "\n```");
        } else {
          // 略过：占位符删除
          t = t.split(ph).join("");
        }
      });
    }

    return t.trim();
  }

  /**
   * 计算章节元信息（displayIndex / title / titleSource），与 reader.loadChat 的规则一致：
   *   标签识别开启且章内标签标题非空且与说话人兜底不同 → titleSource="tag"；
   *   标签标题二次处理：剥离章号前缀 + 移除指定过滤文字。
   * @param {{messages: Array<object>}} ch 章节对象
   * @param {number} displayIndex 章节显示编号（所有章节连续编号，含番外）
   * @returns {{title: string, titleSource: string, displayIndex: number}}
   */
  function computeChapterMeta(ch, displayIndex) {
    const titleTag = deps.getChapterTitleTag ? deps.getChapterTitleTag() : "";
    const titleFilters = deps.getChapterTitleFilters
      ? deps.getChapterTitleFilters()
      : [];
    const stripPrefix = deps.getStripChapterPrefix
      ? deps.getStripChapterPrefix()
      : true;

    let titleSource = "speaker";
    let title = "";
    if (titleTag) {
      const extracted = getChapterTitle(ch, {
        userName: deps.userName,
        tag: titleTag,
      });
      const speaker = getChapterTitle(ch, { userName: deps.userName });
      title = extracted;
      if (extracted && extracted !== speaker) titleSource = "tag";
      else title = speaker;
    } else {
      title = getChapterTitle(ch, { userName: deps.userName });
    }
    // 标签标题二次处理：剥离章号前缀 + 移除指定过滤文字（与阅读器一致）
    if (titleSource === "tag") {
      if (stripPrefix) title = stripChapterNumberPrefix(title);
      title = filterTitleText(title, titleFilters);
    }
    return { title, titleSource, displayIndex };
  }

  /**
   * 生成章节标题行：`第N章` +（titleSource==='tag' 且有标题时）` 章节名`。
   * 与阅读器 buildChapterHeader 的 subtitle 规则一致。
   * @param {{title: string, titleSource: string, displayIndex: number}} meta 章节元信息
   * @returns {string}
   */
  function buildChapterHeaderText(meta) {
    let header = `第${meta.displayIndex}章`;
    if (meta.titleSource === "tag" && meta.title) {
      header += ` ${meta.title}`;
    }
    return header;
  }

  /**
   * 导出聊天为 txt 文本。
   * @param {object} options
   * @param {string} options.avatar 角色头像文件名
   * @param {string} options.fileName 聊天文件名（带 .jsonl）
   * @param {boolean} [options.includeUser=true] 是否导出 user 回复（false → 只导出 char）
   * @param {boolean} [options.includeHtml=true] 是否导出 html 代码块（false → 略过）
   * @returns {Promise<string|null>} 完整 txt 文本；无内容返回 null
   */
  async function exportChat(options = {}) {
    const {
      avatar,
      fileName,
      includeUser = true,
      includeHtml = true,
    } = options;
    const messages = await deps.getChatMessages(avatar, fileName);
    if (!Array.isArray(messages) || !messages.length) return null;

    // 分章始终按完整消息（含 user）进行，与阅读器目录章节一致；
    // 「只导出 char」通过章内过滤实现（章节边界不变）。
    const rawChapters = splitChapters(messages, { showUserReplies: true });
    if (!rawChapters.length) return null;

    const parts = [];
    let displayIndex = 0;
    for (const ch of rawChapters) {
      displayIndex += 1;
      const meta = computeChapterMeta(ch, displayIndex);
      const header = buildChapterHeaderText(meta);
      const lines = [header];

      // 章节内逐消息拼接
      for (const mes of ch.messages) {
        if (!includeUser && mes.is_user) continue; // 只导出 char：跳过 user 消息
        const text = processMessageText(mes.mes, avatar, includeHtml);
        if (!text) continue; // 空正文不输出该消息块
        if (includeUser) {
          // 同时导出：人名标签单独成行 + 空行 + 正文
          const name = mes.name || deps.userName || "?";
          lines.push(`${name}：\n${text}`);
        } else {
          // 只导出 char：无标签，仅正文
          lines.push(text);
        }
      }

      // 章节无任何消息（如全被正则过滤）时仅输出标题行
      parts.push(lines.join("\n\n"));
    }

    return parts.join(CHAPTER_GAP);
  }

  return { exportChat };
}
