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
 * 清洗提取出的标题文本：统一换行、折叠水平空白、只保留首个非空行。
 * 标题在 UI（目录 / 章节副标题）中按单行展示，因此多行内容只取第一行有效内容。
 * @param {string} raw 原始提取内容
 * @returns {string} 单行标题；无有效内容返回空字符串
 */
export function cleanTitleText(raw) {
  const t = String(raw ?? "").replace(/\r\n?/g, "\n");
  const line =
    t
      .split("\n")
      .map((l) => l.replace(/[ \t\u3000]+/g, " ").trim())
      .find(Boolean) || "";
  return line;
}

// HTML 实体检测与还原（用 \u0026 表示 & 的实体起始符，避免源码中直接出现转义序列）
const ESCAPED_ENTITY_RE = /\u0026(?:lt|gt|quot|apos|#0*39);/i;

/**
 * 还原常见 HTML 实体（仅用于兼容被转义过的正文，如 `&lt;title&gt;`）。
 * @param {string} s 文本
 * @returns {string} 还原后的文本
 */
function unescapeBasicEntities(s) {
  return String(s || "")
    .replace(/\u0026lt;/gi, "<")
    .replace(/\u0026gt;/gi, ">")
    .replace(/\u0026quot;/gi, '"')
    .replace(/\u0026#0*39;|\u0026apos;/gi, "'");
}

/**
 * 从消息正文中提取自定义标签内的文字（用于「自动识别标题」）。
 * 例如 tag="zj" 时，`xxx<zj>第1章 序章</zj>yyy` → `第1章 序章`。
 * 规则：
 *   - 只取第一次出现的标签内容；标签名大小写不敏感
 *   - 支持标签带属性（如 <zj class="x">）
 *   - 找不到标签 → 返回空字符串（调用方回退到默认标题）
 *   - 标签内容按 cleanTitleText 清洗（多行取首个非空行）
 * @param {string} text 消息正文（原始 Markdown/HTML 字符串）
 * @param {string} [tag="zj"] 标签名（不含尖括号）
 * @returns {string} 标签内文字；未匹配返回空字符串
 */
export function extractTagTitle(text, tag = "zj") {
  const t = String(text || "");
  if (!t) return "";
  const tagName = String(tag || "")
    .trim()
    .replace(/[<>\/]/g, ""); // 容错：去掉可能误输入的 < > /
  if (!tagName) return "";
  // 标签名转义正则元字符（如用户输入 b.t 之类），并忽略大小写
  const esc = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 开标签允许属性；结束标签按标签名匹配
  const re = new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${esc}>`, "i");
  const m = t.match(re);
  if (m) return pickTitleFromBlock(m[1] || "", tagName);

  // 容错：只有开标签、没有闭合标签的写法（如正文里单独一行 <title>）。
  // 此时看开标签之后的若干行（先试键值清单，再退回第一条非空行）。
  const openRe = new RegExp(`<${esc}(?:\\s[^>]*)?>`, "i");
  const open = t.match(openRe);
  if (!open || open.index === undefined) return "";
  return pickTitleFromBlock(t.slice(open.index + open[0].length), tagName);
}

/**
 * 从「前包裹标记」推断其语义键名，用于键值清单匹配。
 * 例：`<title>` → `title`；`[Title|` → `title`；`【标题】` → `标题`。
 * @param {string} marker 前包裹标记
 * @returns {string} 推断出的键名；无法推断返回空字符串
 */
function markerKey(marker) {
  const m = String(marker || "");
  if (!m) return "";
  // 取标记中最长的「字母/中文」片段作为键名（跳过括号、竖线等符号）
  const words = m.match(/[A-Za-z0-9_\u4e00-\u9fa5]+/g) || [];
  if (!words.length) return "";
  return words.sort((a, b) => b.length - a.length)[0].toLowerCase();
}

/**
 * 从「标签内文字 / 开标记之后的文本块」中挑出标题：
 *   1) 若文本块是多行键值清单（`[Title|誓水重温]`、`Title: xxx`），取键名与 key 对应的内容；
 *   2) 否则取首个非空行（普通标签写法，如 `<zj>第1章 序章</zj>`）。
 * @param {string} block 文本块
 * @param {string} [key=""] 期望的键名（通常等于标签名，如 "title"）
 * @returns {string} 标题；无内容返回空字符串
 */
function pickTitleFromBlock(block, key = "") {
  // 1) 键名与标签名一致（`<title>` + `[Title|xxx]` 的典型场景）
  const kv = key ? findKeyValueTitle(block, key) : "";
  if (kv) return kv;
  // 2) 标签名不一致（如标签 `<zj>` 内部却是 `[Title|xxx]` 清单）：
  //    仅在键名明确是「标题类」语义时才取该行内容，避免误拆「序章：开始」这类正文
  const semantic =
    findKeyValueTitle(block, "title") || findKeyValueTitle(block, "标题");
  if (semantic) return semantic;
  // 3) 普通标签写法：取首个非空行
  return firstLineAfterMarker(block, 0);
}

/**
 * 取标记位置之后的「第一个非空行」：先看同行剩余内容，为空再往下找。
 * 用于「只有前标记、没有后标记」的标题格式（如正文首行 `<title>` 独占一行）。
 * @param {string} src 全文
 * @param {number} from 起始下标
 * @returns {string} 该行内容；找不到返回空字符串
 */
function firstLineAfterMarker(src, from) {
  const lines = String(src || "")
    .slice(from)
    .split("\n");
  const same = (lines[0] || "").trim();
  if (same) return cleanTitleText(same);
  // 往下最多找 3 行，避免误抓到远处正文
  for (let i = 1; i < lines.length && i <= 3; i++) {
    const line = (lines[i] || "").trim();
    if (line) return cleanTitleText(line);
  }
  return "";
}

// 键值行解析：`[Title|誓水重温]` / `Title: 誓水重温` / `［Title｜xxx］` 等
// 结构：可选左括号 + 键名 + 分隔符（| ｜ : ：）+ 内容 + 可选右括号
const KEY_VALUE_LINE_RE =
  /^\s*[\[［(（【]?\s*([^|｜:：\[\]［］()（）【】\s]{1,24})\s*[|｜:：]\s*(.*?)\s*[\]］)）】]?\s*$/;

/**
 * 在文本块中查找「键名匹配」的键值行，并返回其内容。
 * 用于适配 `<title>` 内是 `[Title|誓水重温]`、`[Seq|10]` 这类键值清单的场景：
 * 用户只需把识别标签填为 `title`，即可自动取出 Title 键对应的「誓水重温」。
 * @param {string} block 文本块（标签内文字 / 开标记之后的若干行）
 * @param {string} key 目标键名（如 "title"）；大小写不敏感，允许包含匹配
 * @returns {string} 键对应内容；未命中返回空字符串
 */
function findKeyValueTitle(block, key) {
  const want = String(key || "")
    .trim()
    .toLowerCase();
  if (!want) return "";
  const lines = String(block || "").split("\n");
  for (const line of lines) {
    const m = line.match(KEY_VALUE_LINE_RE);
    if (!m) continue;
    const k = String(m[1] || "")
      .trim()
      .toLowerCase();
    if (!k) continue;
    // 键名相等或互相包含（Title / title / 标题名 等写法容错）
    if (k === want || k.includes(want) || want.includes(k)) {
      const v = cleanTitleText(m[2]);
      if (v) return v;
    }
  }
  return "";
}

/**
 * 归一化标题识别配置（把用户填写的零散字段整理成统一结构）。
 * 兼容旧版「只填标签名」的配置：tag 有值且未填前后包裹时，仍按标签模式识别。
 * @param {object} [cfg]
 * @param {string} [cfg.tag=""] 标签名（不含尖括号）
 * @param {string} [cfg.prefix=""] 前包裹标记
 * @param {string} [cfg.suffix=""] 后包裹标记
 * @returns {{tag: string, prefix: string, suffix: string, enabled: boolean}}
 */
export function normalizeTitleRule(cfg = {}) {
  const tag = String(cfg.tag ?? "")
    .trim()
    .replace(/[<>\/]/g, "");
  const prefix = String(cfg.prefix ?? "");
  const suffix = String(cfg.suffix ?? "");
  return {
    tag,
    prefix,
    suffix,
    enabled: Boolean(tag || prefix.length || suffix.length),
  };
}

/**
 * 按「前包裹 + 后包裹」提取标题文字（用于「自动识别标题」的通用模式）。
 * 适用无法用成对标签描述、但标题被固定前后文包住的场景，例如：
 *   prefix="[Title|", suffix="]"  →  `[Title|誓水重温]` 提取出「誓水重温」
 *   prefix="标题：",  suffix=""     →  `标题：序章` 提取出「序章」
 * 规则：
 *   - 只取第一次出现的「前包裹」；大小写敏感（正文标记大小写固定）
 *   - 后包裹留空 → 取前包裹之后的行内容（同行为空则取下方最近的非空行）
 *   - 前包裹留空 → 取正文开头到第一个后包裹之间的内容
 *   - 前、后包裹都为空 → 返回空字符串（未配置规则）
 *   - 提取内容按 cleanTitleText 清洗（多行取首个非空行）
 * @param {string} text 消息正文（原始 Markdown/HTML 字符串）
 * @param {string} [prefix=""] 前包裹标记（如 "[Title|"）
 * @param {string} [suffix=""] 后包裹标记（如 "]"）
 * @returns {string} 提取出的标题；未匹配返回空字符串
 */
export function extractWrappedTitle(text, prefix = "", suffix = "") {
  const src = String(text || "");
  const p = String(prefix ?? "");
  const s = String(suffix ?? "");
  if (!src || (!p && !s)) return "";

  const at = p ? src.indexOf(p) : 0;
  if (at < 0) return "";
  const from = at + p.length;

  // 后包裹留空：先看前标记之后的文本块是否为键值清单
  // （典型：`<title>` 独占一行，下一行才是 `[Title|誓水重温]`）
  // 命中则取对应键的内容；否则取最近的第一个非空行。
  if (!s) {
    const key = markerKey(p);
    if (key) {
      const block = src.slice(from).split("\n").slice(0, 6).join("\n");
      const kv = findKeyValueTitle(block, key);
      if (kv) return kv;
    }
    return firstLineAfterMarker(src, from);
  }

  const end = src.indexOf(s, from);
  if (end < 0) return "";
  return cleanTitleText(src.slice(from, end));
}

/**
 * 统一标题提取入口：「前后包裹」优先，其次「标签」。
 * 同时兼容正文被 HTML 转义过的情况（`<title>` 等同 `<title>`）。
 * @param {string} text 消息正文
 * @param {object} [options]
 * @param {string} [options.tag=""] 标签名（不含尖括号）
 * @param {string} [options.prefix=""] 前包裹标记
 * @param {string} [options.suffix=""] 后包裹标记
 * @returns {string} 提取出的标题；未匹配返回空字符串
 */
export function extractChapterTitle(text, options = {}) {
  const { tag = "", prefix = "", suffix = "" } = options;
  const src = String(text || "");
  if (!src) return "";
  const hasWrap = Boolean(
    String(prefix ?? "").length || String(suffix ?? "").length,
  );
  const hasTag = Boolean(String(tag ?? "").trim());
  if (!hasWrap && !hasTag) return "";

  const candidates = [src];
  // 正文可能被转义（ST 某些预设会把开标记写成实体形式），再试一次
  if (ESCAPED_ENTITY_RE.test(src)) {
    candidates.push(unescapeBasicEntities(src));
  }

  for (const candidate of candidates) {
    if (hasWrap) {
      const wrapped = extractWrappedTitle(candidate, prefix, suffix);
      if (wrapped) return wrapped;
    }
    if (hasTag) {
      const tagged = extractTagTitle(candidate, tag);
      if (tagged) return tagged;
    }
  }
  return "";
}

// 数字通配：阿拉伯 / 全角 / 汉字数字（含 百千万亿 等位词）
const NUM_TOKEN = "[\\d０-９一二三四五六七八九十百千万零〇两]+";

/**
 * 把单条过滤模板转成正则（仅供 filterTitleText 内部使用）。
 * 模板规则：
 *   - 独立大写 N（两侧不是字母/数字/下划线）→ 任意数字通配（匹配 1 / 10 / 一百 / １２３）
 *   - 模板中的空白序列 → \s+（容忍标题里多个/不同类型的空白）
 *   - 其余字符按字面匹配（正则元字符已转义）
 * @param {string} template 单条过滤模板
 * @returns {RegExp|null} 内容为空或编译失败返回 null
 */
function templateToRegex(template) {
  const s = String(template || "").trim();
  if (!s) return null;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "N") {
      const prev = i > 0 ? s[i - 1] : "";
      const next = i < s.length - 1 ? s[i + 1] : "";
      if ((!prev || !/\w/.test(prev)) && (!next || !/\w/.test(next))) {
        out += NUM_TOKEN;
        continue;
      }
    }
    if (/\s/.test(ch)) {
      out += "\\s+";
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(out, "g");
  } catch {
    return null;
  }
}

/**
 * 从标题中移除指定文字（过滤文字，可多条，支持模板匹配）。
 * 每条规则：
 *   - 含「独立大写 N」→ 模板匹配：N 视为任意数字通配符（阿拉伯/全角/汉字数字），
 *     如 "Chapter N" 可过滤 "Chapter 1"、"Chapter 100"、"Chapter 一百"；
 *   - 不含 N → 保持纯字面删除（向后兼容）。
 * 过滤完成后统一清理多余空格，过滤结果为空时返回原标题（避免空副标题）。
 * @param {string} title 原始标题
 * @param {Array<string>} [filters=[]] 过滤规则列表（如 ["第一章：", "Chapter N"]）
 * @returns {string} 过滤后的标题
 */
export function filterTitleText(title, filters = []) {
  let t = String(title || "");
  if (!t) return t;
  const original = t;
  for (const f of filters) {
    const s = String(f || "").trim();
    if (!s) continue;
    if (/\bN\b/.test(s)) {
      // 模板含独立大写 N：按「任意数字」通配匹配并删除
      const re = templateToRegex(s);
      if (re) t = t.replace(re, "");
    } else {
      // 纯字面删除
      t = t.split(s).join("");
    }
  }
  // 清理过滤残留的多余空格；全部被删则保留原标题
  t = t.replace(/ +/g, " ").trim();
  return t || original;
}

/**
 * 剥离标题开头的「章号前缀」（如「第一章：」「第1章 」「第 100 章-」）。
 * 解决识别标题自带「第一章：章节名」与目录自带「第N章」重复的问题：
 * 无论章节数字是阿拉伯数字、全角数字还是汉字数字，均自动识别并剥离。
 * 例：
 *   「第一章：序章」        → 「序章」
 *   「第1章 风云起」        → 「风云起」
 *   「第 100 章-归途」      → 「归途」
 *   「第一百二十回·重逢」   → 「重逢」（章词含 回/卷/节/部/集）
 * 剥离后为空（标题只有「第一章」无后文）时返回原标题，避免空标题。
 * @param {string} title 识别出的标题
 * @returns {string} 剥离前缀后的标题
 */
export function stripChapterNumberPrefix(title) {
  const t = String(title || "").trim();
  if (!t) return t;
  // 第 + 数字（阿拉伯/全角/汉字）+ 章词 + 可选分隔符（冒号/点/空格/横线/间隔点等）
  // 间隔点「·」「・」「•」与中英文逗号也算作章号前缀分隔符（如「第1章·序章」「第1章,序章」）
  const re =
    /^第\s*[\d０-９一二三四五六七八九十百千万零〇两]+\s*[章回卷节部集][\s:：.。、\-—–|丨·・•,，]*/;
  const stripped = t.replace(re, "").trim();
  return stripped || t;
}

/**
 * 生成章节显示标题（取章内第一条角色消息的说话人；无角色则取首条说话人）。
 * 若 options.tag / options.prefix / options.suffix 提供且章内消息正文能匹配，
 * 则优先用提取出的文字作为标题。识别顺序：章内第一条角色消息 → 其余角色消息。
 * @param {{messages: Array<object>}} chapter 章节对象
 * @param {object} [options]
 * @param {string} [options.userName="你"] 用户显示名（说话人标签兜底）
 * @param {string} [options.fallback="无标题"] 无任何消息时的标题
 * @param {string} [options.tag=""] 自动识别标题标签名（空 = 不启用），如 "zj" 或 "title"
 * @param {string} [options.prefix=""] 标题前包裹标记（如 "[Title|"、"<title>"）
 * @param {string} [options.suffix=""] 标题后包裹标记（如 "]"）
 * @returns {string} 章节标题（不含「第 N 章」前缀，前缀由调用方拼接）
 */
export function getChapterTitle(chapter, options = {}) {
  const { userName = "你", fallback = "无标题" } = options;
  const tag = String(options.tag ?? "").trim();
  const prefix = String(options.prefix ?? "");
  const suffix = String(options.suffix ?? "");
  const useExtract = Boolean(tag || prefix.length || suffix.length);

  // 自动识别标题：优先章内第一条「非 user 消息」，未命中再扫描其余非 user 消息
  if (useExtract) {
    const textMsgs = chapter.messages.filter(
      (m) => !m.is_user && String(m.mes || "").trim(),
    );
    for (const m of textMsgs) {
      const extracted = extractChapterTitle(m.mes, { tag, prefix, suffix });
      if (extracted) return extracted;
    }
  }

  const firstChar = chapter.messages.find((m) => !m.is_user && !m.is_system);
  const first = chapter.messages[0];
  if (firstChar) return firstChar.name || fallback;
  if (first) return first.name || userName || fallback;
  return fallback;
}
