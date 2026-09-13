// features/reader/frontend.js
// 酒馆助手风格的「前端界面」渲染：当消息正文里的代码块含 <body> 等完整 HTML 结构时，
// 用 <iframe srcdoc> 把它渲染成独立网页（支持 <script> / Vue / React 等，与酒馆助手一致）。
//
// 判定规则（与酒馆助手 isFrontend 一致）：
//   代码块文本同时满足：包含 "html>" 或 "<head>" 或 "<body>"（大小写不敏感）。
//
// 高度自适应：iframe 内注入一段脚本，把 body.scrollHeight 写回父页面 iframe 高度，
// 避免内容被裁剪（与酒馆助手 adjust_iframe_height.js 思路一致）。

/**
 * 判断文本是否为「前端界面」代码（酒馆助手规则：含 html>/<head>/<body 任一）。
 * @param {string} text
 * @returns {boolean}
 */
export function isFrontendContent(text) {
  if (!text) return false;
  return ["html>", "<head>", "<body"].some((tag) =>
    text.toLowerCase().includes(tag),
  );
}

// ⚠️ 占位符必须走「占位 id + 内存 Map」方案：
// 直接把完整 srcdoc（含 <html> 等真实字符）塞进 data-* 属性，会被 converter.makeHtml
// 实体解码 + DOMPurify 剥离；而占位符只放简短 data-slot-id="N"，完整 srcdoc 存本模块
// 的 Map，hydrate 时按 id 取回。实测 data-slot-id 能完整通过 renderMarkdownCore 管线。

/** 自增占位 id */
let _slotSeq = 0;
/** id → srcdoc 内容（内存缓存，渲染完成后即删） */
const _slotMap = new Map();

/**
 * 把消息正文中「含完整 HTML 的前端代码块」替换为占位符。
 *
 * 处理流程：
 * 1. 用正则找出 ```...``` 代码块（保留语言标记行）；
 * 2. 对每个代码块用 isFrontendContent 判定；
 * 3. 命中的代码块 → srcdoc 存 _slotMap，占位符只放 data-slot-id="N"；
 * 4. 未命中的代码块保留原样（走正常 Markdown 渲染）。
 *
 * 注意：本函数在 Markdown 转换（converter.makeHtml + DOMPurify）之前调用，
 * 占位符在 sanitize 之后由 hydrateFrontendSlots 还原为 <iframe srcdoc>。
 *
 * @param {string} markdown 原始 Markdown 消息正文（尚未转换 HTML）
 * @returns {string} 处理后的 Markdown（命中的代码块 → 占位符）
 */
export function replaceFrontendCodeBlocks(markdown) {
  const text = String(markdown ?? "");
  if (!text.includes("```")) return text;

  // 逐个匹配 ``` 代码块（非贪婪，含语言标记行与内容）
  return text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (whole, langLine, code) => {
    // 跳过未被识别为前端界面的代码块（保持原样交给 Markdown 渲染）
    if (!isFrontendContent(code)) return whole;

    // 生成 iframe srcdoc 内容（vh 转换 + 高度自适应），存入内存 Map
    const srcdoc = createFrontendSrcdoc(code);
    const id = ++_slotSeq;
    _slotMap.set(id, srcdoc);

    // 占位符：只放简短 data-slot-id（已验证能完整通过 renderMarkdownCore 管线）
    return `\n<div class="novel-frontend-slot" data-slot-id="${id}"></div>\n`;
  });
}

/**
 * 生成 iframe 的 srcdoc 完整 HTML 文档。
 * @param {string} content 代码块内的前端 HTML 内容
 * @returns {string}
 */
export function createFrontendSrcdoc(content) {
  let body = String(content ?? "");
  // min-height: *vh → 以浏览器高度为基准（酒馆助手规则）
  body = replaceVhUnits(body);

  // 注入：默认样式清零 + 高度自适应脚本（把 body.scrollHeight 写回父页 iframe）
  const heightScript = `<script>
(function(){
  function resize(){
    try{
      var h = document.body ? document.body.scrollHeight : 0;
      if(h > 0 && window.frameElement){ window.frameElement.style.height = h + 'px'; }
    }catch(e){}
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', resize);
  } else { resize(); }
  if(window.ResizeObserver){ new ResizeObserver(resize).observe(document.body); }
  window.addEventListener('resize', resize);
})();
<\/script>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*,*::before,*::after{box-sizing:border-box;}
html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important;}
</style>
</head>
<body>
${body}
${heightScript}
</body>
</html>`;
}

/**
 * 把内容里的 min-height: *vh（CSS 声明、行内 style、JS 赋值）转换为
 * 以浏览器视口高度为基准的 calc 表达式。
 *
 * ⚠️ 不能用「直接替换 vh」的方式：`50vh → calc(100vh * 0.5)` 之后，
 * 新产生的 `100vh` 会被二次处理成 `calc(100vh * 1)`，导致嵌套。
 * 正确做法：先给原始 `Nvh` 打占位标记（\uE000），全部打完后再统一还原，
 * 保证 `calc(100vh * N)` 里的 `100vh` 永远不会再被匹配。
 *
 * @param {string} content
 * @returns {string}
 */
export function replaceVhUnits(content) {
  if (!content) return content;
  const hasCss = /min-height\s*:\s*[^;{}]*\d+(?:\.\d+)?vh/gi.test(content);
  if (!hasCss) return content;

  // 占位标记：\uE000 + 数值 + \uE001（私有区字符，不可能出现在真实内容里）
  const mark = (num) => `\uE000${num}\uE001`;
  const convert = (value) =>
    value.replace(/(\d+(?:\.\d+)?)vh\b/gi, (_match, num) => {
      const parsed = parseFloat(num);
      if (!Number.isFinite(parsed)) return _match;
      // 保留 4 位小数，避免浮点精度（33.3vh → 0.33299999999999996）
      const ratio = Math.round((parsed / 100) * 10000) / 10000;
      return mark(ratio);
    });

  // 1) CSS 声明块中的 min-height: ...vh
  let out = content.replace(
    /(min-height\s*:\s*)([^;{}]*?\d+(?:\.\d+)?vh)(?=\s*[;}])/gi,
    (_m, prefix, value) => `${prefix}${convert(value)}`,
  );
  // 2) 行内 style="min-height: ...vh"
  out = out.replace(
    /(style\s*=\s*(["']))([^"'"]*?)(\2)/gi,
    (match, prefix, _q, styleContent, suffix) => {
      if (!/min-height\s*:\s*[^;]*vh/i.test(styleContent)) return match;
      const replaced = styleContent.replace(
        /(min-height\s*:\s*)([^;]*?\d+(?:\.\d+)?vh)/gi,
        (_m, p1, p2) => `${p1}${convert(p2)}`,
      );
      return `${prefix}${replaced}${suffix}`;
    },
  );
  // 3) 统一还原占位标记 → calc(100vh * N)
  out = out.replace(/\uE000([\d.]+)\uE001/g, (_m, n) => `calc(100vh * ${n})`);
  return out;
}

/**
 * 把已 sanitize 的 HTML 中的「前端占位符」还原为真实 iframe。
 * 在 DOMPurify.sanitize 之后调用。
 * @param {string} html 已 sanitize 的 HTML
 * @returns {string} 还原为 iframe 的 HTML
 */
export function hydrateFrontendSlots(html) {
  if (!html || !html.includes("novel-frontend-slot")) return html;

  const container = document.createElement("div");
  container.innerHTML = html;

  container.querySelectorAll(".novel-frontend-slot").forEach((slot) => {
    const id = Number(slot.getAttribute("data-slot-id"));
    const srcdoc = _slotMap.get(id) || "";
    if (!srcdoc) return;
    const iframe = document.createElement("iframe");
    iframe.className = "novel-frontend-iframe";
    iframe.setAttribute("frameborder", "0");
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("scrolling", "no");
    // srcdoc 在 sanitize 之后由 JS 赋值，iframe 是隔离的独立文档
    iframe.srcdoc = srcdoc;
    slot.replaceWith(iframe);
    // 渲染完成后释放内存
    _slotMap.delete(id);
  });

  return container.innerHTML;
}
