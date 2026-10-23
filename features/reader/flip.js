// features/reader/flip.js
// 翻页阅读核心（「阅读方式 = 翻页」，类似番茄小说「仿真」模式：整页切换、一屏一页、不滚动）。
//
// 原理：
//   1. 整章消息渲染到隐藏测量容器（宽度与正文一致，屏幕外定位故可正常测量高度）。
//   2. 按「一屏一页」把正文逐块切分为 N 页：
//      - 文本块（p/div/span 等）放不下时用 Range 行级二分，保留行内格式
//        （粗体/链接/引用等），头部放当前页、尾部开新页继续；
//      - 不可分割元素（img/iframe/pre/table/ul/ol/blockquote/HTML应用/hr 等）整块独占。
//   3. 每页固定高度 + overflow hidden（不滚动），页头复用 reader.buildChapterHeader
//      显示「第N章（p/N）」。
//   4. 楼层版本切换（swipe）：切换后整章重新分页（章节消息少，成本极低），
//      尽量回到切换消息所在页；字号/主题/窗口大小变化同理触发 relayout。
//
// 依赖注入 deps：
//   reader            reader core（需暴露 getChapter / buildChapterHeader / getChatInfo）
//   userName          用户显示名（渲染消息兜底）
//   getHtmlAppRootEl  阅读器根元素（HTML 应用水合用）
//   getFontSize       () => string 当前用户字号（如 "16px"；测量容器与真实页面统一应用，
//                     保证「按用户字号分页 → 按用户字号显示」一致）
//   onPageChange      (chapterIndex, page, total) => void 翻页/换章回调（更新底部栏 + 保存进度）

import { hydrateHtmlApps } from "./iframe.js";
import { bindSwipeBarEvents, renderMessagesForMeasure } from "./render.js";

// 页面上下 padding（与 .novel-flip-page CSS 的 padding: 24px 16px 保持一致）
const PAGE_PADDING_V = 48;

/** 统一为 inner 应用用户字号（测量容器与真实页面一致；无 getFontSize 时跳过） */
function applyFontSize(deps, inner) {
  const size = typeof deps.getFontSize === "function" ? deps.getFontSize() : "";
  if (size && inner) inner.style.fontSize = size;
}

// 不可分割（整块独占、不参与行级二分）的元素选择器
const UNSPLITTABLE =
  "img,iframe,pre,table,ul,ol,blockquote,hr,audio,video,.novel-html-app";

/**
 * 创建翻页阅读核心。
 * @param {object} deps 依赖注入（见文件头注释）
 * @returns {object} flip reader API
 */
export function createFlipReader(deps) {
  const { reader, onPageChange } = deps;

  let scrollEl = null; // 正文容器（.novel-reader-scroll，翻页模式关闭滚动）
  let chapterIndex = 0; // 当前章节索引（从 1 开始）
  let pages = []; // 分页结果：每页 { frag, msgOffsets, left }
  let currentPage = 0; // 当前页码（0 起）
  let swipeRefs = new Map(); // 楼层版本引用表（renderMessagesForMeasure 返回）
  let swipeOverrides = new Map(); // mesId → 覆盖版本号（用户 swipe 切换后重排保持）
  let measureEl = null; // 隐藏测量容器
  let measureHead = null; // 测量容器中的页头元素
  let measureBody = null; // 测量容器中的页体元素（用于计算页头占用高度）
  let observer = null; // ResizeObserver（窗口/图片/iframe 尺寸变化 → 重排）
  let renderSeq = 0; // 分页竞态防护序号（快速换章时丢弃过期结果）
  let relayoutTimer = 0; // relayout 防抖定时器

  /** 页码夹取 */
  const clampPage = (p) => Math.max(0, Math.min(p, pages.length - 1));

  /** 构建隐藏测量容器（宽度与正文一致，屏幕外定位可正常测量） */
  function buildMeasureContainer(chapter) {
    const el = document.createElement("div");
    el.className = "novel-flip-measure";
    // 测量容器宽度 = 正文容器宽度；内部 .novel-flip-page 的 padding 与真实页面一致
    // （真实页面 scrollEl → .novel-flip-page；测量容器 el → .novel-flip-page，
    //  两层结构相同，故宽度取 scrollEl.clientWidth 即可让 page 内容宽度一致）
    if (scrollEl) {
      el.style.width = `${Math.max(0, scrollEl.clientWidth || 0)}px`;
    }

    // 与 .novel-flip-page 相同结构（padding 由 CSS 提供），仅高度不限制
    const page = document.createElement("div");
    page.className = "novel-flip-page";
    const head = document.createElement("div");
    head.className = "novel-flip-page-head";
    const { titleEl, subtitleEl } = reader.buildChapterHeader(chapter, {});
    head.appendChild(titleEl);
    head.appendChild(subtitleEl);
    const body = document.createElement("div");
    body.className = "novel-flip-page-body";
    const inner = document.createElement("div");
    inner.className = "novel-reader-inner";
    const list = document.createElement("div");
    list.className = "novel-msg-list";
    inner.appendChild(list);
    body.appendChild(inner);
    page.appendChild(head);
    page.appendChild(body);
    el.appendChild(page);
    document.body.appendChild(el);
    // 测量容器与真实页面统一字号（分页按用户字号测量）
    applyFontSize(deps, inner);

    measureEl = el;
    measureHead = head;
    measureBody = body;
    return list;
  }

  /** 收集块内非空文本节点及其累计偏移 */
  function collectTextNodes(block) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    let total = 0;
    while ((node = walker.nextNode())) {
      if (!node.data || !node.data.length) continue;
      textNodes.push({ node, start: total, end: total + node.data.length });
      total += node.data.length;
    }
    return { textNodes, total };
  }

  /** 用 Range 克隆 block 内 [0, offset) 的内容（不修改原 DOM，供二分测量） */
  function clonePrefix(block, textNodes, offset) {
    let target = textNodes[textNodes.length - 1].node;
    let charInNode = target.data.length;
    for (const tn of textNodes) {
      if (offset <= tn.end) {
        target = tn.node;
        charInNode = offset - tn.start;
        break;
      }
    }
    const range = document.createRange();
    range.setStart(textNodes[0].node, 0);
    range.setEnd(target, charInNode);
    return range.cloneContents();
  }

  /**
   * 行级二分：找 block 内最大的文本偏移 cut，使 [0, cut) 的高度 ≤ maxHeight。
   * @returns {number} 最佳切分偏移（0 = 第一行都放不下；total = 整块放得下）
   */
  function binaryCut(block, maxHeight, list) {
    const { textNodes, total } = collectTextNodes(block);
    if (!textNodes.length || total <= 1) return 0;

    // 临时测量元素挂在测量容器的 .novel-msg-list 下（宽度上下文与正文一致）。
    // 用与 block 相同的标签名 + className，保证块级样式（margin/padding）与真实一致，
    // 避免克隆内容到裸 div 导致测量高度偏小而溢出。
    const holder = document.createElement(block.tagName);
    if (block.className) holder.className = block.className;
    list.appendChild(holder);
    const measureAt = (offset) => {
      holder.innerHTML = "";
      holder.appendChild(clonePrefix(block, textNodes, offset));
      return holder.offsetHeight;
    };

    let lo = 1;
    let hi = total;
    let best = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (measureAt(mid) <= maxHeight) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    holder.remove();
    return best;
  }

  /**
   * 在指定偏移处物理切开 block，生成 head（DocumentFragment）与 tail（新元素）。
   * 用 splitText 在切点把文本节点拆开，再分别用 Range 克隆前后两段，
   * 保留块内原有行内格式（粗体/链接等）。
   */
  function splitBlock(block, textNodes, offset) {
    // 定位切点文本节点与节点内偏移
    let target = null;
    let charInNode = 0;
    for (const tn of textNodes) {
      if (offset <= tn.end) {
        target = tn.node;
        charInNode = offset - tn.start;
        break;
      }
    }
    if (!target) {
      target = textNodes[textNodes.length - 1].node;
      charInNode = target.data.length;
    }

    // 物理切开：target 变前半（长度 charInNode），tailNode 为后半
    let tailNode;
    if (charInNode === 0) {
      tailNode = target; // 切点恰在节点开头：后半从该节点开始，无需 splitText
    } else {
      tailNode = target.splitText(charInNode);
    }

    // head = [0, offset)
    const headRange = document.createRange();
    headRange.setStart(textNodes[0].node, 0);
    headRange.setEnd(target, charInNode);
    const head = headRange.cloneContents();

    // tail = [offset, 末尾)：从 tailNode 到块内最后一个非空文本节点
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let lastText = null;
    let node;
    while ((node = walker.nextNode())) {
      if (node.data.length) lastText = node;
    }
    const tailRange = document.createRange();
    if (lastText && lastText !== tailNode) {
      tailRange.setStart(tailNode, 0);
      tailRange.setEnd(lastText, lastText.data.length);
    } else {
      tailRange.selectNodeContents(tailNode);
    }
    const tail = document.createElement(block.tagName);
    tail.appendChild(tailRange.cloneContents());
    if (block.className) tail.className = block.className;

    return { head, tail };
  }

  /** 将块按行级二分切分：head 放当前页，tail 返回继续处理 */
  function splitByHeight(block, maxHeight, list) {
    const { textNodes, total } = collectTextNodes(block);
    if (!textNodes.length) return null;
    const cut = binaryCut(block, maxHeight, list);
    if (cut <= 0 || cut >= total) return null; // 第一行放不下 / 整块放得下（调用方已排除）
    return splitBlock(block, textNodes, cut);
  }

  /** 分页：遍历测量容器中的消息，逐块放入各页 */
  function paginateMessages(list, bodyHeight) {
    const pages = [];
    const state = { current: null };
    const newPage = () => {
      state.current = {
        frag: document.createDocumentFragment(),
        msgOffsets: new Set(),
        left: bodyHeight,
      };
      pages.push(state.current);
    };
    newPage();

    // 记录当前页归属的消息下标（供 scrollToMessage / relayout 保持定位）
    const mark = (mi) => state.current.msgOffsets.add(mi);

    /** 放置不可分割块 / 消息头 / 切换条：放不下换页（当前页空则强制放入截断） */
    const placeFixed = (node, mi) => {
      const h = node.offsetHeight || 0;
      if (h <= state.current.left + 1) {
        state.current.frag.appendChild(node.cloneNode(true));
        state.current.left -= h;
        mark(mi);
        return;
      }
      if (state.current.frag.childNodes.length === 0) {
        state.current.frag.appendChild(node.cloneNode(true));
        state.current.left = 0;
        mark(mi);
        return;
      }
      newPage();
      state.current.frag.appendChild(node.cloneNode(true));
      state.current.left = bodyHeight - h;
      mark(mi);
    };

    /** 放置可切分文本块：放不下行级二分，head 填当前页、tail 开新页循环 */
    const placeSplittable = (node, mi) => {
      let n = node;
      for (;;) {
        // tail（二分切分产生的新元素）尚未插入测量 DOM，先挂载才能测高
        if (!n.isConnected) list.appendChild(n);
        const h = n.offsetHeight || 0;
        if (h <= state.current.left + 1) {
          state.current.frag.appendChild(n.cloneNode(true));
          state.current.left -= h;
          mark(mi);
          return;
        }
        // 当前页为空且整块超高：二分必能切出一部分（切不出则强制放入截断）
        if (state.current.frag.childNodes.length === 0) {
          const r = splitByHeight(n, bodyHeight, list);
          if (r) {
            state.current.frag.appendChild(r.head);
            state.current.left = 0;
            mark(mi);
            newPage();
            n = r.tail;
            continue;
          }
          state.current.frag.appendChild(n.cloneNode(true));
          state.current.left = 0;
          mark(mi);
          return;
        }
        // 当前页有内容但放不下：二分切分
        const r = splitByHeight(n, state.current.left, list);
        if (!r) {
          // 切不出（行高大于当前余量）：换页重试
          newPage();
          continue;
        }
        state.current.frag.appendChild(r.head);
        state.current.left = 0;
        mark(mi);
        newPage();
        n = r.tail;
      }
    };

    Array.from(list.children).forEach((msg, mi) => {
      const head = msg.querySelector(".novel-msg-head");
      const body = msg.querySelector(".novel-msg-body");
      const swipeBar = msg.querySelector(".novel-swipe-bar");

      // 消息头：固定在该消息第一页
      if (head) placeFixed(head, mi);
      // 版本切换条：紧跟消息头（跨页消息的切换入口在该消息第一页）
      if (swipeBar) placeFixed(swipeBar, mi);
      // 正文块逐个放置
      if (body) {
        Array.from(body.children).forEach((b) => {
          if (b.matches(UNSPLITTABLE)) placeFixed(b, mi);
          else placeSplittable(b, mi);
        });
      }
    });

    // 去掉末尾空页（一般不会出现，防御性清理）
    if (
      pages.length > 1 &&
      pages[pages.length - 1].frag.childNodes.length === 0
    ) {
      pages.pop();
    }
    return pages;
  }

  /**
   * 分页：整章渲染到测量容器 → 计算页高 → 逐块切分。
   * 只生成 pages，不渲染页面（由调用方决定渲染哪页）。
   * @param {number} ci 章节索引（从 1 开始）
   */
  async function paginate(ci) {
    const seq = ++renderSeq;
    const chapter = reader.getChapter(ci);
    if (!chapter || !scrollEl) return;

    // 构建测量容器并渲染整章（复用 renderMessage 安全管线，不绑定事件）
    const list = buildMeasureContainer(chapter);
    const info = reader.getChatInfo();
    swipeRefs = await renderMessagesForMeasure(deps, list, chapter.messages, {
      userName: deps.userName,
      avatar: info?.avatar || "",
      swipeOverrides,
    });
    if (seq !== renderSeq) return; // 期间又触发了 open/relayout，丢弃本次结果

    // 页高 = 正文容器可视高度；正文可用高度 = 页高 - 页面 padding - 页头占用
    const pageHeight = scrollEl.clientHeight || 0;
    const headTotal = measureBody
      ? measureBody.offsetTop - measureHead.offsetTop
      : 0;
    const bodyHeight = Math.max(80, pageHeight - PAGE_PADDING_V - headTotal);

    pages = paginateMessages(list, bodyHeight);

    // 测量容器使命完成
    measureEl.remove();
    measureEl = null;
    measureHead = null;
    measureBody = null;
  }

  /** 渲染指定页到正文容器 */
  function renderPage(p) {
    if (!scrollEl) return;
    const pageData = pages[clampPage(p)];
    if (!pageData) return;
    currentPage = clampPage(p);

    scrollEl.innerHTML = "";
    const chapter = reader.getChapter(chapterIndex);
    if (!chapter) {
      scrollEl.innerHTML = `<div class="novel-empty">章节不存在</div>`;
      return;
    }

    // 页面容器：固定高度 + overflow hidden（不滚动）
    const pageEl = document.createElement("div");
    pageEl.className = "novel-flip-page";

    // 页头：章标题 + 「第N章（p/N）」
    const head = document.createElement("div");
    head.className = "novel-flip-page-head";
    const { titleEl, subtitleEl } = reader.buildChapterHeader(chapter, {
      pageText: `${currentPage + 1}/${pages.length}`,
    });
    head.appendChild(titleEl);
    head.appendChild(subtitleEl);
    pageEl.appendChild(head);

    // 页体：正文（.novel-reader-inner + .novel-msg-list）
    const body = document.createElement("div");
    body.className = "novel-flip-page-body";
    const inner = document.createElement("div");
    inner.className = "novel-reader-inner";
    const list = document.createElement("div");
    list.className = "novel-msg-list";
    inner.appendChild(list);
    body.appendChild(inner);
    pageEl.appendChild(body);
    // 真实页面与测量容器统一字号（显示与分页一致）
    applyFontSize(deps, inner);

    // 挂载页面内容（clone：pages 里的 frag 供反复渲染同一页）
    list.appendChild(pageData.frag.cloneNode(true));

    // 楼层版本切换：每页独立容器各自绑定（事件委托）
    bindSwipeBarEvents(deps, list, swipeRefs);
    // 切换版本后正文长度变化 → 整章重新分页（保持所在消息）
    list.addEventListener("click", (e) => {
      const target = e.target.closest(
        "[data-swipe-prev], [data-swipe-next], [data-swipe-reset], [data-swipe-jump]",
      );
      if (!target) return;
      // 记录覆盖版本（重排时保持用户选择的版本）
      const msgEl = target.closest(".novel-msg");
      if (msgEl) {
        const key = msgEl.dataset.mesId || "";
        const idx = Number(msgEl.dataset.swipeIdx || 0);
        if (key) swipeOverrides.set(key, idx);
      }
      scheduleRelayout({ keepMsg: firstMsgOf(currentPage) });
    });

    // HTML 应用水合（绑定消息监听 + 触发高度同步）
    try {
      hydrateHtmlApps(list, () => deps.getHtmlAppRootEl?.() || null);
    } catch (err) {
      console.warn("[NovelReader] HTML 应用水合失败:", err);
    }

    // 注入正文聊天操作按钮（删除/重命名，复用现有注入逻辑的 DOM 结构）
    if (typeof deps.onRenderedPage === "function") {
      deps.onRenderedPage(pageEl);
    }

    scrollEl.appendChild(pageEl);
    onPageChange?.(chapterIndex, currentPage, pages.length);
  }

  /** 获取某页归属的首个消息下标 */
  function firstMsgOf(p) {
    const pageData = pages[clampPage(p)];
    if (!pageData) return -1;
    return pageData.msgOffsets.size ? Math.min(...pageData.msgOffsets) : -1;
  }

  /** 找到包含指定消息下标的第一页 */
  function findPageForMsg(msgOffset) {
    for (let i = 0; i < pages.length; i += 1) {
      if (pages[i].msgOffsets.has(msgOffset)) return i;
    }
    return -1;
  }

  /**
   * 重排：整章重新分页（字号/主题/窗口大小/图片高度/swipe 切换后调用）。
   * @param {object} [options]
   * @param {number} [options.keepMsg] 重排后回到包含该消息的页（swipe 切换等显式指定；
   *   注意跨页消息会被标记到多页，findPageForMsg 取第一个含它的页，
   *   故仅当调用方明确要"回到某消息"时使用）
   * @param {number} [options.keepPage] 重排后固定的页码（默认保持当前页码）
   */
  async function relayout(options = {}) {
    if (!scrollEl || !chapterIndex) return;
    const { keepMsg = null, keepPage = null } = options;

    await paginate(chapterIndex);

    let target = 0;
    if (keepMsg != null && keepMsg >= 0) {
      const p = findPageForMsg(keepMsg);
      if (p >= 0) target = p;
    } else {
      // 页码锚点：保持当前页码（夹取到有效范围）。
      // 注意不能用 firstMsgOf 做锚——跨页消息会标记到多页，
      // 从第 2 页重排时 findPageForMsg 会退回第 1 页。
      const anchor = keepPage != null ? keepPage : currentPage;
      target = clampPage(anchor);
    }
    renderPage(target);
  }

  /** relayout 防抖（swipe 切换等高频触发时合并） */
  function scheduleRelayout(options = {}) {
    if (relayoutTimer) return;
    relayoutTimer = setTimeout(() => {
      relayoutTimer = 0;
      relayout(options);
    }, 120);
  }

  /** 初始化 ResizeObserver：容器尺寸变化（窗口缩放/图片加载/iframe 高度同步）→ 重排 */
  function initObserver() {
    if (observer) return;
    if (typeof ResizeObserver !== "function") return;
    observer = new ResizeObserver(() => {
      // 页码锚点重排（保持当前页码；不用 firstMsgOf——跨页消息会标记多页，
      // 从第 2 页重排会因 findPageForMsg 取首个含它的页而退回第 1 页）
      if (scrollEl) scheduleRelayout();
    });
    if (scrollEl) observer.observe(scrollEl);
  }

  /**
   * 打开章节：渲染整章 → 分页 → 跳到指定页。
   * @param {HTMLElement} container 正文容器（.novel-reader-scroll）
   * @param {number} ci 章节索引（从 1 开始）
   * @param {number} [startPage=0] 起始页码（0 起，进度恢复用）
   */
  async function open(container, ci, startPage = 0) {
    destroy();
    scrollEl = container;
    chapterIndex = Number(ci) || 0;
    // 翻页模式：正文容器不滚动（一屏一页，滚动交给翻页按钮）
    scrollEl.classList.add("novel-flip-mode");
    initObserver();

    await paginate(chapterIndex);
    if (!scrollEl) return; // 期间被销毁

    // 分页后容器可能被意外滚动（翻页模式不允许滚动，归零）
    scrollEl.scrollTop = 0;
    renderPage(startPage);
  }

  /** 上一页 / 下一页 */
  function pageBy(delta) {
    if (!pages.length) return;
    const target = clampPage(currentPage + delta);
    if (target === currentPage) return;
    renderPage(target);
  }

  /** 跳到指定页（夹取） */
  function goToPage(p) {
    if (!pages.length) return;
    renderPage(clampPage(p));
  }

  /**
   * 跳到包含指定消息的页（搜索结果跳转）。
   * @param {number} msgOffset 章内消息偏移
   */
  function scrollToMessage(msgOffset) {
    const p = findPageForMsg(msgOffset);
    if (p >= 0) renderPage(p);
  }

  /** 当前页码（0 起） */
  function getCurrentPage() {
    return currentPage;
  }

  /** 总页数 */
  function getTotalPages() {
    return pages.length;
  }

  /** 当前章节索引 */
  function getChapterIndex() {
    return chapterIndex;
  }

  /** 卸载：移除观察器 + 清空容器 + 重置状态 */
  function destroy() {
    if (relayoutTimer) {
      clearTimeout(relayoutTimer);
      relayoutTimer = 0;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    // 清理可能残留的测量容器
    if (measureEl) {
      measureEl.remove();
      measureEl = null;
      measureHead = null;
      measureBody = null;
    }
    if (scrollEl) {
      scrollEl.classList.remove("novel-flip-mode");
      scrollEl.innerHTML = "";
    }
    scrollEl = null;
    chapterIndex = 0;
    pages = [];
    currentPage = 0;
    swipeRefs = new Map();
    swipeOverrides = new Map();
    renderSeq += 1; // 使进行中的 paginate 结果作废
  }

  return {
    open,
    pageBy,
    goToPage,
    scrollToMessage,
    relayout,
    // 防抖重排（字号/主题/窗口尺寸等高频变化触发；自动保持当前页首个消息）
    scheduleRelayout,
    getCurrentPage,
    getTotalPages,
    getChapterIndex,
    destroy,
  };
}
