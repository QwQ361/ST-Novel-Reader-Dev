// features/reader/scroll.js
// 连续滚动阅读核心：把多个章节渲染进同一滚动容器，按需滚动加载。
//
// 设计要点：
//   1. 初始只渲染起始章节一个块；滚到接近底部自动在末尾追加下一章；
//      滚到接近顶部自动在开头插入上一章（插入后补偿 scrollTop 保持视口稳定）。
//   2. 当前章节（state.currentChapter）随滚动变化：视口顶部落入哪个章节块即视为当前章，
//      用于底部栏「上一章/下一章」跳转、书签收藏、进度保存的基准。
//   3. 章节块渲染依赖 reader.renderChapterBlock（异步分批渲染），多块并发时用
//      loading 集合去重，避免同一章被重复请求。
//   4. 不销毁已渲染的块（保留滚动位置），仅依赖浏览器滚动容器自然管理内存；
//      destroy() 移除滚动监听并清空容器。

/**
 * 创建连续滚动阅读核心。
 * @param {object} deps 依赖注入
 * @param {object} deps.reader   reader core（需暴露 renderChapterBlock / getChapter / getChatInfo）
 * @param {Function} deps.onCurrentChapterChange  (chapterIndex) => void 当前章变化回调（更新底部栏/书签态）
 * @param {Function} deps.onRenderedChapter       (chapterIndex) => void 单章渲染完成回调（应用样式/注入操作按钮）
 * @param {Function} [deps.getVisibleChapterIndices] () => number[] 目录当前筛选下可见的章节索引序列
 *   （与目录页「都看 / 主线 / 番外」一致；未提供或返回空数组时按全部章节连续加载）
 * @returns {object} scroll reader API
 */
export function createScrollReader(deps) {
  const { reader, onCurrentChapterChange, onRenderedChapter } = deps;

  let scrollEl = null; // 滚动容器（.novel-reader-scroll）
  let totalChapters = 0; // 当前聊天的总章节数
  let onScroll = null; // 滚动监听函数（供 destroy 移除）
  let lastCurrent = 0; // 最近一次判定的当前章索引
  const loading = new Set(); // 正在渲染的章节索引集合（并发去重）
  let visible = []; // 目录当前筛选下可见的章节索引序列（升序，用于连续加载的邻章计算）

  /** 读取当前筛选下可见的章节索引序列；无自定义筛选时返回全部章节索引 */
  function buildVisibleIndices() {
    const custom = deps.getVisibleChapterIndices?.();
    if (Array.isArray(custom)) return custom.slice();
    const info = reader.getChatInfo();
    return (info?.chapters || []).map((ch) => ch.index);
  }

  /**
   * 按可见章节序列求相邻章节（与阅读页「上一章 / 下一章」逻辑一致）。
   * 目标章节不在序列内（如书签跳转到被筛掉的章）时，按章节号就近取。
   * @param {number} idx 参照章节索引
   * @param {number} dir 1 向后 / -1 向前
   * @returns {number|null}
   */
  function findNeighbor(idx, dir) {
    if (!visible.length) return null;
    const pos = visible.indexOf(idx);
    if (pos === -1) {
      if (dir > 0) {
        const found = visible.find((i) => i > idx);
        return found ?? null;
      }
      for (let i = visible.length - 1; i >= 0; i -= 1) {
        if (visible[i] < idx) return visible[i];
      }
      return null;
    }
    const nextPos = pos + dir;
    if (nextPos < 0 || nextPos >= visible.length) return null;
    return visible[nextPos];
  }

  /** 计算章节块在滚动容器内容中的顶部位置（与 offsetParent 无关，最稳妥） */
  function blockTop(block) {
    const scrollRect = scrollEl.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    return blockRect.top - scrollRect.top + scrollEl.scrollTop;
  }

  /**
   * 初始化滚动阅读容器。
   * @param {HTMLElement} container 滚动容器（.novel-reader-scroll）
   * @param {number} startChapter 起始章节（从 1 开始）
   */
  async function open(container, startChapter) {
    destroy(); // 防重入：先清理上一次状态
    scrollEl = container;
    const info = reader.getChatInfo();
    totalChapters = info?.chapters?.length || 0;
    // 目录筛选后可见的章节序列（「都看 / 主线 / 番外」），连续滚动按此序列加载邻章
    visible = buildVisibleIndices();

    // 渲染起始章节块
    await renderChapterBlock(startChapter);

    // 监听滚动：按需追加/前置 + 更新当前章
    onScroll = () => onScrollHandler();
    scrollEl.addEventListener("scroll", onScroll);
    // 首次进入立即判定一次当前章（若起始章内容不足一屏，直接触发追加）
    onScrollHandler();
  }

  /** 滚动处理：按需加载 + 当前章判定（节流到 rAF） */
  function onScrollHandler() {
    if (!scrollEl) return;
    // 用 rAF 节流：连续滚动时避免每帧都触发昂贵逻辑
    if (onScrollHandler.raf) return;
    onScrollHandler.raf = requestAnimationFrame(() => {
      onScrollHandler.raf = 0;
      maybeLoadAround();
      updateCurrentChapter();
    });
  }

  /** 按需加载：接近底部追加下一章，接近顶部插入上一章（按三大目录筛选序列） */
  async function maybeLoadAround() {
    if (!scrollEl) return;
    const el = scrollEl;
    const threshold = Math.max(400, el.clientHeight * 0.8);

    // 接近底部 → 追加下一章（沿筛选序列向后；到序列末尾为止）
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - threshold) {
      const last = getLastLoadedChapter();
      const next = findNeighbor(last, 1);
      if (next) {
        await renderChapterBlock(next);
      }
    }

    // 接近顶部 → 插入上一章（沿筛选序列向前；到序列开头为止），插入后补偿滚动位置
    if (el.scrollTop <= threshold) {
      const first = getFirstLoadedChapter();
      // 无已渲染块时 first = totalChapters+1，此时不存在「上一章」，跳过
      const prev = first <= totalChapters ? findNeighbor(first, -1) : null;
      if (prev) {
        const prevHeight = el.scrollHeight; // 记录插入前的总高度
        await renderChapterBlock(prev, { prepend: true });
        // 视口锚点：插入后保持用户正在看的内容不跳动
        el.scrollTop += el.scrollHeight - prevHeight;
      }
    }
  }

  /**
   * 渲染指定章节块。
   * @param {number} chapterIndex 章节索引（从 1 开始）
   * @param {object} [options]
   * @param {boolean} [options.prepend=false] 是否插入到容器开头（上一章）
   */
  async function renderChapterBlock(chapterIndex, options = {}) {
    const { prepend = false } = options;
    if (!scrollEl) return;
    if (chapterIndex < 1 || chapterIndex > totalChapters) return;
    if (loading.has(chapterIndex)) return; // 并发去重
    // 已渲染过则跳过
    const existing = scrollEl.querySelector(
      `.novel-chapter-block[data-chapter-index="${chapterIndex}"]`,
    );
    if (existing) return;

    loading.add(chapterIndex);
    try {
      // 渲染到临时容器（renderChapterBlock 会 append 到传入容器），再取回移动
      const tmp = document.createElement("div");
      const block = await reader.renderChapterBlock(tmp, chapterIndex);
      if (!block) {
        return;
      }
      if (prepend) {
        scrollEl.insertBefore(block, scrollEl.firstChild);
      } else {
        scrollEl.appendChild(block);
      }
      onRenderedChapter?.(chapterIndex, block);
    } catch (err) {
      console.warn("[NovelReader] 滚动阅读渲染章节失败:", err);
    } finally {
      loading.delete(chapterIndex);
    }
  }

  /** 获取已渲染的最小章节索引（无块时返回 totalChapters+1 表示无） */
  function getFirstLoadedChapter() {
    const first = scrollEl?.querySelector(".novel-chapter-block");
    if (!first) return totalChapters + 1;
    return Number(first.dataset.chapterIndex) || totalChapters + 1;
  }

  /** 获取已渲染的最大章节索引（无块时返回 0 表示无） */
  function getLastLoadedChapter() {
    const blocks = scrollEl?.querySelectorAll(".novel-chapter-block");
    if (!blocks || !blocks.length) return 0;
    let last = 0;
    blocks.forEach((b) => {
      const idx = Number(b.dataset.chapterIndex);
      if (!Number.isNaN(idx) && idx > last) last = idx;
    });
    return last;
  }

  /** 更新当前章：视口顶部落入哪个章节块即视为当前章（块覆盖视口顶则视为当前） */
  function updateCurrentChapter() {
    if (!scrollEl) return;
    const blocks = scrollEl.querySelectorAll(".novel-chapter-block");
    if (!blocks.length) return;
    const viewTop = scrollEl.scrollTop;
    const viewBottom = viewTop + scrollEl.clientHeight;

    let current = 0;
    for (const block of blocks) {
      const idx = Number(block.dataset.chapterIndex);
      const top = blockTop(block);
      const bottom = top + block.offsetHeight;
      // 块覆盖视口顶部区域 → 视为当前章
      if (top <= viewTop && bottom > viewTop) {
        current = idx;
        break;
      }
      // 块起始于视口顶部之下，且尚未确定 → 取视口内最靠上的块
      if (top > viewTop && top < viewBottom) {
        current = idx;
        break;
      }
    }
    // 兜底：视口落在最后一块之后（内容不足一屏）→ 取最后一块
    if (!current) {
      const last = blocks[blocks.length - 1];
      current = Number(last.dataset.chapterIndex) || 0;
    }
    if (current && current !== lastCurrent) {
      lastCurrent = current;
      onCurrentChapterChange?.(current);
    }
  }

  /**
   * 确保目标章节块已渲染，并按章节索引顺序插入到正确位置。
   * 只渲染目标章本身（中间章节交给滚动时的按需加载），避免目录跳远章时
   * 一次性渲染大量章节；目标章被筛选掉（书签/搜索跳转）时同样可用。
   * @param {number} idx 目标章节索引
   */
  async function ensureBlock(idx) {
    if (!scrollEl) return;
    if (idx < 1 || idx > totalChapters) return;
    const existing = scrollEl.querySelector(
      `.novel-chapter-block[data-chapter-index="${idx}"]`,
    );
    if (existing) return;
    if (loading.has(idx)) return;

    // 找到第一个章节索引大于目标块的已有块，插到它之前（保持升序）
    const blocks = scrollEl.querySelectorAll(".novel-chapter-block");
    let refBlock = null;
    for (const b of blocks) {
      const bi = Number(b.dataset.chapterIndex);
      if (!Number.isNaN(bi) && bi > idx) {
        refBlock = b;
        break;
      }
    }

    loading.add(idx);
    try {
      const tmp = document.createElement("div");
      const block = await reader.renderChapterBlock(tmp, idx);
      if (!block || !scrollEl) return;
      if (refBlock && refBlock.isConnected) {
        scrollEl.insertBefore(block, refBlock);
      } else {
        scrollEl.appendChild(block);
      }
      onRenderedChapter?.(idx, block);
    } catch (err) {
      console.warn("[NovelReader] 滚动阅读渲染章节失败:", err);
    } finally {
      loading.delete(idx);
    }
  }

  /** 滚到指定章节（目录点击 / 书签跳转 / 阅读页上一章下一章）：渲染目标章并滚到其顶部 */
  async function scrollToChapter(chapterIndex) {
    if (!scrollEl) return;
    const idx = Number(chapterIndex);
    if (idx < 1 || idx > totalChapters) return;

    await ensureBlock(idx);
    if (!scrollEl) return; // 渲染期间被销毁
    const target = scrollEl.querySelector(
      `.novel-chapter-block[data-chapter-index="${idx}"]`,
    );
    if (target) {
      scrollEl.scrollTop = blockTop(target);
      updateCurrentChapter();
    }
  }

  /** 滚到指定章节内某条消息（搜索结果跳转） */
  async function scrollToMessage(chapterIndex, msgOffset) {
    await scrollToChapter(chapterIndex);
    if (!scrollEl) return;
    const block = scrollEl.querySelector(
      `.novel-chapter-block[data-chapter-index="${chapterIndex}"]`,
    );
    if (!block) return;
    const msg = block.querySelectorAll(".novel-msg")[msgOffset];
    if (!msg) return;
    msg.scrollIntoView({ block: "center" });
    msg.classList.add("novel-msg-highlight");
    setTimeout(() => msg.classList.remove("novel-msg-highlight"), 2500);
  }

  /** 获取当前章索引（供底部栏/进度使用） */
  function getCurrentChapter() {
    return lastCurrent || 0;
  }

  /** 卸载：移除监听 + 清空容器 + 重置状态 */
  function destroy() {
    if (scrollEl && onScroll) {
      scrollEl.removeEventListener("scroll", onScroll);
    }
    if (onScrollHandler.raf) {
      cancelAnimationFrame(onScrollHandler.raf);
      onScrollHandler.raf = 0;
    }
    if (scrollEl) scrollEl.innerHTML = "";
    scrollEl = null;
    totalChapters = 0;
    loading.clear();
    lastCurrent = 0;
    visible = [];
    onScroll = null;
  }

  return {
    open,
    scrollToChapter,
    scrollToMessage,
    getCurrentChapter,
    destroy,
  };
}
