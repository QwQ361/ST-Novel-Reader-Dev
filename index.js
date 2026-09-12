// index.js —— 酒馆小说阅读器 薄入口
// 职责：
//   1) jQuery async 启动
//   2) 依赖组装（deps 依赖注入到各 Core）
//   3) 顶栏按钮注入
//   4) 事件订阅（CHAT_CHANGED / CHARACTER_RENAMED）
//   5) 全屏状态机 UI（书架首页 → 聊天列表 → 目录 → 正文）
//   6) 暴露全局 API（window.NovelReader）
// 业务逻辑一律不放这里，都在 features/ 与 utils/ 中。

import { createBookshelfCore } from "./features/bookshelf/index.js";
import { createProgressCore } from "./features/progress/index.js";
import { createReaderCore } from "./features/reader/index.js";
import {
  getPastCharacterChatsFunc,
  getRequestHeaders,
  getStContext,
  loadStCoreModules,
  renderMarkdownCore,
} from "./integrations/sillytavern.js";
import {
  applyCustomIconCore,
  applyTopbarIconFromConfigCore,
  clearCustomIconCore,
  createTopbarIconAdaptorCore,
  detectNeighborIconCore,
  detectThemeIconsCore,
  extractUrlFromCssCore,
  isImageIconBackgroundCore,
  toCssUrlCore,
} from "./integrations/topbar-icon.js";
import { createOverlayDialog } from "./ui/modal/index.js";
import { cfmTCore, convertText, loadS2T } from "./utils/i18n.js";

const EXT_NAME = "ST-Novel-Reader";

jQuery(async () => {
  console.log("[NovelReader] 启动中…");

  // ---- 1. 加载 ST 核心模块 + 简繁字典（各自失败不阻断） ----
  try {
    await loadStCoreModules();
  } catch (err) {
    console.warn("[NovelReader] ST 核心模块加载异常:", err);
  }
  try {
    await loadS2T();
  } catch (err) {
    console.warn("[NovelReader] 简繁字典加载异常（简繁转换将不可用）:", err);
  }

  const ctx = getStContext();
  if (!ctx) {
    console.warn("[NovelReader] 无法获取 ST 上下文，插件未激活。");
    return;
  }

  // ---- 2. 依赖组装 ----
  const deps = {
    extName: EXT_NAME,
    getStContext,
    getRequestHeaders,
    getPastCharacterChatsFunc,
    userName: ctx.userName || "你",
    // Markdown 安全渲染管线（converter → encodeStyleTags → DOMPurify → decodeStyleTags）
    // 可渲染任意聊天的消息，不依赖全局 chat（ST 的 messageFormatting 做不到）
    renderMarkdown: renderMarkdownCore,
    getSettings: () => ctx.extensionSettings || {},
    saveSettings: () => ctx.saveSettingsDebounced?.(),
    // 界面文本：仅 language === 'zh-TW' 时转繁体
    cfmT: (t) => cfmTCore(t, { settings: ctx.extensionSettings }),
    // 正文转换：默认关（后续设置面板接管），此处提供函数占位
    tc: (t) => convertText(t, false),
  };

  const bookshelf = createBookshelfCore({
    ...deps,
    getCharacters: () => ctx.characters,
  });

  const reader = createReaderCore({
    ...deps,
    getChatMessages: (avatar, fileName) =>
      bookshelf.getChatMessages(avatar, fileName),
  });

  const progress = createProgressCore({ ...deps });

  // ---- 3. 全局设置（extension_settings 持久化） ----
  function getGlobalSettings() {
    const s = deps.getSettings();
    if (!s[EXT_NAME]) s[EXT_NAME] = {};
    const g = s[EXT_NAME];
    g.chaptersPerPage = Number(g.chaptersPerPage) || 100; // 目录每页 N 章，默认 100
    if (!g.readerSettings) g.readerSettings = {}; // 字号/文字色/背景色
    if (!g.readerSettings.fontSize) g.readerSettings.fontSize = 18;
    if (!g.readerSettings.textColor) g.readerSettings.textColor = "";
    if (!g.readerSettings.bgColor) g.readerSettings.bgColor = "";
    if (!g.customTopbarIcon) g.customTopbarIcon = ""; // 自定义顶栏图标 URL（空 = 自动检测）
    return g;
  }

  // ---- 4. UI 引用（全屏弹窗：顶部栏 + 内容区 + 底部栏）----
  let dialogRef = null;
  let topbarEl = null;
  let bodyEl = null;
  let bottombarEl = null;
  let searchInputEl = null;
  let readerScrollEl = null; // 正文滚动容器（.novel-reader-scroll）
  let settingsPanelEl = null; // 界面设置子面板

  // 当前导航状态
  const state = {
    page: "bookshelf", // bookshelf | chats | toc | reader
    currentChar: null, // 当前选中的角色对象
    currentCharIdx: 0, // 当前选中的角色索引
    currentChat: null, // 当前选中的聊天对象
    currentChats: null, // 当前角色的聊天列表（缓存，供筛选）
    currentChapter: 0, // 当前章节索引（1 起）
    tocPage: 0, // 目录分页页码（0 起）
    pendingHighlightOffset: null, // 待定位的消息章内偏移（搜索结果跳转）
  };
  let searchPanelEl = null; // 小说内检索结果面板

  let saveTimer = 0;

  /**
   * 打开主界面弹窗（全屏）。
   */
  function openReaderDialog() {
    if (dialogRef) return;

    const dlg = createOverlayDialog({ title: "", showClose: false });
    dialogRef = dlg;
    dlg.onClose = () => {
      saveLastView(); // 记住关闭前的页面（角色/聊天/章节）
      reader.abort();
      dialogRef = null;
    };

    // 采样 ST 主界面实际渲染色（跟随美化主题），写入 dialog 的 --novel-bg/--novel-fg
    try {
      applyThemeCore(dlg.dialog, sampleStThemeCore());
      // 美化主题的样式可能延迟加载：稍后重采样一次，弹窗仍打开才应用
      setTimeout(() => {
        if (dialogRef === dlg) {
          applyThemeCore(dlg.dialog, sampleStThemeCore());
        }
      }, 300);
    } catch (err) {
      console.warn("[NovelReader] 主题采样失败:", err);
    }

    const content = dlg.content;
    content.className = "novel-shell";

    // ---- 顶部栏（全局设置，常显） ----
    topbarEl = document.createElement("div");
    topbarEl.className = "novel-topbar";
    topbarEl.innerHTML = `
      <div class="novel-topbar-back">
        <button class="novel-icon-btn" data-action="back" title="返回">←</button>
      </div>
      <div class="novel-topbar-title">${escapeHtml(deps.cfmT("酒馆小说阅读器"))}</div>
      <div class="novel-topbar-search">
        <input type="text" placeholder="${escapeHtml(deps.cfmT("搜索角色 / 聊天…"))}" />
      </div>
      <div class="novel-topbar-settings">
        <button class="novel-icon-btn" data-action="settings" title="全局设置">⚙</button>
        <button class="novel-icon-btn novel-icon-close" data-action="close" title="关闭">×</button>
      </div>`;
    content.appendChild(topbarEl);

    // ---- 内容区（状态机切换） ----
    bodyEl = document.createElement("div");
    bodyEl.className = "novel-body";
    content.appendChild(bodyEl);

    // ---- 底部栏（小说设置，仅正文页显示） ----
    bottombarEl = document.createElement("div");
    bottombarEl.className = "novel-bottombar";
    bottombarEl.innerHTML = `
      <button class="novel-btn" data-action="toc">${escapeHtml(deps.cfmT("目录"))}</button>
      <button class="novel-btn" data-action="prev">${escapeHtml(deps.cfmT("上一章"))}</button>
      <button class="novel-btn" data-action="next">${escapeHtml(deps.cfmT("下一章"))}</button>
      <button class="novel-btn" data-action="reader-settings">${escapeHtml(deps.cfmT("界面"))}</button>`;
    content.appendChild(bottombarEl);

    // 搜索框引用
    searchInputEl = topbarEl.querySelector(".novel-topbar-search input");

    // ---- 事件绑定 ----
    bindTopbarEvents();
    bindBottombarEvents();

    // 初始渲染：恢复上次关闭前的页面（无记录则书架首页）
    restoreLastView();
  }

  /** 关闭主界面弹窗 */
  function closeReaderDialog() {
    dialogRef?.close();
  }

  // ============ 关闭位置记忆（重新打开恢复原页面） ============

  /** 保存当前浏览位置到 extension_settings */
  function saveLastView() {
    const g = getGlobalSettings();
    g.lastView = {
      page: state.page,
      charIdx: state.currentCharIdx ?? null,
      charAvatar: state.currentChar?.avatar ?? null,
      charName: state.currentChar?.name ?? null,
      chatFileName: state.currentChat?.file_name ?? null,
      chapter: state.currentChapter || null,
      tocPage: state.tocPage ?? 0,
    };
    deps.saveSettings();
  }

  /** 打开弹窗后按上次记录恢复页面（角色列表变化时按 avatar/name 兜底） */
  async function restoreLastView() {
    const g = getGlobalSettings();
    const last = g.lastView;
    if (!last || !last.page) {
      showBookshelf();
      return;
    }

    // 上次在书架页关闭 → 直接显示书架（不残留 currentChar 走目录/正文分支）
    if (last.page === "bookshelf") {
      showBookshelf();
      return;
    }

    // 恢复失败（聊天被删 / 加载异常等）一律降级回书架，避免空白页
    try {
      await restoreLastViewInner(last);
    } catch (err) {
      console.warn("[NovelReader] 恢复上次视图失败，降级回书架:", err);
      showBookshelf();
    }
  }

  /** restoreLastView 的实际恢复逻辑（异常由外层兜底） */
  async function restoreLastViewInner(last) {
    const g = getGlobalSettings();
    const chars = bookshelf.getCharacters();
    // 优先按 avatar 匹配（角色顺序可能变化），再按索引、最后按名称
    let char = null;
    let charIdx = -1;
    if (last.charAvatar) {
      charIdx = chars.findIndex((c) => c.avatar === last.charAvatar);
      if (charIdx >= 0) char = chars[charIdx];
    }
    if (!char && last.charIdx != null && chars[last.charIdx]) {
      char = chars[last.charIdx];
      charIdx = last.charIdx;
    }
    if (!char && last.charName) {
      charIdx = chars.findIndex((c) => c.name === last.charName);
      if (charIdx >= 0) char = chars[charIdx];
    }
    if (!char) {
      showBookshelf();
      return;
    }

    // 聊天列表页：直接打开该角色聊天列表
    if (last.page === "chats") {
      await openChatList(charIdx, char);
      return;
    }

    // 目录 / 正文页：需要聊天对象（file_name 匹配）
    const chats = await bookshelf.getCharChats(charIdx, char.avatar);
    if (state.currentChar !== char) return; // 已切换
    const chat = (chats || []).find((c) => c.file_name === last.chatFileName);
    if (!chat) {
      // 聊天已被删除 → 显示该角色的聊天列表
      state.currentChats = chats || [];
      setPage("chats");
      topbarEl.querySelector(".novel-topbar-title").textContent = escapeHtml(
        char.name || deps.cfmT("未命名"),
      );
      renderChatListGrid("");
      return;
    }

    await openToc(char, chat);
    state.tocPage = last.tocPage ?? 0;
    if (last.page === "reader" && last.chapter) {
      // 正文页：直接进入上次章节（滚动位置由 progress 自动恢复）
      await openChapter(last.chapter);
    } else if ((last.tocPage ?? 0) > 0) {
      // 目录页：重渲染当前页以应用记忆的页码
      const container = bodyEl.querySelector(".novel-page");
      if (container) renderTocPage(container);
    }
  }

  // ============ 页面状态机 ============

  /** 设置当前页（清空内容区 + 更新顶栏返回按钮 + 搜索框占位/模式） */
  function setPage(page) {
    state.page = page;
    bodyEl.innerHTML = "";
    const backBtn = topbarEl.querySelector('[data-action="back"]');
    const backActions = {
      bookshelf: "close", // 书架页：返回按钮 = 关闭阅读器（退出到 ST 主界面）
      chats: "bookshelf",
      toc: "chats",
      reader: "toc",
    };
    backBtn.dataset.backTarget = backActions[page] || "";
    backBtn.style.display = backActions[page] ? "" : "none";
    // 返回按钮提示：书架页为「退出」，其余页为「返回」
    backBtn.title =
      page === "bookshelf" ? deps.cfmT("退出") : deps.cfmT("返回");
    // 正文页：显示底部栏；其余页隐藏
    bottombarEl.style.display = page === "reader" ? "" : "none";
    // 非正文页恢复顶栏显示（正文页可能被点击隐藏）
    topbarEl.style.display = "";
    bodyEl.classList.remove("novel-chrome-hidden");
    // 搜索框模式：书架/聊天列表 = 列表筛选；目录/正文 = 小说内检索
    searchInputEl.placeholder =
      page === "toc" || page === "reader"
        ? deps.cfmT("搜索本章小说内容…")
        : deps.cfmT("搜索角色 / 聊天…");
    searchInputEl.dataset.mode =
      page === "toc" || page === "reader" ? "chat" : "list";
    if (page === "toc" || page === "reader") {
      searchInputEl.value = "";
    }
    // 关闭可能打开的设置子面板 + 检索结果面板
    closeSettingsPanel();
    closeSearchPanel();
  }

  /** 返回上一页 / 书架页则退出阅读器 */
  function goBack() {
    const backActions = {
      bookshelf: closeReaderDialog, // 书架页：关闭弹窗（退出到 ST 主界面）
      chats: showBookshelf,
      toc: showChats,
      reader: showToc,
    };
    const fn = backActions[state.page];
    if (fn) fn();
  }

  /** 从目录返回聊天列表（用 state.currentChar 重建） */
  async function showChats() {
    if (!state.currentChar) {
      showBookshelf();
      return;
    }
    const idx = state.currentCharIdx ?? 0;
    await openChatList(idx, state.currentChar);
  }

  // ============ 书架首页（角色卡片网格） ============

  function showBookshelf() {
    setPage("bookshelf");
    searchInputEl.value = "";
    topbarEl.querySelector(".novel-topbar-title").textContent =
      deps.cfmT("书架");
    renderBookshelfGrid("");
  }

  /** 渲染书架角色卡片网格（支持按名称实时筛选） */
  function renderBookshelfGrid(query) {
    const q = (query || "").toLowerCase().trim();
    bodyEl.querySelector(".novel-page")?.remove();

    const page = document.createElement("div");
    page.className = "novel-page";
    const chars = bookshelf.getCharacters();
    if (!chars.length) {
      page.innerHTML = `<div class="novel-empty">${escapeHtml(deps.cfmT("暂无角色"))}</div>`;
      bodyEl.appendChild(page);
      return;
    }

    const filtered = q
      ? chars.filter((c) =>
          String(c.name || "")
            .toLowerCase()
            .includes(q),
        )
      : chars;

    if (!filtered.length) {
      page.innerHTML = `<div class="novel-empty">${escapeHtml(deps.cfmT("无匹配角色"))}</div>`;
      bodyEl.appendChild(page);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "novel-grid";
    filtered.forEach((c, idx) => {
      const origIdx = chars.indexOf(c);
      const card = document.createElement("div");
      card.className = "novel-card";
      card.dataset.charIdx = String(origIdx);
      const version = c.char_version ? String(c.char_version) : "";
      card.innerHTML = `
        <div class="novel-card-title">${escapeHtml(c.name || deps.cfmT("未命名"))}</div>
        ${version ? `<div class="novel-card-meta">${escapeHtml(version)}</div>` : ""}`;
      card.addEventListener("click", () => openChatList(origIdx, c));
      grid.appendChild(card);
    });

    page.appendChild(grid);
    bodyEl.appendChild(page);
  }

  // ============ 聊天列表页 ============

  async function openChatList(charIdx, char) {
    state.currentChar = char;
    state.currentCharIdx = charIdx;
    setPage("chats");
    state.currentChats = null;
    topbarEl.querySelector(".novel-topbar-title").textContent = escapeHtml(
      char.name || deps.cfmT("未命名"),
    );

    const page = document.createElement("div");
    page.className = "novel-page";
    page.innerHTML = `<div class="novel-loading">${escapeHtml(deps.cfmT("加载聊天列表…"))}</div>`;
    bodyEl.appendChild(page);

    const chats = await bookshelf.getCharChats(charIdx, char.avatar);
    if (state.page !== "chats" || state.currentChar !== char) return; // 已切换

    state.currentChats = chats;
    renderChatListGrid(searchInputEl.value);
  }

  /** 渲染聊天卡片网格（支持按文件名/预览实时筛选） */
  function renderChatListGrid(query) {
    const q = (query || "").toLowerCase().trim();
    bodyEl.querySelector(".novel-page")?.remove();

    const page = document.createElement("div");
    page.className = "novel-page";
    const chats = state.currentChats || [];
    if (!chats.length) {
      page.innerHTML = `<div class="novel-empty">${escapeHtml(deps.cfmT("暂无聊天记录"))}</div>`;
      bodyEl.appendChild(page);
      return;
    }

    const filtered = q
      ? chats.filter((chat) => {
          const fileName = String(chat.file_name || "").toLowerCase();
          const preview = String(chat.last_mes || "").toLowerCase();
          return fileName.includes(q) || preview.includes(q);
        })
      : chats;

    if (!filtered.length) {
      page.innerHTML = `<div class="novel-empty">${escapeHtml(deps.cfmT("无匹配聊天"))}</div>`;
      bodyEl.appendChild(page);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "novel-grid";
    filtered.forEach((chat) => {
      const fileName = chat.file_name || "";
      const card = document.createElement("div");
      card.className = "novel-card";
      // meta 行只拼接非空字段段，段间用「 · 」连接，避免出现悬空点
      const metaParts = [
        chat.chat_items ?? chat.message_count ?? "",
        chat.last_mes_timestamp ?? chat.create_date ?? "",
      ]
        .map((v) => String(v).trim())
        .filter(Boolean);
      card.innerHTML = `
        <div class="novel-card-title">${escapeHtml(String(fileName).replace(/\.jsonl$/i, ""))}</div>
        <div class="novel-card-preview">${escapeHtml(String(chat.last_mes || ""))}</div>
        ${metaParts.length ? `<div class="novel-card-meta">${metaParts.map((v) => escapeHtml(v)).join(" · ")}</div>` : ""}`;
      card.addEventListener("click", () =>
        openToc(state.currentChar, { file_name: fileName }),
      );
      grid.appendChild(card);
    });
    page.appendChild(grid);
    bodyEl.appendChild(page);
  }

  // ============ 目录页（分页章节列表） ============

  async function openToc(char, chat) {
    state.currentChar = char;
    state.currentChat = chat;
    state.tocPage = 0;
    setPage("toc");
    topbarEl.querySelector(".novel-topbar-title").textContent = escapeHtml(
      String(chat.file_name || "").replace(/\.jsonl$/i, ""),
    );

    const page = document.createElement("div");
    page.className = "novel-page";
    page.innerHTML = `<div class="novel-loading">${escapeHtml(deps.cfmT("加载章节…"))}</div>`;
    bodyEl.appendChild(page);

    const info = await reader.loadChat({
      avatar: char.avatar,
      fileName: chat.file_name,
    });
    if (state.page !== "toc" || state.currentChat !== chat) return; // 已切换

    if (!info || !info.chapters.length) {
      page.innerHTML = `<div class="novel-empty">${escapeHtml(deps.cfmT("该聊天暂无内容"))}</div>`;
      return;
    }

    renderTocPage(page);
  }

  /** 渲染目录分页（每页 N 章） */
  function renderTocPage(container) {
    const g = getGlobalSettings();
    const perPage = g.chaptersPerPage;
    const info = reader.getChatInfo();
    if (!info) return;
    const chapters = info.chapters;
    const total = chapters.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const start = state.tocPage * perPage;
    const pageChapters = chapters.slice(start, start + perPage);

    container.innerHTML = "";
    const toc = document.createElement("div");
    toc.className = "novel-toc";
    toc.innerHTML = `
      <div class="novel-toc-head">
        <h2>${escapeHtml(deps.cfmT("目录"))}</h2>
        <span class="novel-toc-sub">${escapeHtml(String(total))} ${escapeHtml(deps.cfmT("章"))}</span>
      </div>
      <div class="novel-toc-list"></div>`;

    const list = toc.querySelector(".novel-toc-list");
    pageChapters.forEach((ch) => {
      const item = document.createElement("div");
      item.className = "novel-toc-item";
      item.innerHTML = `
        <span class="novel-toc-item-num">${escapeHtml(String(ch.index))}</span>
        <span class="novel-toc-item-title">${escapeHtml(deps.cfmT("第") + String(ch.index) + deps.cfmT("章"))}</span>`;
      item.addEventListener("click", () => openChapter(ch.index));
      list.appendChild(item);
    });

    // 分页控件
    if (totalPages > 1) {
      const pager = document.createElement("div");
      pager.className = "novel-pager";
      const prevBtn = document.createElement("button");
      prevBtn.className = "novel-icon-btn";
      prevBtn.textContent = "←";
      prevBtn.disabled = state.tocPage <= 0;
      prevBtn.addEventListener("click", () => {
        state.tocPage -= 1;
        renderTocPage(container);
      });
      const infoEl = document.createElement("span");
      infoEl.className = "novel-pager-info";
      infoEl.textContent = `${state.tocPage + 1} / ${totalPages}`;
      const nextBtn = document.createElement("button");
      nextBtn.className = "novel-icon-btn";
      nextBtn.textContent = "→";
      nextBtn.disabled = state.tocPage >= totalPages - 1;
      nextBtn.addEventListener("click", () => {
        state.tocPage += 1;
        renderTocPage(container);
      });
      pager.appendChild(prevBtn);
      pager.appendChild(infoEl);
      pager.appendChild(nextBtn);
      toc.appendChild(pager);
    }

    container.appendChild(toc);
  }

  // ============ 正文阅读页（按章渲染） ============

  /**
   * 打开章节并可定位到指定消息（搜索结果跳转）。
   * @param {number} chapterIndex 章节号（从 1 开始）
   * @param {number} [msgOffset] 章内消息偏移（存在则滚动定位并高亮）
   */
  async function openChapterAtMessage(chapterIndex, msgOffset) {
    state.currentChapter = chapterIndex;
    setPage("reader");
    if (msgOffset != null) state.pendingHighlightOffset = msgOffset;

    const page = document.createElement("div");
    page.className = "novel-reader-page";
    const scroll = document.createElement("div");
    scroll.className = "novel-reader-scroll";
    readerScrollEl = scroll;
    page.appendChild(scroll);
    bodyEl.appendChild(page);

    // 滚动保存进度（防抖；闭包捕获本章号，避免切章后旧滚动保存错章节）
    scroll.addEventListener("scroll", () => {
      if (!state.currentChar || !state.currentChat) return;
      clearTimeout(saveTimer);
      const chapter = chapterIndex;
      const charAvatar = state.currentChar.avatar;
      const chatFileName = state.currentChat.file_name;
      saveTimer = setTimeout(() => {
        progress.save(charAvatar, chatFileName, {
          chapter,
          scrollTop: scroll.scrollTop,
          updatedAt: Date.now(),
        });
      }, 400);
    });

    // 点击正文（非交互元素）切换顶/底栏显隐
    scroll.addEventListener("click", (e) => {
      if (
        e.target.closest(".novel-reader-inner") &&
        !e.target.closest("a,img,button,input,.novel-msg-name")
      ) {
        bodyEl.classList.toggle("novel-chrome-hidden");
      }
    });

    await reader.renderChapter(scroll, chapterIndex, {
      highlightOffset: msgOffset ?? null,
      onRendered: () => {
        applyReaderStyles();
        const saved = progress.load(
          state.currentChar.avatar,
          state.currentChat.file_name,
        );
        if (
          state.pendingHighlightOffset == null &&
          saved &&
          saved.chapter === chapterIndex &&
          saved.scrollTop &&
          scroll.scrollTop === 0
        ) {
          requestAnimationFrame(() => {
            scroll.scrollTop = saved.scrollTop;
          });
        }
        state.pendingHighlightOffset = null;
      },
    });

    updateBottomButtons();
  }

  async function openChapter(chapterIndex) {
    state.currentChapter = chapterIndex;
    setPage("reader");

    const page = document.createElement("div");
    page.className = "novel-reader-page";

    const scroll = document.createElement("div");
    scroll.className = "novel-reader-scroll";
    readerScrollEl = scroll;
    page.appendChild(scroll);
    bodyEl.appendChild(page);

    // 滚动保存进度（防抖；闭包捕获本章号，避免切章后旧滚动保存错章节）
    scroll.addEventListener("scroll", () => {
      if (!state.currentChar || !state.currentChat) return;
      clearTimeout(saveTimer);
      const chapter = chapterIndex;
      const charAvatar = state.currentChar.avatar;
      const chatFileName = state.currentChat.file_name;
      saveTimer = setTimeout(() => {
        progress.save(charAvatar, chatFileName, {
          chapter,
          scrollTop: scroll.scrollTop,
          updatedAt: Date.now(),
        });
      }, 400);
    });

    // 点击正文（非交互元素）切换顶/底栏显隐
    scroll.addEventListener("click", (e) => {
      if (
        e.target.closest(".novel-reader-inner") &&
        !e.target.closest("a,img,button,input,.novel-msg-name")
      ) {
        bodyEl.classList.toggle("novel-chrome-hidden");
      }
    });

    await reader.renderChapter(scroll, chapterIndex, {
      onRendered: () => {
        // 应用用户阅读器界面样式（字号/文字色/背景色）
        applyReaderStyles();
        // 恢复进度：若从目录点击则滚动到顶部（已由 renderChapter 完成）
        const saved = progress.load(
          state.currentChar.avatar,
          state.currentChat.file_name,
        );
        if (
          saved &&
          saved.chapter === chapterIndex &&
          saved.scrollTop &&
          scroll.scrollTop === 0
        ) {
          requestAnimationFrame(() => {
            scroll.scrollTop = saved.scrollTop;
          });
        }
      },
    });

    updateBottomButtons();
  }

  /** 更新底部栏按钮可用态 */
  function updateBottomButtons() {
    if (!bottombarEl) return;
    const info = reader.getChatInfo();
    const total = info?.totalChapters || 0;
    const cur = state.currentChapter;
    const prev = bottombarEl.querySelector('[data-action="prev"]');
    const next = bottombarEl.querySelector('[data-action="next"]');
    if (prev) prev.disabled = cur <= 1;
    if (next) next.disabled = cur >= total;
  }

  /** 上一章 / 下一章 */
  async function goChapter(delta) {
    const nextChapter = state.currentChapter + delta;
    const info = reader.getChatInfo();
    if (!info) return;
    if (nextChapter < 1 || nextChapter > info.totalChapters) return;
    await openChapter(nextChapter);
  }

  // ============ 顶部栏事件 ============

  function bindTopbarEvents() {
    // 返回按钮
    topbarEl
      .querySelector('[data-action="back"]')
      .addEventListener("click", goBack);
    // 全局设置按钮（每页 N 章）
    topbarEl
      .querySelector('[data-action="settings"]')
      .addEventListener("click", () => {
        openGlobalSettings();
      });
    // 关闭按钮（×）：关闭阅读器，下次打开恢复原页面
    topbarEl
      .querySelector('[data-action="close"]')
      .addEventListener("click", closeReaderDialog);
    // 搜索框：书架/聊天列表 = 实时筛选；目录/正文 = 小说内检索
    searchInputEl.addEventListener("input", () => {
      const q = searchInputEl.value.trim().toLowerCase();
      if (state.page === "bookshelf") {
        renderBookshelfGrid(q);
      } else if (state.page === "chats") {
        renderChatListGrid(q);
      } else if (state.page === "toc" || state.page === "reader") {
        runInChatSearch(q);
      }
    });
    // Esc 清空搜索并恢复
    searchInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        searchInputEl.value = "";
        if (state.page === "bookshelf") renderBookshelfGrid("");
        else if (state.page === "chats") renderChatListGrid("");
        else if (state.page === "toc" || state.page === "reader") {
          closeSearchPanel();
        }
      }
    });
  }

  /** 小说内检索：目录页/正文页输入关键词 → 弹出结果面板（章节 + 楼层 + 片段） */
  function runInChatSearch(q) {
    if (!q) {
      closeSearchPanel();
      return;
    }
    const results = reader.searchMessages(q);
    const panel = searchPanelEl || createSearchPanel();
    const listEl = panel.querySelector(".novel-search-list");
    listEl.innerHTML = "";

    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "novel-search-empty";
      empty.textContent = deps.cfmT("无匹配内容");
      listEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    results.forEach((r) => {
      const item = document.createElement("div");
      item.className = "novel-search-item";
      item.innerHTML = `
        <div class="novel-search-item-head">
          <span class="novel-search-item-ch">${escapeHtml(deps.cfmT("第") + String(r.chapterIndex) + deps.cfmT("章"))}</span>
          <span class="novel-search-item-floor">${escapeHtml("#" + String(r.floor))}</span>
          <span class="novel-search-item-name">${escapeHtml(String(r.name))}</span>
        </div>
        <div class="novel-search-item-snippet">${escapeHtml(String(r.snippet))}</div>`;
      item.addEventListener("click", () => {
        closeSearchPanel();
        openChapterAtMessage(r.chapterIndex, r.msgOffset);
      });
      frag.appendChild(item);
    });
    listEl.appendChild(frag);
  }

  /** 创建检索结果面板（浮在 body 上方） */
  function createSearchPanel() {
    const panel = document.createElement("div");
    panel.className = "novel-search-panel";
    panel.innerHTML = `<div class="novel-search-list"></div>`;
    bodyEl.appendChild(panel);
    searchPanelEl = panel;
    return panel;
  }

  /** 关闭检索结果面板 */
  function closeSearchPanel() {
    searchPanelEl?.remove();
    searchPanelEl = null;
  }

  /** 全局设置弹窗：每页 N 章（紧凑弹窗） */
  function openGlobalSettings() {
    const g = getGlobalSettings();
    const dlg = createOverlayDialog({
      title: deps.cfmT("全局设置"),
      compact: true,
    });
    const content = dlg.content;

    // ---- 检测美化主题图标（供下拉选择 / 状态提示） ----
    let themeIcons = { icons: {}, uniqueUrls: [] };
    try {
      themeIcons = detectThemeIconsCore({
        document,
        window,
        isImageIconBackground: isImageIconBackgroundCore,
      });
    } catch (err) {
      console.warn("[NovelReader] 检测美化主题图标失败:", err);
    }
    const hasTheme = themeIcons.uniqueUrls.length > 0;
    const savedIconUrl = g.customTopbarIcon || "";

    // 下拉项 HTML（用纯 URL 预览背景图）
    const dropdownItemsHtml = themeIcons.uniqueUrls
      .map((cssUrl, idx) => {
        const pureUrl = extractUrlFromCssCore(cssUrl);
        const selected =
          savedIconUrl && cssUrl.includes(savedIconUrl)
            ? " novel-icon-selected"
            : "";
        return `<div class="novel-icon-dropdown-item${selected}" data-url="${escapeHtml(
          pureUrl,
        )}" title="${escapeHtml(pureUrl)}">
          <span class="novel-icon-preview" style="background-image: url('${escapeHtml(
            pureUrl,
          )}')"></span>
          <span class="novel-icon-name">${escapeHtml(
            deps.cfmT("主题图标") + " " + (idx + 1),
          )}</span>
        </div>`;
      })
      .join("");

    content.innerHTML = `
      <div class="novel-settings-row">
        <div class="novel-settings-label">${escapeHtml(deps.cfmT("目录每页章数"))}</div>
        <input type="range" min="10" max="500" step="10" value="${Number(g.chaptersPerPage) || 100}" />
        <div class="novel-settings-value"></div>
      </div>
      <div class="novel-settings-row">
        <div class="novel-settings-hint">${escapeHtml(deps.cfmT("用于目录页的分页显示，修改后立即生效。"))}</div>
      </div>

      <div class="novel-settings-row novel-icon-config-section">
        <div class="novel-settings-label">${escapeHtml(deps.cfmT("自定义顶栏图标"))}</div>
        <div class="novel-icon-input-row">
          <input type="text" class="novel-icon-url-input"
                 placeholder="${
                   hasTheme
                     ? escapeHtml(deps.cfmT("已自动检测美化主题图标"))
                     : escapeHtml(deps.cfmT("输入图标URL（留空使用默认图标）"))
                 }"
                 value="${escapeHtml(savedIconUrl)}" />
          ${
            hasTheme
              ? `<button class="novel-icon-dropdown-btn" title="${escapeHtml(
                  deps.cfmT("从美化主题中选择图标"),
                )}"><i class="fa-solid fa-caret-down"></i></button>
                 <div class="novel-icon-dropdown-menu">${dropdownItemsHtml}</div>`
              : ""
          }
          <button class="novel-icon-clear-btn" title="${escapeHtml(
            deps.cfmT("清除自定义图标"),
          )}"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="novel-icon-status">
          <span class="novel-icon-status-dot ${
            savedIconUrl ? "novel-status-active" : "novel-status-inactive"
          }"></span>
          <span class="novel-icon-status-text">${
            savedIconUrl
              ? escapeHtml(deps.cfmT("使用自定义图标"))
              : hasTheme
                ? escapeHtml(deps.cfmT("自动使用美化主题图标"))
                : escapeHtml(deps.cfmT("使用默认图标"))
          }</span>
        </div>
        <div class="novel-settings-hint">${
          hasTheme
            ? escapeHtml(
                deps.cfmT(
                  `检测到 ${themeIcons.uniqueUrls.length} 个美化主题图标，可从下拉菜单选择或手动输入URL`,
                ),
              )
            : escapeHtml(
                deps.cfmT(
                  "未检测到美化主题图标替换。启用美化主题后会自动检测并适配",
                ),
              )
        }</div>
      </div>`;

    // ---- 目录每页章数 ----
    const range = content.querySelector("input[type='range']");
    const valueEl = content.querySelector(".novel-settings-value");
    valueEl.textContent = `${range.value} ${deps.cfmT("章/页")}`;
    range.addEventListener("input", () => {
      valueEl.textContent = `${range.value} ${deps.cfmT("章/页")}`;
      g.chaptersPerPage = Number(range.value);
      deps.saveSettings();
      // 若当前在目录页，实时刷新分页（保持当前页号不越界）
      if (state.page === "toc") {
        const info = reader.getChatInfo();
        if (info) {
          const totalPages = Math.max(
            1,
            Math.ceil(info.chapters.length / g.chaptersPerPage),
          );
          if (state.tocPage >= totalPages) state.tocPage = totalPages - 1;
        }
        const container = bodyEl.querySelector(".novel-page");
        if (container) renderTocPage(container);
      }
    });

    // ---- 自定义顶栏图标：下拉选择 / 手动输入 / 清除 ----
    const iconSection = content.querySelector(".novel-icon-config-section");
    const urlInput = content.querySelector(".novel-icon-url-input");
    const statusText = content.querySelector(".novel-icon-status-text");
    const statusDot = content.querySelector(".novel-icon-status-dot");
    const dropdownMenu = content.querySelector(".novel-icon-dropdown-menu");
    const dropdownBtn = content.querySelector(".novel-icon-dropdown-btn");

    /** 刷新状态提示 */
    function updateIconStatus() {
      const cur = g.customTopbarIcon || "";
      const active = !!cur;
      statusDot.classList.toggle("novel-status-active", active);
      statusDot.classList.toggle("novel-status-inactive", !active);
      statusText.textContent = cur
        ? deps.cfmT("使用自定义图标")
        : hasTheme
          ? deps.cfmT("自动使用美化主题图标")
          : deps.cfmT("使用默认图标");
    }

    /** 应用当前配置到顶栏图标 */
    function applyIconConfig() {
      applyTopbarIconFromConfigCore({
        getSavedIcon: () => g.customTopbarIcon,
        detectNeighborIcon: () =>
          detectNeighborIconCore({
            document,
            window,
            isImageIconBackground: isImageIconBackgroundCore,
          }),
        applyCustomIcon: (cssUrl, targetCls, extraStyles) =>
          applyCustomIconCore(cssUrl, targetCls, extraStyles, { $ }),
        clearCustomIcon: () => clearCustomIconCore({ $ }),
        toCssUrl: toCssUrlCore,
      });
    }

    // 下拉按钮：开合菜单
    dropdownBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdownMenu.classList.toggle("novel-dropdown-open");
    });
    // 点击其它区域关闭下拉
    document.addEventListener("click", (e) => {
      if (dropdownMenu && !e.target.closest(".novel-icon-input-row")) {
        dropdownMenu.classList.remove("novel-dropdown-open");
      }
    });
    // 下拉选择主题图标 → 保存 + 立即应用
    dropdownMenu
      ?.querySelectorAll(".novel-icon-dropdown-item")
      .forEach((item) => {
        item.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const url = item.dataset.url;
          urlInput.value = url;
          g.customTopbarIcon = url;
          deps.saveSettings();
          applyIconConfig();
          updateIconStatus();
          dropdownMenu.classList.remove("novel-dropdown-open");
          dropdownMenu
            .querySelectorAll(".novel-icon-dropdown-item")
            .forEach((i) => i.classList.remove("novel-icon-selected"));
          item.classList.add("novel-icon-selected");
        });
      });
    // 手动输入 URL（回车/失焦触发 change）→ 保存 + 应用；清空 → 回自动检测
    urlInput?.addEventListener("change", () => {
      const url = urlInput.value.trim();
      g.customTopbarIcon = url;
      deps.saveSettings();
      if (url) {
        applyIconConfig();
      } else {
        // 清空 → 回到自动检测模式（手动编排内部会走检测分支）
        applyIconConfig();
      }
      updateIconStatus();
    });
    // 清除按钮：清空输入 + 设置 + 回自动检测
    content
      .querySelector(".novel-icon-clear-btn")
      ?.addEventListener("click", () => {
        urlInput.value = "";
        g.customTopbarIcon = "";
        deps.saveSettings();
        applyIconConfig();
        updateIconStatus();
        dropdownMenu
          ?.querySelectorAll(".novel-icon-dropdown-item")
          .forEach((i) => i.classList.remove("novel-icon-selected"));
      });
  }

  // ============ 底部栏事件（小说设置） ============

  function bindBottombarEvents() {
    bottombarEl
      .querySelector('[data-action="toc"]')
      .addEventListener("click", showToc);
    bottombarEl
      .querySelector('[data-action="prev"]')
      .addEventListener("click", () => goChapter(-1));
    bottombarEl
      .querySelector('[data-action="next"]')
      .addEventListener("click", () => goChapter(1));
    bottombarEl
      .querySelector('[data-action="reader-settings"]')
      .addEventListener("click", () => toggleReaderSettings());
  }

  /** 返回目录页 */
  function showToc() {
    if (!state.currentChat) return;
    setPage("toc");
    const page = document.createElement("div");
    page.className = "novel-page";
    bodyEl.appendChild(page);
    renderTocPage(page);
  }

  // ============ 界面设置子面板（正文页底部栏「界面」按钮） ============

  /** 界面设置：字号 / 文字颜色 / 背景色（实时应用 + 持久化） */
  function toggleReaderSettings() {
    if (settingsPanelEl) {
      closeSettingsPanel();
      return;
    }
    const g = getGlobalSettings();
    const rs = g.readerSettings;

    const panel = document.createElement("div");
    panel.className = "novel-settings-panel";
    settingsPanelEl = panel;
    // 面板弹出在底部栏上方（.novel-settings-panel bottom:100% 相对 bottombar 定位）
    bottombarEl.appendChild(panel);

    // 字号
    const fontRow = document.createElement("div");
    fontRow.className = "novel-settings-row";
    const fontLabel = document.createElement("div");
    fontLabel.className = "novel-settings-label";
    fontLabel.textContent = deps.cfmT("字号");
    const fontRange = document.createElement("input");
    fontRange.type = "range";
    fontRange.min = "14";
    fontRange.max = "26";
    fontRange.step = "1";
    fontRange.value = String(rs.fontSize || 18);
    const fontValue = document.createElement("div");
    fontValue.className = "novel-settings-value";
    fontValue.textContent = `${fontRange.value}px`;
    fontRange.addEventListener("input", () => {
      rs.fontSize = Number(fontRange.value);
      fontValue.textContent = `${fontRange.value}px`;
      applyReaderStyles();
      deps.saveSettings();
    });
    fontRow.appendChild(fontLabel);
    fontRow.appendChild(fontRange);
    fontRow.appendChild(fontValue);
    panel.appendChild(fontRow);

    // 文字颜色色板
    const textRow = document.createElement("div");
    textRow.className = "novel-settings-row";
    const textLabel = document.createElement("div");
    textLabel.className = "novel-settings-label";
    textLabel.textContent = deps.cfmT("文字颜色");
    const textSwatches = document.createElement("div");
    textSwatches.className = "novel-swatches";
    const textColors = ["", "#ddd", "#333", "#1a1a1a", "#d4a017", "#5b8ff5"];
    textColors.forEach((color) => {
      const sw = document.createElement("div");
      sw.className = "novel-swatch" + (rs.textColor === color ? " active" : "");
      sw.style.background =
        color === "" ? "linear-gradient(135deg,#eee 50%,#222 50%)" : color;
      sw.title = color || deps.cfmT("跟随主题");
      sw.addEventListener("click", () => {
        rs.textColor = color;
        applyReaderStyles();
        deps.saveSettings();
        textSwatches
          .querySelectorAll(".novel-swatch")
          .forEach((s) => s.classList.remove("active"));
        sw.classList.add("active");
      });
      textSwatches.appendChild(sw);
    });
    textRow.appendChild(textLabel);
    textRow.appendChild(textSwatches);
    panel.appendChild(textRow);

    // 背景色板
    const bgRow = document.createElement("div");
    bgRow.className = "novel-settings-row";
    const bgLabel = document.createElement("div");
    bgLabel.className = "novel-settings-label";
    bgLabel.textContent = deps.cfmT("背景");
    const bgSwatches = document.createElement("div");
    bgSwatches.className = "novel-swatches";
    const bgColors = [
      "",
      "#14161a",
      "#f5f0e6",
      "#e8e8e8",
      "#2b2b2b",
      "#1e1e2e",
    ];
    bgColors.forEach((color) => {
      const sw = document.createElement("div");
      sw.className = "novel-swatch" + (rs.bgColor === color ? " active" : "");
      sw.style.background =
        color === "" ? "linear-gradient(135deg,#eee 50%,#222 50%)" : color;
      sw.title = color || deps.cfmT("跟随主题");
      sw.addEventListener("click", () => {
        rs.bgColor = color;
        applyReaderStyles();
        deps.saveSettings();
        bgSwatches
          .querySelectorAll(".novel-swatch")
          .forEach((s) => s.classList.remove("active"));
        sw.classList.add("active");
      });
      bgSwatches.appendChild(sw);
    });
    bgRow.appendChild(bgLabel);
    bgRow.appendChild(bgSwatches);
    panel.appendChild(bgRow);
  }

  /** 关闭设置子面板 */
  function closeSettingsPanel() {
    settingsPanelEl?.remove();
    settingsPanelEl = null;
  }

  /** 应用阅读器界面样式：自定义背景/文字色覆盖到整个弹窗；未自定义则跟随主题采样色 */
  function applyReaderStyles() {
    if (!dialogRef) return;
    const g = getGlobalSettings();
    const rs = g.readerSettings;
    const dialogEl = dialogRef.dialog;

    // 字号：只作用于正文容器
    if (readerScrollEl) {
      const inner = readerScrollEl.querySelector(".novel-reader-inner");
      if (inner) inner.style.fontSize = `${rs.fontSize}px`;
    }

    // 背景：自定义色覆盖到整个弹窗；否则重新采样恢复主题色
    if (rs.bgColor) {
      dialogEl.style.background = rs.bgColor;
    } else {
      dialogEl.style.background = "";
    }

    // 文字色：自定义时覆盖 --novel-fg 变量（供各子元素 color-mix/正文使用）；
    //         未自定义时重新采样恢复主题色（清除内联覆盖）
    if (rs.textColor) {
      dialogEl.style.setProperty("--novel-fg", rs.textColor);
    } else {
      dialogEl.style.removeProperty("--novel-fg");
      // 从主界面重新采样（打开时采样的色可能已被用户改设置覆盖过）
      try {
        applyThemeCore(dialogEl, sampleStThemeCore());
      } catch (err) {
        // 采样失败则保持现状
      }
    }
    dialogEl.style.color = "";
  }

  // ============ 事件订阅 ============

  function subscribeEvents() {
    const events = ctx.eventSource;
    const types = ctx.eventTypes;
    if (!events || !types) return;

    // 聊天切换：清缓存（弹窗内按需刷新）
    events.on(types.CHAT_CHANGED, () => {
      setTimeout(() => bookshelf.clearCache(), 300);
    });

    // 角色重命名：清缓存
    events.on(types.CHARACTER_RENAMED, () => {
      setTimeout(() => bookshelf.clearCache(), 300);
    });
  }

  // ============ 顶栏按钮注入（ST 主界面） ============

  function injectTopbarButton() {
    const btn = document.createElement("div");
    btn.id = "novel-topbar-button";
    btn.className = "drawer";
    btn.innerHTML = `
      <div class="drawer-toggle drawer-header">
        <div class="drawer-icon closedIcon fa-solid fa-book interactable" title="酒馆小说阅读器" tabindex="0" role="button"></div>
      </div>`;
    btn.addEventListener("click", (e) => {
      if (e.target.closest(".drawer-icon")) openReaderDialog();
    });
    $("#rightNavHolder").before(btn);

    // 顶栏图标美化适配：检测美化主题图标并自动保持一致（延迟等主题样式加载）
    // 优先级：手动指定 URL > 自动检测邻居 > 默认 FA 图标
    try {
      const adaptor = createTopbarIconAdaptorCore({
        $,
        isImageIconBackground: isImageIconBackgroundCore,
        detectNeighborIcon: () =>
          detectNeighborIconCore({
            document,
            window,
            isImageIconBackground: isImageIconBackgroundCore,
          }),
        applyCustomIcon: (cssUrl, targetCls, extraStyles) =>
          applyCustomIconCore(cssUrl, targetCls, extraStyles, { $ }),
        clearCustomIcon: () => clearCustomIconCore({ $ }),
        applyTopbarIconFromConfig: () =>
          applyTopbarIconFromConfigCore({
            getSavedIcon: () => getGlobalSettings().customTopbarIcon,
            detectNeighborIcon: () =>
              detectNeighborIconCore({
                document,
                window,
                isImageIconBackground: isImageIconBackgroundCore,
              }),
            applyCustomIcon: (cssUrl, targetCls, extraStyles) =>
              applyCustomIconCore(cssUrl, targetCls, extraStyles, { $ }),
            clearCustomIcon: () => clearCustomIconCore({ $ }),
            toCssUrl: toCssUrlCore,
          }),
      });
      adaptor.start();
    } catch (err) {
      console.warn("[NovelReader] 顶栏图标适配初始化失败:", err);
    }
  }

  // ============ 启动 ============

  injectTopbarButton();
  subscribeEvents();

  // ============ 暴露全局 API ============

  window.NovelReader = {
    extName: EXT_NAME,
    open: openReaderDialog,
    close: closeReaderDialog,
    bookshelf,
    reader,
    progress,
  };

  console.log("[NovelReader] 已就绪，点击顶栏书图标打开。");
});

// ============ 工具函数 ============

/** HTML 转义（纯文本安全输出） */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
