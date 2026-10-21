// features/reader/flip.js
// 翻页阅读核心：把章节内容按可视区域高度拆分成多页，每页只显示一屏文字，
// 点击 / 键盘 / 页码按钮翻页，无需滚动。
//
// 与两种既有模式的区别：
//   paged（分页）   = 单章整章渲染，仍需滚动查看整章
//   scroll（滚动）  = 多章连续渲染，滚动阅读
//   flip（翻页）    = 本章按屏幕高度分页，一页一屏，翻页阅读（本模块）
//
// 核心算法：
//   1. 把章节渲染进隐藏测量容器（与正文同宽、同字号、同 padding），保证测量准确。
//   2. 章节头部 + 每条消息按「块」累加高度分页；单条消息超过一页时拆分为
//      「消息头 + body 顶层子元素」逐个处理；超长文本段落用二分法按字符拆成多段。
//   3. 每页固定高度（= 可视区高度 - 内边距），内容超出的页标记 scrollable（可轻微滚动，
//      用于图片 / 表格 / 代码块等不可拆分的大块）。
//   4. 翻页跨章：末页下一页 → 下一章首页；首页上一页 → 上一章末页。
//
// 依赖注入 deps：
//   reader                  reader core（需暴露 getChatInfo / renderChapterBlock）
//   onCurrentChapterChange  (chapterIndex) => void  当前章变化回调
//   onRenderedChapter       (chapterIndex, block) => void  章节渲染完成（应用样式/注入按钮）
//   onPageChange            (page, totalPages, chapterIndex) => void  页码变化（保存进度用）
//   onToggleChrome          () => void  点击页面中间区域（切换顶/底栏显隐）

const MEASURE_CLASS = "novel-flip-measure";

/**
 * 创建翻页阅读核心。
 * @param {object} deps 依赖注入
 * @returns {object} flip reader API
 */
export function createFlipReader(deps) {
  const {
    reader,
    onCurrentChapterChange,
    onRenderedChapter,
    onPageChange,
    onToggleChrome,
  } = deps;

  let flipEl = null; // 可视容器（.novel-reader-scroll，overflow:hidden）
  let measureEl = null; // 隐藏测量容器（fixed + visibility:hidden）
  let chapterIndex = 0; // 当前章节（1 起）
  let totalChapters = 0; // 总章节数
  let pages = []; // 分页结果：{ nodes: Element[], scrollable: boolean }
  let currentPage = 0; // 当前页码（0 起）
  let busy = false; // 防重入（跨章渲染中）
  let loadingIndicator = null; // 「加载中…」覆盖层
  let resizeTimer = 0; // resize 防抖定时器
  let onKeyDownBound = false; // 键盘监听是否已绑定
  let boundEl = null; // 已绑定 click 的容器（避免重复绑定）
  let onWindowResizeBound = false; // window resize 监听是否已绑定

  // ---------- 高度 / 容器 ----------

  /** 单页可用高度 = 可视高度 - 上下内边距 */
  function pageHeight() {
    if (!flipEl) return 0;
    const cs = getComputedStyle(flipEl);
    const pt = parseFloat(cs.paddingTop) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    return Math.max(100, flipEl.clientHeight - pt - pb);
  }

  /** 创建隐藏测量容器（与显示页 .novel-flip-page 同宽、同字号、无 padding） */
  function createMeasure() {
    const m = document.createElement("div");
    m.className = `novel-reader-scroll ${MEASURE_CLASS}`;
    m.setAttribute("aria-hidden", "true");
    // padding:0 覆盖 .novel-reader-scroll 的 padding（显示页 .novel-flip-page 也无 padding，
    // 直接位于 flipEl 的内容区内；若保留 padding 则测量内容区会窄于显示页）
    m.style.cssText =
      "position:fixed;left:-99999px;top:0;visibility:hidden;overflow:hidden;pointer-events:none;box-sizing:border-box;padding:0;";
    // 测量宽度 = 显示页实际可用宽度（flipEl 内容宽，受 .novel-flip-page max-width:720px 约束）
    if (flipEl) {
      const cs = getComputedStyle(flipEl);
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      const avail = flipEl.clientWidth - pl - pr; // flipEl 内容区宽（显示页可用宽）
      m.style.width = `${Math.max(300, Math.min(avail, 720))}px`;
      m.style.fontSize = cs.fontSize;
    } else {
      m.style.width = "720px";
    }
    document.body.appendChild(m);
    return m;
  }

  function removeMeasure() {
    measureEl?.remove();
    measureEl = null;
  }

  // ---------- 拆分工具 ----------

  /** 是否为可按文本拆分的块（排除图片/表格/代码/列表等结构块） */
  function isSplittable(el) {
    if (!el || !el.textContent || !el.textContent.trim()) return false;
    const tag = String(el.tagName || "").toUpperCase();
    if (
      [
        "PRE",
        "CODE",
        "TABLE",
        "IMG",
        "IFRAME",
        "SVG",
        "CANVAS",
        "VIDEO",
        "AUDIO",
        "UL",
        "OL",
      ].includes(tag)
    ) {
      return false;
    }
    if (
      el.querySelector(
        "img, iframe, table, pre, code, svg, canvas, video, audio",
      )
    ) {
      return false;
    }
    return true;
  }

  /** 用模板元素的标签/类名/样式新建一个纯文本子元素 */
  function makeTextClone(template, text) {
    const el = document.createElement(template.tagName);
    el.className = template.className || "";
    const st = template.getAttribute("style");
    if (st) el.setAttribute("style", st);
    el.textContent = text;
    return el;
  }

  /** 二分法把超长文本元素拆成若干 ≤ targetH 的克隆（返回克隆数组） */
  function splitOversizedEl(template, targetH, inner) {
    const text = template.textContent || "";
    const out = [];
    let rest = text;
    while (rest.length) {
      if (rest.length <= 2) {
        out.push(makeTextClone(template, rest));
        break;
      }
      let lo = 1;
      let hi = rest.length;
      let best = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const probe = makeTextClone(template, rest.slice(0, mid));
        inner.appendChild(probe);
        const h = probe.offsetHeight;
        inner.removeChild(probe);
        if (h <= targetH) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best >= rest.length) {
        out.push(makeTextClone(template, rest));
        break;
      }
      out.push(makeTextClone(template, rest.slice(0, best)));
      rest = rest.slice(best);
    }
    return out;
  }

  // ---------- 分页 ----------

  /**
   * 章节布局：把 inner 内的章标题 / 副标题 / 消息按可视高度拆成多页。
   * 副作用：原消息被克隆/拆分后挂到 inner（测量容器内），原消息 DOM 移除；
   * 分页结果存入 pages（节点引用仍在测量容器内，显示时移动进 flipEl）。
   */
  function layoutChapter(inner) {
    pages = [];
    const PH = pageHeight();
    const titleEl = inner.querySelector(".novel-chapter-title");
    const subtitleEl = inner.querySelector(".novel-chapter-subtitle");
    const msgList = inner.querySelector(".novel-msg-list");

    const nodes = [];
    if (titleEl) nodes.push(titleEl);
    if (subtitleEl) nodes.push(subtitleEl);

    const msgs = msgList ? [...msgList.children] : [];
    for (let mi = 0; mi < msgs.length; mi += 1) {
      const msg = msgs[mi];
      const h = msg.offsetHeight;
      if (h <= PH) {
        msg.dataset.flipMesIdx = String(mi);
        nodes.push(msg);
        continue;
      }

      // 超页消息 → 拆分为「消息头 + body 顶层子元素」逐块处理
      const head = msg.querySelector(".novel-msg-head");
      const body = msg.querySelector(".novel-msg-body");
      if (head) {
        const hc = head.cloneNode(true);
        hc.dataset.flipMesIdx = String(mi);
        inner.appendChild(hc);
        nodes.push(hc);
      }
      const children = body ? [...body.children] : [];
      if (!children.length) {
        msg.dataset.flipMesIdx = String(mi);
        nodes.push(msg);
      } else {
        for (const child of children) {
          const ch = child.offsetHeight;
          let parts = [];
          if (ch <= PH) {
            const clone = child.cloneNode(true);
            parts = [clone];
          } else if (isSplittable(child)) {
            parts = splitOversizedEl(child, PH, inner);
          } else {
            const clone = child.cloneNode(true);
            parts = [clone];
          }
          for (const p of parts) {
            p.dataset.flipMesIdx = String(mi);
            inner.appendChild(p);
            nodes.push(p);
          }
        }
      }
      msg.remove(); // 移除原消息（其克隆已挂在 inner）
    }

    // 贪心分页：逐块累加，超出一页则换页；单块超整页 → 独立滚动页
    let page = [];
    let used = 0;
    const flush = () => {
      if (page.length) {
        pages.push({ nodes: page.slice(), scrollable: false });
        page = [];
        used = 0;
      }
    };
    for (const node of nodes) {
      // offsetHeight 不含 margin：计入 marginBottom 避免实际渲染高度超出页面被裁剪
      const mb = parseFloat(getComputedStyle(node).marginBottom) || 0;
      const h = node.offsetHeight + mb;
      if (h > PH) {
        flush();
        pages.push({ nodes: [node], scrollable: true });
        continue;
      }
      if (used + h > PH) flush();
      page.push(node);
      used += h;
    }
    flush();

    if (!pages.length) pages = [{ nodes: [], scrollable: false }];
  }

  // ---------- 显示 ----------

  /** 显示第 pageIdx 页（0 起） */
  function showPage(pageIdx) {
    if (!flipEl) return;
    const p = pages[pageIdx];
    if (!p) return;
    currentPage = pageIdx;

    flipEl.innerHTML = "";
    loadingIndicator = null;

    const inner = document.createElement("div");
    inner.className = "novel-reader-inner novel-flip-page";
    inner.style.height = `${pageHeight()}px`;
    inner.style.overflow = "hidden";
    if (p.scrollable) inner.style.overflowY = "auto"; // 大块页可轻微滚动
    for (const node of p.nodes) inner.appendChild(node);

    // 页码指示器（定位在 flipEl 底部，不占内容高度）
    const pager = document.createElement("div");
    pager.className = "novel-flip-pager";
    pager.innerHTML = `
      <button type="button" class="novel-flip-pager-btn" data-flip-prev title="上一页">‹</button>
      <span class="novel-flip-pager-count">${currentPage + 1} / ${pages.length}</span>
      <button type="button" class="novel-flip-pager-btn" data-flip-next title="下一页">›</button>`;
    pager.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target.closest("[data-flip-prev]")) {
        prevPage();
      } else if (e.target.closest("[data-flip-next]")) {
        nextPage();
      }
    });
    flipEl.appendChild(inner);
    flipEl.appendChild(pager);

    onPageChange?.(currentPage + 1, pages.length, chapterIndex);
  }

  function showLoading() {
    if (!flipEl || loadingIndicator) return;
    loadingIndicator = document.createElement("div");
    loadingIndicator.className = "novel-flip-loading";
    loadingIndicator.textContent = "加载中…";
    flipEl.appendChild(loadingIndicator);
  }

  function hideLoading() {
    loadingIndicator?.remove();
    loadingIndicator = null;
  }

  // ---------- 翻页 ----------

  async function nextPage() {
    if (busy || !flipEl) return;
    if (currentPage < pages.length - 1) {
      showPage(currentPage + 1);
      return;
    }
    // 末页 → 下一章首页
    if (chapterIndex < totalChapters) {
      await open(chapterIndex + 1, 1);
    }
  }

  async function prevPage() {
    if (busy || !flipEl) return;
    if (currentPage > 0) {
      showPage(currentPage - 1);
      return;
    }
    // 首页 → 上一章末页
    if (chapterIndex > 1) {
      await open(chapterIndex - 1, -1); // -1 = 末页
    }
  }

  /**
   * 打开某章并翻页。
   * @param {HTMLElement} container 可视容器（.novel-reader-scroll）
   * @param {number} startChapter 起始章节（1 起）
   * @param {number} [startPage=1] 起始页（1 起；-1 表示跳转末页）
   */
  /** 绑定容器 click 监听（每个容器只绑一次）+ window resize 监听（常驻，destroy 时移除） */
  function bindEvents() {
    if (boundEl !== flipEl) {
      if (boundEl) boundEl.removeEventListener("click", onClick);
      flipEl.addEventListener("click", onClick);
      boundEl = flipEl;
    }
    if (!onWindowResizeBound) {
      window.addEventListener("resize", onResize);
      onWindowResizeBound = true;
    }
  }

  async function open(container, startChapter, startPage = 1) {
    // 部分重置：不清空容器、不移除监听（跨章翻页时容器持续使用；destroy 仅由外层生命周期调用）
    removeMeasure();
    clearTimeout(resizeTimer);
    resizeTimer = 0;
    flipEl = container;
    flipEl.style.overflow = "hidden";
    flipEl.style.position = "relative"; // pager / loading 覆盖层以此为定位基准
    flipEl.innerHTML = "";
    loadingIndicator = null;
    bindEvents();
    ensureKeyDownBound();
    const info = reader.getChatInfo();
    totalChapters = info?.chapters?.length || 0;
    chapterIndex = Number(startChapter) || 1;

    busy = true;
    showLoading();
    try {
      measureEl = createMeasure();
      const block = await reader.renderChapterBlock(measureEl, chapterIndex);
      if (!block) {
        busy = false;
        hideLoading();
        return;
      }
      // 应用样式（字号等）必须在测量之前：applyReaderStyles 会设置正文容器字号
      onRenderedChapter?.(chapterIndex, block);
      const inner = block.querySelector(".novel-reader-inner");
      if (inner) layoutChapter(inner);

      let p = Number(startPage) || 1;
      if (startPage === -1) p = pages.length; // 上一章 → 末页
      showPage(Math.min(Math.max(1, p), pages.length));
      onCurrentChapterChange?.(chapterIndex);
    } catch (err) {
      console.warn("[NovelReader] 翻页模式渲染章节失败:", err);
      if (flipEl) {
        flipEl.innerHTML = '<div class="novel-flip-loading">章节渲染失败</div>';
      }
    } finally {
      busy = false;
      hideLoading();
    }
  }

  /** 跳转到指定页（1 起） */
  function gotoPage(p) {
    const idx = Math.min(Math.max(1, Number(p) || 1), pages.length) - 1;
    showPage(idx);
  }

  /** 定位到指定消息所在页（搜索结果跳转） */
  async function scrollToMessage(chapterIndex2, msgOffset) {
    // 仅当目标章与当前章不同才重开；同章直接定位，避免重复渲染
    if (chapterIndex !== Number(chapterIndex2)) {
      await open(chapterIndex2, 1);
    }
    if (!pages.length) return;
    const target = String(msgOffset);
    for (let i = 0; i < pages.length; i += 1) {
      const hit = pages[i].nodes.find(
        (n) => n.dataset && n.dataset.flipMesIdx === target,
      );
      if (hit) {
        showPage(i);
        return;
      }
    }
  }

  // ---------- 事件 ----------

  const onClick = (e) => {
    if (!flipEl || busy) return;
    if (
      e.target.closest(
        "a,button,input,img,iframe,.novel-flip-pager,.novel-flip-loading",
      )
    ) {
      return;
    }
    if (window.getSelection && window.getSelection().toString()) return;
    const rect = flipEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    const rel = (e.clientX - rect.left) / rect.width;
    if (rel > 0.65) {
      nextPage();
      return;
    }
    if (rel < 0.35) {
      prevPage();
      return;
    }
    // 中间区域：切换顶/底栏显隐（交由 UI 层处理）
    onToggleChrome?.();
  };

  const onKeyDown = (e) => {
    if (!flipEl || busy) return;
    const tag = e.target ? e.target.tagName : "";
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
    const k = e.key;
    if (k === "ArrowRight" || k === "PageDown" || k === " ") {
      if (k === " " && tag === "BUTTON") return;
      e.preventDefault();
      nextPage();
    } else if (k === "ArrowLeft" || k === "PageUp") {
      e.preventDefault();
      prevPage();
    }
  };

  const onResize = () => {
    if (!flipEl || busy) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      reflow();
    }, 200);
  };

  /** 重新分页并尽量保持当前页（容器尺寸/字号变化后调用） */
  function reflow() {
    if (!flipEl || busy) return;
    const keep = currentPage + 1;
    open(chapterIndex, keep);
  }

  // ---------- 生命周期 ----------

  /** 卸载：移除监听 + 清空容器 + 重置状态 */
  function destroy() {
    removeMeasure();
    if (flipEl) {
      flipEl.removeEventListener("click", onClick);
      flipEl.innerHTML = "";
      flipEl.style.overflow = "";
      flipEl.style.position = "";
    }
    if (boundEl) {
      boundEl.removeEventListener("click", onClick);
      boundEl = null;
    }
    if (onKeyDownBound) {
      document.removeEventListener("keydown", onKeyDown);
      onKeyDownBound = false;
    }
    if (onWindowResizeBound) {
      window.removeEventListener("resize", onResize);
      onWindowResizeBound = false;
    }
    clearTimeout(resizeTimer);
    resizeTimer = 0;
    flipEl = null;
    measureEl = null;
    chapterIndex = 0;
    totalChapters = 0;
    pages = [];
    currentPage = 0;
    busy = false;
    loadingIndicator = null;
  }

  // 首次 open 时绑定全局键盘监听（常驻，destroy 时移除）
  function ensureKeyDownBound() {
    if (!onKeyDownBound) {
      document.addEventListener("keydown", onKeyDown);
      onKeyDownBound = true;
    }
  }

  return {
    open,
    gotoPage,
    nextPage,
    prevPage,
    scrollToMessage,
    reflow,
    getCurrentChapter: () => chapterIndex,
    getCurrentPage: () => currentPage + 1,
    getTotalPages: () => pages.length,
    ensureKeyDownBound,
    destroy,
  };
}
