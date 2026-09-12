// integrations/topbar-icon.js
// 顶栏按钮图标美化适配（参考 CFM ui/toolbar/buttons.js + integrations/theme-observer.js 精简版）：
//   检测邻居按钮（用户设定管理 #persona-management-button）的实际图标样式，
//   若美化主题用图片替换了邻居按钮图标，则让本插件顶栏按钮保持一致。
// 仅自动检测与适配（无设置面板）：用户无需干预，保持与其它顶栏按钮视觉统一。

/**
 * 判断 computed background-image 是否为真正的图片图标（排除 linear-gradient 等）。
 * @param {string} bgImage
 * @returns {boolean}
 */
export function isImageIconBackgroundCore(bgImage) {
  if (!bgImage || bgImage === "none" || bgImage === "") return false;
  return /\b(?:url|image-set)\(/i.test(bgImage);
}

/**
 * 检测邻居按钮的实际图标样式（computed style，不解析 CSS 规则）。
 * 兼容三种实现：.drawer-icon 元素本身 / .drawer-toggle / ::before 伪元素。
 * @param {object} deps { document, window, isImageIconBackground }
 * @returns {{ cssUrl: string, target: string, styles: Object }|null}
 */
export function detectNeighborIconCore(deps) {
  for (const cls of [".drawer-icon", ".drawer-toggle"]) {
    const neighborIcon = deps.document.querySelector(
      `#persona-management-button ${cls}`,
    );
    if (!neighborIcon) continue;
    // 跳过打开状态的邻居按钮图标（openIcon 样式不同）
    if (cls === ".drawer-icon" && neighborIcon.classList.contains("openIcon")) {
      continue;
    }

    // 1) 元素本身的 background-image
    const computed = deps.window.getComputedStyle(neighborIcon);
    const bgImage = computed.backgroundImage;
    if (deps.isImageIconBackground(bgImage)) {
      const extraStyles = {};
      if (cls === ".drawer-toggle") {
        const w = computed.width;
        const h = computed.height;
        const bgSize = computed.backgroundSize;
        const bgRepeat = computed.backgroundRepeat;
        const bgPos = computed.backgroundPosition;
        const display = computed.display;
        const color = computed.color;
        if (w) extraStyles.width = w;
        if (h) extraStyles.height = h;
        if (bgSize) extraStyles.backgroundSize = bgSize;
        if (bgRepeat) extraStyles.backgroundRepeat = bgRepeat;
        if (bgPos) extraStyles.backgroundPosition = bgPos;
        if (display) extraStyles.display = display;
        if (color) extraStyles.color = color;
      }
      return { cssUrl: bgImage, target: cls, styles: extraStyles };
    }

    // 2) ::before 伪元素的 background-image
    const beforeComputed = deps.window.getComputedStyle(neighborIcon, "::before");
    const beforeBgImage = beforeComputed.backgroundImage;
    if (deps.isImageIconBackground(beforeBgImage)) {
      const extraStyles = {};
      const w = beforeComputed.width;
      const h = beforeComputed.height;
      const bgSize = beforeComputed.backgroundSize;
      const bgRepeat = beforeComputed.backgroundRepeat;
      const bgPos = beforeComputed.backgroundPosition;
      if (w) extraStyles.width = w;
      if (h) extraStyles.height = h;
      if (bgSize) extraStyles.backgroundSize = bgSize;
      if (bgRepeat) extraStyles.backgroundRepeat = bgRepeat;
      if (bgPos) extraStyles.backgroundPosition = bgPos;
      return { cssUrl: beforeBgImage, target: cls + "::before", styles: extraStyles };
    }
  }
  return null;
}

/**
 * 应用自定义图标到顶栏按钮（三种模式，先清理旧模式残留）。
 * @param {string} cssUrl CSS url() 格式图标
 * @param {string} [targetCls] ".drawer-icon" / ".drawer-toggle" / 含 "::before"
 * @param {Object} [extraStyles] 需复制的额外样式
 * @param {object} deps { $ }
 */
export function applyCustomIconCore(cssUrl, targetCls, extraStyles, deps) {
  const $ = deps.$;
  const icon = $("#novel-topbar-button .drawer-icon");
  if (icon.length === 0) return;

  // ★ 先统一清理旧模式残留
  icon.removeClass("novel-custom-icon-before");
  $("#novel-dynamic-icon-style").remove();
  icon.css("background-image", "");
  const toggle = $("#novel-topbar-button .drawer-toggle");
  if (toggle.length > 0) {
    toggle.removeClass("novel-custom-toggle-icon");
    toggle.css({
      "background-image": "",
      "background-repeat": "",
      "background-position": "",
      "background-size": "",
      width: "",
      height: "",
      color: "",
    });
  }

  icon.addClass("novel-custom-icon");
  const isPseudoBefore = targetCls && targetCls.includes("::before");

  if (isPseudoBefore) {
    // ::before 模式：注入动态 <style>，尺寸等属性由美化主题通用规则自然生效
    icon.addClass("novel-custom-icon-before");
    const styleEl = $(
      `<style id="novel-dynamic-icon-style">
          #novel-topbar-button .drawer-icon.novel-custom-icon-before::before {
            content: '' !important;
            display: block !important;
            background-image: ${cssUrl} !important;
          }
        </style>`,
    );
    $("head").append(styleEl);
  } else if (targetCls === ".drawer-toggle" && extraStyles) {
    // .drawer-toggle 模式：应用到 toggle 元素并复制尺寸/背景属性
    if (toggle.length > 0) {
      toggle.addClass("novel-custom-toggle-icon");
      toggle.css({
        "background-image": cssUrl,
        "background-repeat": extraStyles.backgroundRepeat || "no-repeat",
        "background-position": extraStyles.backgroundPosition || "center",
        "background-size": extraStyles.backgroundSize || "contain",
        width: extraStyles.width || "27px",
        height: extraStyles.height || "27px",
        color: "transparent",
      });
    }
  } else {
    // .drawer-icon 元素本身模式
    icon.css("background-image", cssUrl);
  }
}

/**
 * 清除自定义图标（恢复默认 FA 图标）。
 * @param {object} deps { $ }
 */
export function clearCustomIconCore(deps) {
  const $ = deps.$;
  const icon = $("#novel-topbar-button .drawer-icon");
  if (icon.length === 0) return;

  icon.removeClass("novel-custom-icon novel-custom-icon-before");
  icon.css("background-image", "");
  $("#novel-dynamic-icon-style").remove();
  const toggle = $("#novel-topbar-button .drawer-toggle");
  if (toggle.length > 0) {
    toggle.removeClass("novel-custom-toggle-icon");
    toggle.css({
      "background-image": "",
      "background-repeat": "",
      "background-position": "",
      "background-size": "",
      width: "",
      height: "",
      color: "",
    });
  }
}

/**
 * 顶栏图标美化适配编排：初始检测应用 + 三策略自动监听（无用户手动设置）。
 * @param {object} deps
 *   $, document, window, Node, setTimeout, setInterval, clearInterval,
 *   isImageIconBackground, detectNeighborIcon, applyCustomIcon, clearCustomIcon
 * @returns {{ start: Function, destroy: Function }}
 */
export function createTopbarIconAdaptorCore(deps) {
  let lastNeighborBg = null;
  let themeCheckTimer = null;

  /** 检测邻居并应用/清除（记录基线） */
  function detectAndApply() {
    const result = deps.detectNeighborIcon();
    lastNeighborBg = result ? result.cssUrl : null;
    if (result) {
      deps.applyCustomIcon(result.cssUrl, result.target, result.styles);
    } else {
      deps.clearCustomIcon();
    }
  }

  /** 样式变化回调（邻居面板打开时跳过，避免读取打开态样式） */
  function onThemeStyleChange() {
    const neighborDrawerIcon = document.querySelector(
      "#persona-management-button .drawer-icon",
    );
    if (neighborDrawerIcon && neighborDrawerIcon.classList.contains("openIcon")) {
      return;
    }
    detectAndApply();
  }

  /** 启动自动监听（三大策略） */
  function setupThemeChangeObserver() {
    // 原生浏览器对象/方法必须用全局引用调用（deps 传入的会在跨模块传递时丢失 this）
    const gWin = window;
    const gDoc = document;
    const MutationObserverCtor = gWin.MutationObserver || gDoc.MutationObserver;
    const setTimeoutFn = (fn, ms) => gWin.setTimeout(fn, ms);
    const setIntervalFn = (fn, ms) => gWin.setInterval(fn, ms);
    const clearIntervalFn = (id) => gWin.clearInterval(id);

    // --- 策略1: MutationObserver 监听 <head> 中 STYLE/LINK 增删与内容变化 ---
    const headObserver = new MutationObserverCtor((mutations) => {
      let styleChanged = false;
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
            if (
              node.nodeType === gDoc.defaultView?.Node?.ELEMENT_NODE ||
              node.nodeType === 1 /* Node.ELEMENT_NODE */
            ) {
              if (node.tagName === "STYLE" || node.tagName === "LINK") {
                styleChanged = true;
                break;
              }
            }
          }
        }
        if (
          mutation.type === "characterData" &&
          mutation.target.parentNode?.tagName === "STYLE"
        ) {
          styleChanged = true;
        }
      }
      if (styleChanged) {
        // 延迟执行，等浏览器完成样式计算
        setTimeoutFn(() => onThemeStyleChange(), 300);
      }
    });
    headObserver.observe(gDoc.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // --- 策略2: 监听 #custom-style 内容变化 ---
    const customStyle = gDoc.getElementById("custom-style");
    if (customStyle) {
      const customObserver = new MutationObserverCtor(() => {
        setTimeoutFn(() => onThemeStyleChange(), 300);
      });
      customObserver.observe(customStyle, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    // --- 策略3: 每 2s 轮询邻居按钮样式（兜底） ---
    detectAndApply();
    themeCheckTimer = setIntervalFn(() => {
      const neighborDrawerIcon = gDoc.querySelector(
        "#persona-management-button .drawer-icon",
      );
      if (
        neighborDrawerIcon &&
        neighborDrawerIcon.classList.contains("openIcon")
      ) {
        return; // 邻居面板打开中，跳过
      }
      const result = deps.detectNeighborIcon();
      const currentBg = result ? result.cssUrl : null;
      if (currentBg !== lastNeighborBg) {
        lastNeighborBg = currentBg;
        onThemeStyleChange();
      }
    }, 2000);
  }

  /** 启动（延迟 500ms 等美化主题样式加载完成） */
  function start() {
    window.setTimeout(() => {
      setupThemeChangeObserver();
    }, 500);
  }

  function destroy() {
    if (themeCheckTimer) {
      window.clearInterval(themeCheckTimer);
      themeCheckTimer = null;
    }
  }

  return { start, destroy, detectAndApply };
}
