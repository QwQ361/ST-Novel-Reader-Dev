// utils/i18n.js
// 简繁转换接入层。
// s2t.js 由用户直接复制到插件根目录，是自执行 IIFE（挂 window._cfm_s2t，提供 toTraditional / toSimplified）。
// 本模块负责：
//  1) 幂等地用 fetch + new Function 注入 s2t.js（它没有 export，无法 ES import）
//  2) 提供 cfmTCore(text) 风格的界面文本封装（仅 language === 'zh-TW' 时转繁体）
//  3) 提供 convertText(text, enabled) 供小说正文按用户设置转换

// s2t.js 相对本模块（utils/）向上两级 = 插件根目录；用 import.meta.url 解析成绝对路径，
// 避免浏览器中 fetch 相对路径相对于页面文档 URL（页面根）解析不到文件。
const S2T_URL = new URL("../s2t.js", import.meta.url).href;

// 加载状态缓存
let _s2tPromise = null;

/**
 * 注入 s2t.js 到 window._cfm_s2t（幂等）。
 * @returns {Promise<object|null>} window._cfm_s2t 对象，失败返回 null
 */
export function loadS2T() {
  if (window._cfm_s2t) return Promise.resolve(window._cfm_s2t);
  if (_s2tPromise) return _s2tPromise;

  _s2tPromise = fetch(S2T_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    })
    .then((code) => {
      // s2t.js 是普通脚本（IIFE 挂 window），用 new Function 在当前作用域执行
      new Function(code)();
      if (!window._cfm_s2t) throw new Error("s2t.js 未挂载 window._cfm_s2t");
      return window._cfm_s2t;
    })
    .catch((err) => {
      console.warn("[NovelReader] s2t.js 加载失败:", err);
      _s2tPromise = null; // 允许重试
      return null;
    });

  return _s2tPromise;
}

/**
 * 判断当前界面语言是否为繁体中文。
 * @param {object} deps 依赖注入
 * @returns {boolean}
 */
export function isTraditionalMode(deps = {}) {
  return deps.settings?.language === "zh-TW";
}

/**
 * 界面文本转换：仅繁体模式时转繁体，否则原样返回。
 * @param {string} text 简体文本
 * @param {object} deps 依赖注入（settings）
 * @returns {string} 转换后的文本
 */
export function cfmTCore(text, deps = {}) {
  if (!isTraditionalMode(deps)) return text;
  return window._cfm_s2t?.toTraditional?.(text) ?? text;
}

/**
 * 正文文本转换：enabled 为 true 时转繁体。
 * @param {string} text 原文
 * @param {boolean} enabled 是否启用转换
 * @returns {string} 转换后的文本
 */
export function convertText(text, enabled) {
  if (!enabled) return text;
  return window._cfm_s2t?.toTraditional?.(text) ?? text;
}

/**
 * DOM 级简繁转换：遍历 root 下的文本节点与常用属性（placeholder/title/aria-label）。
 * 用于正文渲染后转换（保留 HTML 结构、不破坏 Markdown 内联元素）。
 * 参考 CFM 的 cfmConvertDomTextCore，但改用 novel- 命名空间：
 *   排除 data-novel-no-convert 子树（如语言切换按钮本身）。
 * @param {HTMLElement} root 要转换的 DOM 根
 * @param {object} [deps] 依赖注入
 * @param {Function} [deps.toTraditional] 转换函数（默认 window._cfm_s2t.toTraditional）
 * @returns {void}
 */
export function convertDomTextCore(root, deps = {}) {
  if (!root) return;
  const s2t = window._cfm_s2t;
  const toTraditional = deps.toTraditional || s2t?.toTraditional;
  if (typeof toTraditional !== "function") return;

  const doc = root.ownerDocument || document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const toConv = [];
  let node;
  while ((node = walker.nextNode())) {
    const el = node.parentElement;
    if (el?.closest?.("[data-novel-no-convert]")) continue;
    const t = node.nodeValue || "";
    if (!/[\u4e00-\u9fff]/.test(t)) continue; // 无汉字跳过（性能）
    toConv.push(node);
  }
  // 先收集后修改，避免遍历中变更影响 TreeWalker
  for (const n of toConv) {
    n.nodeValue = toTraditional(n.nodeValue);
  }

  // 属性值也转换（placeholder / title / aria-label）
  const attrs = ["placeholder", "title", "aria-label"];
  if (root.querySelectorAll) {
    root.querySelectorAll("[placeholder],[title],[aria-label]").forEach((el) => {
      if (el.closest?.("[data-novel-no-convert]")) return;
      for (const a of attrs) {
        if (
          el.hasAttribute(a) &&
          /[\u4e00-\u9fff]/.test(el.getAttribute(a) || "")
        ) {
          el.setAttribute(a, toTraditional(el.getAttribute(a)));
        }
      }
    });
  }
}
