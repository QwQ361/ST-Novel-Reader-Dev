// features/regex/index.js
// 正则过滤核心：让用户把酒馆的正则应用到小说阅读渲染。
//
// 数据源（与酒馆正则面板一致）：
//   - 全局正则：extension_settings.regex（用户在正则面板创建的「全局」类型脚本）
//   - 角色正则：当前角色 data.extensions.regex_scripts（角色的「角色」类型脚本）
//   预设（preset）正则不在此列：它是按当前预设/API 动态读取的，阅读器上下文不稳定，暂不支持。
//
// 执行引擎：自实现 runRegexScript（复刻 ST engine.js 的 runRegexScript 核心）：
//   - findRegex 支持 /pattern/flags 或普通字符串（regexFromString 解析）
//   - replaceString 支持 {{match}}（→ $0）、$1 / $<name> 捕获组
//   - trimStrings 从替换结果中剔除指定子串
//   不依赖 ST 的 substituteParams 宏（{{user}}/{{char}} 等）：阅读器渲染的是历史聊天，
//   宏没有当前上下文，直接按字面处理（与 ST 行为一致的是 —— 未勾选时不做任何替换）。
//
// 勾选状态持久化：extension_settings[EXT_NAME].regexEnabledIds（Array<string>，存脚本 id）。
// 默认全部不勾选（保守），用户按需在「阅读器选项 → 正则过滤」中勾选。

/**
 * 将正则字符串解析为 RegExp（复刻 ST utils.js regexFromString）。
 * 支持 /pattern/flags 与裸字符串；解析失败返回 null。
 * @param {string} input
 * @returns {RegExp|null}
 */
export function regexFromString(input) {
  try {
    const m = String(input).match(/(\/?)(.+)\1([a-z]*)/i);
    if (!m) return null;
    if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) {
      return new RegExp(String(input));
    }
    return new RegExp(m[2], m[3]);
  } catch {
    return null;
  }
}

/**
 * 对单个正则脚本执行替换（复刻 ST runRegexScript 核心，去除宏依赖）。
 * @param {object} script RegexScriptData 结构
 * @param {string} rawString 原文
 * @returns {string} 替换后的文本
 */
export function runRegexScript(script, rawString) {
  let newString = rawString;
  if (
    !script ||
    script.disabled ||
    !script.findRegex ||
    typeof rawString !== "string"
  ) {
    return newString;
  }

  const findRegex = regexFromString(String(script.findRegex));
  if (!findRegex) return newString;

  const replaceString = String(script.replaceString ?? "").replace(
    /{{match}}/gi,
    "$0",
  );

  newString = rawString.replace(findRegex, function (match) {
    const args = [...arguments];
    const replaceWithGroups = replaceString.replaceAll(
      /\$(\d+)|\$<([^>]+)>/g,
      (_, num, groupName) => {
        if (num) {
          match = args[Number(num)];
        } else if (groupName) {
          const groups = args[args.length - 1];
          match =
            groups && typeof groups === "object" && groups[groupName]
              ? groups[groupName]
              : "";
        }
        if (!match) return "";
        // trimStrings：剔除匹配内容中的指定子串
        const filtered = applyTrimStrings(match, script.trimStrings);
        return filtered;
      },
    );
    return replaceWithGroups;
  });

  return newString;
}

/**
 * 剔除替换结果中的 trimStrings。
 * @param {string} rawString
 * @param {string[]} [trimStrings]
 * @returns {string}
 */
function applyTrimStrings(rawString, trimStrings) {
  let finalString = String(rawString ?? "");
  if (Array.isArray(trimStrings)) {
    for (const trimString of trimStrings) {
      if (trimString) finalString = finalString.replaceAll(String(trimString), "");
    }
  }
  return finalString;
}

/**
 * 创建正则过滤核心。
 * @param {object} deps 依赖注入
 * @param {Function} deps.getSettings 读 extension_settings
 * @param {Function} deps.saveSettings 持久化
 * @param {Function} deps.getStContext 获取 ST 上下文（取全局正则 / 当前角色）
 * @param {string} deps.extName 插件名（extension_settings 下的键）
 * @returns {object} regex API
 */
export function createRegexCore(deps) {
  const { getSettings, saveSettings, getStContext, extName } = deps;

  /** 读勾选的脚本 id 列表（默认空数组） */
  function getEnabledIds() {
    const s = getSettings();
    if (!s[extName]) s[extName] = {};
    if (!Array.isArray(s[extName].regexEnabledIds)) s[extName].regexEnabledIds = [];
    return s[extName].regexEnabledIds;
  }

  /** 设置勾选状态 */
  function setEnabled(id, on) {
    const s = getSettings();
    if (!s[extName]) s[extName] = {};
    if (!Array.isArray(s[extName].regexEnabledIds)) s[extName].regexEnabledIds = [];
    const ids = s[extName].regexEnabledIds;
    const idx = ids.indexOf(id);
    if (on && idx === -1) ids.push(id);
    if (!on && idx !== -1) ids.splice(idx, 1);
    saveSettings?.();
  }

  /**
   * 获取所有可用正则脚本（全局 + 当前角色级），标注来源。
   * @param {object} [options]
   * @param {string} [options.avatar] 当前角色头像名（用于取角色级正则）
   * @returns {Array<{script: object, source: "global"|"character", key: string}>}
   *   key 用于勾选状态的唯一标识：global:{id} / character:{avatar}:{id}
   */
  function getAllScripts(options = {}) {
    const { avatar = "" } = options;
    const results = [];
    const seen = new Set();

    const push = (script, source) => {
      if (!script || typeof script !== "object") return;
      const id = script.id;
      if (!id) return;
      // 全局脚本与角色无关（跨角色勾选状态一致）；角色脚本才需要 avatar 区分
      const key = source === "global" ? `global:${id}` : `character:${avatar}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ script, source, key });
    };

    // 全局正则：extension_settings.regex
    const ctx = getStContext?.() || null;
    const globalScripts = ctx?.extensionSettings?.regex;
    if (Array.isArray(globalScripts)) {
      globalScripts.forEach((s) => push(s, "global"));
    }

    // 角色正则：characters[avatar].data.extensions.regex_scripts
    if (avatar) {
      const char = ctx?.characters?.find((c) => c.avatar === avatar);
      const charScripts = char?.data?.extensions?.regex_scripts;
      if (Array.isArray(charScripts)) {
        charScripts.forEach((s) => push(s, "character"));
      }
    }

    return results;
  }

  /**
   * 对文本应用所有已勾选的正则（按顺序）。
   * @param {string} text 原文
   * @param {object} [options]
   * @param {string} [options.avatar] 当前角色头像（决定启用哪些角色级正则）
   * @returns {string} 过滤后的文本
   */
  function runRegexOnText(text, options = {}) {
    if (typeof text !== "string" || !text) return text ?? "";
    const { avatar = "" } = options;
    const enabled = new Set(getEnabledIds());
    if (enabled.size === 0) return text;

    let out = text;
    const all = getAllScripts({ avatar });
    for (const item of all) {
      if (!enabled.has(item.key) && !enabled.has(item.script.id)) continue;
      try {
        out = runRegexScript(item.script, out);
      } catch (err) {
        console.warn("[NovelReader] 正则执行失败:", item.script.scriptName, err);
      }
    }
    return out;
  }

  /** 是否启用了任何正则 */
  function hasEnabled() {
    return getEnabledIds().length > 0;
  }

  return {
    getEnabledIds,
    setEnabled,
    getAllScripts,
    runRegexOnText,
    hasEnabled,
  };
}
