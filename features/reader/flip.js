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
//   onRenderedPage    (pageEl) => void 每页渲染完成回调（注入聊天操作按钮等）
//   injectHeadActions (headEl) => void 向页头副标题注入聊天操作按钮占位
//                     （测量容器 head 与显示页 head 必须一致，否则 headTotal 低估、
//                     bodyHeight 高估、正文溢出到页底 dock 被遮挡）

import { hydrateHtmlApps } from "./iframe.js";
import { renderMessagesForMeasure } from "./render.js";

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
    // 测量容器 head 与显示页 head 必须一致：显示页在 renderPage 后由
    // onRenderedPage 注入聊天操作按钮，测量容器若不注入则 headTotal 低估、
    // bodyHeight 高估、正文溢出到页底 dock 被遮挡。此处注入同样的占位
    // （由 index.js 提供，内部受 showReaderChatActions 开关控制）
    if (typeof deps.injectHeadActions === "function") {
      try {
        deps.injectHeadActions(head);
      } catch (err) {
        console.warn("[NovelReader] 测量页头 actions 注入失败:", err);
      }
    }
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
  function binaryCut(block, maxHeight, mount) {
    const { textNodes, total } = collectTextNodes(block);
    if (!textNodes.length || total <= 1) return 0;

    // 临时测量元素挂在测量容器的 .novel-msg-body 下（宽度与 line-height/color
    // 继承上下文与真实页面一致）。用与 block 相同的标签名 + className，
    // 保证块级样式（margin/padding）与真实一致，避免克隆内容到裸 div
    // 导致测量高度偏小而溢出。
    const holder = document.createElement(block.tagName);
    if (block.className) holder.className = block.className;
    mount.appendChild(holder);
    const measureAt = (offset) => {
      holder.innerHTML = "";
      holder.appendChild(clonePrefix(block, textNodes, offset));
      // 加上块自身 margin-bottom：真实页面段落末行的 margin 也占位，
      // 否则测量偏小、按此切分会导致页底溢出、被 dock 遮挡
      return (
        holder.offsetHeight +
        (parseFloat(getComputedStyle(block).marginBottom) || 0)
      );
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
  function splitByHeight(block, maxHeight, mount) {
    const { textNodes, total } = collectTextNodes(block);
    if (!textNodes.length) return null;
    const cut = binaryCut(block, maxHeight, mount);
    if (cut <= 0 || cut >= total) return null; // 第一行放不下 / 整块放得下（调用方已排除）
    return splitBlock(block, textNodes, cut);
  }

  /** 分页：遍历测量容器中的消息，逐块放入各页。
   * 每页内容包回 .novel-msg 容器（复制源消息的 className + data-*），
   * 保持「.novel-msg > .novel-msg-head / .novel-msg-body / .novel-swipe-bar」
   * 完整结构——否则依赖该结构的全部机制失效：
   *   - 内联样式选择器（.novel-msg-body q::before/after、strong/em/blockquote/code
   *     颜色等）失效，<q> 出现 UA 默认双层引号、粗体/斜体颜色丢失；
   *   - swipe 版本切换的事件委托 closest(".novel-msg") 失效，切换与覆盖记录失效；
   *   - .novel-msg:hover .novel-swipe-bar 显隐失效。
   * 消息头/切换条固定在该消息第一页；正文跨页时后续页为仅有 .novel-msg-body
   * 的 .novel-msg（无头/切换条，连续阅读）。 */
  function paginateMessages(list, bodyHeight) {
    // 翻页模式消息间距（.novel-flip-page-body .novel-msg 的 margin-bottom）。
    // 块级 margin 不进 offsetHeight，但真实页面会占空间：
    //   - 相邻两条消息之间：一条可见间隔（新页第一条消息的 margin 与上一页
    //     内容无关，故只需在本页放入第二条及以上消息时预留一次）；
    //   - 页内最后一条消息的 margin 会溢出到页底 padding，被 overflow hidden
    //     裁切，视觉无差但会让可用高度高估 → 每条消息预留一次即可精确分页。
    let msgGap = 0;
    const firstMsgEl = list.children[0];
    if (firstMsgEl) {
      msgGap = parseFloat(getComputedStyle(firstMsgEl).marginBottom) || 0;
    }

    // 页底 swipe dock 高度：有多个版本的消息所在页需在底部预留 dock 空间
    // （正文永不填满到 dock 区域，切换条落在「文字与底部栏之间的空挡」，
    // 不遮挡文字）。取条高 + 容器上下 padding + 呼吸空间。
    // 注意：预留必须大于 dock 容器实际占高（条高 + padding 4px + border），
    // 且 bodyHeight 略高估（pageHeight - padding - headTotal 与真实几何有
    // 亚像素差），否则切换条会紧贴正文最后一行、视觉上仍像遮挡。
    // 12px 呼吸空间让切换条明确悬浮在文字下方的空隙中。
    let dockHeight = 0;
    for (const msgEl of list.children) {
      const bar = msgEl.querySelector(".novel-swipe-bar");
      if (bar) {
        dockHeight = (bar.offsetHeight || 0) + 6 + 12;
        break;
      }
    }

    const pages = [];
    const state = { current: null };
    const newPage = () => {
      state.current = {
        frag: document.createDocumentFragment(),
        msgOffsets: new Set(),
        left: bodyHeight,
        used: false, // 该页是否已放入内容（用于「当前页空则强制放入」判断）
        // 消息下标 → 该页的 .novel-msg 容器（懒创建，复制源 className + data-*）
        msgEls: new Map(),
        // 页底 swipe dock：本页含多个版本的消息时预留 dock 高度并收集切换条
        dockReserved: false, // 本页是否已预留 dock 高度
        dockBars: [], // 本页 dock 要显示的切换条（克隆，带版本状态 data-*）
        dockBarMsgs: new Set(), // 已加入本页 dock 的消息下标（同页去重）
      };
      pages.push(state.current);
    };
    newPage();

    // 记录当前页归属的消息下标（供 scrollToMessage / relayout 保持定位）
    const mark = (mi) => state.current.msgOffsets.add(mi);

    // 页底 swipe dock：消息含多个版本时，把它归属页的切换条收集到该页 dock。
    // 跨页消息的每一页都会带上切换条（用户在任何页都能切换版本）。

    const ensureDockForMsg = (mi, srcMsg) => {
      if (!srcMsg.querySelector(".novel-swipe-bar")) return; // 无多版本
      if (state.current.dockBarMsgs.has(mi)) return; // 本页已加入
      state.current.dockBarMsgs.add(mi);
      if (!state.current.dockReserved) {
        state.current.dockReserved = true;
        state.current.left -= dockHeight; // 预留页底 dock 空间
      }
      const bar = srcMsg.querySelector(".novel-swipe-bar").cloneNode(true);
      // dock 内条不在 .novel-msg 内：把版本状态复制到条自身，事件委托从条读取
      bar.dataset.mesId = srcMsg.dataset.mesId || "";
      bar.dataset.swipeTotal = srcMsg.dataset.swipeTotal || "1";
      bar.dataset.swipeIdx = srcMsg.dataset.swipeIdx || "0";
      bar.dataset.swipeOrigin = srcMsg.dataset.swipeOrigin || "0";
      state.current.dockBars.push(bar);
    };

    // 当前页内消息 mi 的 .novel-msg 容器（懒创建；首次放入时挂到 frag）
    const getMsg = (mi, srcMsg) => {
      // 消息有多个版本：预留本页 dock 高度并收集切换条
      ensureDockForMsg(mi, srcMsg);
      let el = state.current.msgEls.get(mi);
      if (!el) {
        el = document.createElement("div");
        // 复制源消息的 className（novel-msg / novel-msg-user / novel-msg-system）
        // 与 data-*（mesId / swipeIdx / swipeTotal / swipeOrigin），
        // 保证说话人配色、swipe 委托与覆盖记录在分页后仍可用
        el.className = srcMsg.className;
        for (const attr of srcMsg.attributes) {
          if (attr.name.startsWith("data-")) {
            el.setAttribute(attr.name, attr.value);
          }
        }
        state.current.frag.appendChild(el);
        state.current.msgEls.set(mi, el);
        // 预留本条消息的 margin-bottom（.novel-flip-page-body .novel-msg 的
        // margin-bottom: 12px 真实占位）。每条消息都扣（含跨页续页的第一条、
        // 页内最后一条），否则显示时 margin 会把内容底推到贴近 dock 顶部。
        // 强制放入分支（空页截断）在 target() 之后把 left 归零，此处扣减无影响。
        if (msgGap > 0) {
          state.current.left -= msgGap;
        }
      }
      return el;
    };

    // 当前页内消息 mi 的 .novel-msg-body（在该页的 .novel-msg 内懒创建）
    const getBody = (mi, srcMsg) => {
      const msgEl = getMsg(mi, srcMsg);
      let body = msgEl.querySelector(".novel-msg-body");
      if (!body) {
        body = document.createElement("div");
        body.className = "novel-msg-body";
        msgEl.appendChild(body);
      }
      return body;
    };

    /** 放置不可分割块 / 消息头 / 切换条：放不下换页（当前页空则强制放入截断）
     * @param {boolean} inBody true = 正文内容（放进 .novel-msg-body），
     *                         false = 消息头/切换条（直接放进 .novel-msg） */
    const placeFixed = (node, mi, srcMsg, inBody) => {
      // 块在文档流中的实际占高 = offsetHeight + marginBottom（真实页面块间有
      // margin 会额外占空间，只扣 offsetHeight 会让内容溢出页底、被 dock 遮挡）
      const cs = getComputedStyle(node);
      const h = (node.offsetHeight || 0) + (parseFloat(cs.marginBottom) || 0);
      const target = () => (inBody ? getBody(mi, srcMsg) : getMsg(mi, srcMsg));
      // 先预留本页 dock 高度（ensureDockForMsg 内部按消息去重，重复调用安全），
      // 使下方「放得下」判断基于扣完 dock 的余量——否则 getBody/getMsg 内扣 dock
      // 发生在判断之后，会高估可用高度，把本应换页的块多放进来，正文溢出被 dock 遮挡
      ensureDockForMsg(mi, srcMsg);
      if (h <= state.current.left + 1) {
        target().appendChild(node.cloneNode(true));
        state.current.left -= h;
        mark(mi);
        state.current.used = true;
        return;
      }
      if (!state.current.used) {
        target().appendChild(node.cloneNode(true));
        state.current.left = 0;
        mark(mi);
        state.current.used = true;
        return;
      }
      newPage();
      target().appendChild(node.cloneNode(true));
      // 换页后 left 在 target()（getMsg）里已被 dock 预留扣减，
      // 这里累减块高即可保留 dock 预留（不能用 = bodyHeight - h 覆盖）
      state.current.left -= h;
      mark(mi);
      state.current.used = true;
    };

    /** 放置可切分文本块：放不下行级二分，head 填当前页、tail 开新页循环
     * @param {HTMLElement} measureBody 测量容器中该消息的 .novel-msg-body
     *   （tail 挂载到其下测高，保证 line-height/color 等继承上下文与真实页面一致） */
    const placeSplittable = (node, mi, srcMsg, measureBody) => {
      let n = node;
      for (;;) {
        // tail（二分切分产生的新元素）尚未插入测量 DOM，先挂载才能测高
        if (!n.isConnected) measureBody.appendChild(n);
        // 同上：占高含 margin-bottom，避免溢出
        const cs = getComputedStyle(n);
        const h = (n.offsetHeight || 0) + (parseFloat(cs.marginBottom) || 0);
        // 同 placeFixed：先预留本页 dock 高度，再判断放不放得下
        // （getBody → getMsg → ensureDockForMsg 的扣减发生在判断之后）
        ensureDockForMsg(mi, srcMsg);
        if (h <= state.current.left + 1) {
          getBody(mi, srcMsg).appendChild(n.cloneNode(true));
          state.current.left -= h;
          mark(mi);
          state.current.used = true;
          return;
        }
        // 当前页为空且整块超高：二分必能切出一部分（切不出则强制放入截断）。
        // maxHeight 用已扣 dock 预留的 left（不能用 bodyHeight，否则头部会
        // 溢出到 dock 区域；此时 left 可能因 dock 高度过小而切不出 → 下方截断）
        if (!state.current.used) {
          const r = splitByHeight(n, state.current.left, measureBody);
          if (r) {
            getBody(mi, srcMsg).appendChild(r.head);
            // 本页已满（含 dock 预留区）：left 归零即可（内容为超高块头部）
            state.current.left = 0;
            mark(mi);
            state.current.used = true;
            newPage();
            n = r.tail;
            continue;
          }
          getBody(mi, srcMsg).appendChild(n.cloneNode(true));
          state.current.left = 0;
          mark(mi);
          state.current.used = true;
          return;
        }
        // 当前页有内容但放不下：二分切分
        const r = splitByHeight(n, state.current.left, measureBody);
        if (!r) {
          // 切不出（行高大于当前余量）：换页重试
          newPage();
          continue;
        }
        getBody(mi, srcMsg).appendChild(r.head);
        state.current.left = 0;
        mark(mi);
        state.current.used = true;
        newPage();
        n = r.tail;
      }
    };

    Array.from(list.children).forEach((msg, mi) => {
      const head = msg.querySelector(".novel-msg-head");
      const body = msg.querySelector(".novel-msg-body");

      // 消息头：固定在该消息第一页（放进 .novel-msg）
      if (head) placeFixed(head, mi, msg, false);
      // 版本切换条：不放入文档流——由 ensureDockForMsg 收集到该消息所属
      // 各页的页底 dock（跨页消息每一页都有切换入口，随时可切换版本）
      // 正文块逐个放置：包进该页的 .novel-msg-body（保持内联样式选择器生效）
      if (body) {
        Array.from(body.children).forEach((b) => {
          if (b.matches(UNSPLITTABLE)) placeFixed(b, mi, msg, true);
          else placeSplittable(b, mi, msg, body);
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
    // 容器已脱离文档（被清空/移除）时不再分页：尺寸归 0 会导致分页算法
    // 产出大量页面，且对已移除 DOM 的同步测量白白阻塞主线程
    if (!chapter || !scrollEl || !scrollEl.isConnected) return;

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

    // 页底 swipe dock：分页时已把本页各多版本消息的切换条克隆进
    // pageData.dockBars（含版本状态 data-*），渲染时逐一挂到 dock 容器。
    // dock absolute 定位在页体底部，正文分页时已预留 dock 高度（不填满到底），
    // 故切换条落在「文字与底部栏之间的空挡」，不遮挡文字。
    const dockBars = pageData.dockBars || [];
    if (dockBars.length) {
      const swipeDock = document.createElement("div");
      swipeDock.className = "novel-flip-page-swipe";
      dockBars.forEach((bar) => swipeDock.appendChild(bar.cloneNode(true)));
      body.appendChild(swipeDock);
    }

    // 楼层版本切换（翻页模式自绑定，不调用 render.js 的 bindSwipeBarEvents——
    // 其 switchMessageSwipe 就地替换 .novel-msg-body 会导致页内溢出，
    // 翻页模式必须走「记录 override + 整章重排」路径保持一致高度）
    pageEl.addEventListener("click", (e) => {
      const btn = e.target.closest(
        "[data-swipe-prev], [data-swipe-next], [data-swipe-reset]",
      );
      if (btn) {
        const bar = btn.closest(".novel-swipe-bar");
        if (!bar) return;
        const key = bar.dataset.mesId || "";
        const total = Number(bar.dataset.swipeTotal || 0);
        if (!key || total < 2) return;
        let idx = Number(bar.dataset.swipeIdx || 0);
        const origin = Number(bar.dataset.swipeOrigin || 0);
        if (btn.hasAttribute("data-swipe-prev")) {
          idx = (idx - 1 + total) % total;
        } else if (btn.hasAttribute("data-swipe-next")) {
          idx = (idx + 1) % total;
        } else {
          idx = origin; // ↺ 回到酒馆最初选中版本
        }
        // 记录覆盖版本（重排时测量/显示都用用户选择的版本）
        swipeOverrides.set(key, idx);
        scheduleRelayout({ keepMsg: firstMsgOf(currentPage) });
        return;
      }
      // 手动输入跳转：点击计数「1/N」→ 数字输入框（复用 render.js 同款交互）
      const jump = e.target.closest("[data-swipe-jump]");
      if (jump && !jump.dataset.swipeInput) {
        startSwipeJump(jump);
      }
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

  /**
   * 把计数「1/N」就地切换为数字输入框（保持 .novel-swipe-count 类名，便于样式复用）。
   * 输入范围 1~N，Enter/失焦确认跳转（记录 override + 整章重排），Escape 取消。
   */
  function startSwipeJump(countEl) {
    if (countEl.dataset.swipeInput === "1") return; // 已处于输入态
    // 状态读取源：dock 内的条不在 .novel-msg 内（renderPage 已把版本状态复制到条上）；
    // 仍在消息内的条则回退到 .novel-msg 读取（兼容测量/直接调用路径）
    const bar = countEl.closest(".novel-swipe-bar");
    const stateEl = bar ?? countEl.closest(".novel-msg");
    if (!stateEl) return;
    const total = Number(stateEl.dataset.swipeTotal || 0);
    if (total < 2) return;
    const current = Number(stateEl.dataset.swipeIdx || 0) + 1;
    countEl.dataset.swipeInput = "1";
    countEl.textContent = "";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = String(total);
    input.step = "1";
    input.value = String(current);
    input.className = "novel-swipe-input";
    input.setAttribute("aria-label", "跳转到指定版本");
    countEl.appendChild(input);
    input.focus();
    input.select();

    /** 结束输入态并恢复计数显示 */
    const finish = () => {
      countEl.dataset.swipeInput = "";
      const cur =
        countEl.closest(".novel-swipe-bar")?.dataset.swipeIdx ||
        countEl.closest(".novel-msg")?.dataset.swipeIdx ||
        0;
      countEl.textContent = `${Number(cur) + 1}/${total}`;
    };
    /** 读取输入并跳转（越界自动夹取到 1~N） */
    const commit = () => {
      const raw = Number(input.value);
      const target =
        Number.isFinite(raw) && raw >= 1 ? Math.min(Math.round(raw), total) : 0;
      if (target) {
        const key = stateEl.dataset.mesId || "";
        if (key) {
          swipeOverrides.set(key, target - 1);
          scheduleRelayout({ keepMsg: firstMsgOf(currentPage) });
        }
      }
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        input.blur(); // 交由 blur 统一收尾（commit + finish），避免与失焦重复触发
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        input.value = "";
        input.blur(); // 取消：清空输入再失焦，blur 里 commit 因空值不跳转，仅恢复计数
      }
    });
    input.addEventListener("blur", () => {
      commit();
      finish();
    });
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
    // 容器脱离文档时跳过（被清空/移除后 observer 残留回调的兜底）
    if (!scrollEl || !scrollEl.isConnected || !chapterIndex) return;
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
