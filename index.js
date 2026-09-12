// index.js —— 酒馆小说阅读器 薄入口
// 职责：
//   1) jQuery async 启动
//   2) 依赖组装（deps 依赖注入到各 Core）
//   3) 顶栏按钮注入
//   4) 事件订阅（CHAT_CHANGED / CHARACTER_RENAMED）
//   5) 暴露全局 API（window.NovelReader）
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
    // Markdown 安全渲染管线（converter → encodeStyleTags → DOMPurify → decodeStyleTags）
    // 可渲染任意聊天的消息，不依赖全局 chat（ST 的 messageFormatting 做不到）
    renderMarkdown: renderMarkdownCore,
    getSettings: () => window.extension_settings || {},
    saveSettings: () => window.saveSettingsDebounced?.(),
    // 界面文本：仅 language === 'zh-TW' 时转繁体
    cfmT: (t) => cfmTCore(t, { settings: window.extension_settings }),
    // 正文转换：默认关（后续设置面板接管），此处提供函数占位
    tc: (t) => convertText(t, false),
  };

  const bookshelf = createBookshelfCore({
    ...deps,
    getCharacters: () => ctx.characters,
    getChatsContainer: () => chatListEl,
    onOpenChat: (char, chat) => openChatInReader(char, chat),
  });

  const reader = createReaderCore({
    ...deps,
    getChatMessages: (avatar, fileName) =>
      bookshelf.getChatMessages(avatar, fileName),
    selectCharacterById: (idx) =>
      selectCharacterByIdFunc() ?? ctx.selectCharacterById?.(idx),
    openCharacterChat: (name) =>
      openCharacterChatFunc() ?? ctx.openCharacterChat?.(name),
  });

  const progress = createProgressCore({ ...deps });

  // ---- 3. UI 引用（弹窗内三栏）----
  let charListEl = null;
  let chatListEl = null;
  let readerBodyEl = null;
  let dialogRef = null;

  /**
   * 打开主界面弹窗（书架 | 聊天列表 | 小说正文 三栏）。
   */
  function openReaderDialog() {
    if (dialogRef) return;

    const dlg = createOverlayDialog({ title: deps.cfmT("酒馆小说阅读器") });
    dialogRef = dlg;
    dlg.onClose = () => {
      reader.abort();
      dialogRef = null;
    };

    const content = dlg.content;
    content.className = "novel-dialog-content novel-main";

    // 左栏：角色书架
    const charsCol = document.createElement("div");
    charsCol.className = "novel-col novel-col-chars";
    const charsTitle = document.createElement("div");
    charsTitle.className = "novel-col-title";
    charsTitle.textContent = deps.cfmT("角色");
    const charsList = document.createElement("div");
    charsList.className = "novel-list novel-scroll";
    charsCol.appendChild(charsTitle);
    charsCol.appendChild(charsList);
    charListEl = charsList;

    // 中栏：聊天列表
    const chatsCol = document.createElement("div");
    chatsCol.className = "novel-col novel-col-chats";
    const chatsTitle = document.createElement("div");
    chatsTitle.className = "novel-col-title";
    chatsTitle.textContent = deps.cfmT("聊天记录");
    const chatsList = document.createElement("div");
    chatsList.className = "novel-list novel-scroll";
    chatsCol.appendChild(chatsTitle);
    chatsCol.appendChild(chatsList);
    chatListEl = chatsList;

    // 右栏：小说正文
    const readerCol = document.createElement("div");
    readerCol.className = "novel-col novel-col-reader";
    const readerArea = document.createElement("div");
    readerArea.className = "novel-reader";
    readerArea.innerHTML = `<div class="novel-empty">${deps.cfmT("请选择角色与聊天开始阅读")}</div>`;
    readerCol.appendChild(readerArea);
    readerBodyEl = readerArea;

    content.appendChild(charsCol);
    content.appendChild(chatsCol);
    content.appendChild(readerCol);

    // 渲染书架（绑定事件 + 角色列表）
    bookshelf.render(charsList, chatsList);

    // 滚动保存进度（防抖）——scroll 不冒泡，需监听实际滚动容器（.novel-reader-body）
    // 该容器在 reader.openChat 渲染完成时通过 onRendered 回调暴露
    function bindScrollProgress(scrollEl) {
      if (!scrollEl) return;
      scrollEl.addEventListener("scroll", () => {
        if (!currentChat) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          progress.save(currentChat.avatar, currentChat.file_name, {
            scrollTop: scrollEl.scrollTop,
            updatedAt: Date.now(),
          });
        }, 400);
      });
    }
    // 挂到 reader 实例上，供 openChatInReader 在渲染后调用
    reader._bindScrollProgress = bindScrollProgress;
  }

  /** 关闭主界面弹窗 */
  function closeReaderDialog() {
    dialogRef?.close();
  }

  // ---- 当前打开聊天（供进度保存用）----
  let currentChat = null;
  let saveTimer = 0;

  /**
   * 打开指定聊天到正文区，并尝试恢复阅读进度。
   * @param {object} char 角色对象
   * @param {object} chat 聊天对象（file_name 带 .jsonl）
   */
  async function openChatInReader(char, chat) {
    if (!readerBodyEl) return;
    currentChat = { avatar: char.avatar, file_name: chat.file_name };

    let bodyEl = null;
    await reader.openChat(readerBodyEl, {
      avatar: char.avatar,
      fileName: chat.file_name,
      title: chat.file_name.replace(/\.jsonl$/i, ""),
      userName: ctx.userName,
      showSystem: true,
      onRendered: (body) => {
        bodyEl = body;
        // 每次渲染后重新绑定滚动进度监听（旧容器已随 innerHTML 清空重建）
        reader._bindScrollProgress?.(body);
      },
    });

    // 恢复阅读进度
    const saved = progress.load(char.avatar, chat.file_name);
    if (saved && saved.scrollTop && bodyEl) {
      requestAnimationFrame(() => {
        bodyEl.scrollTop = saved.scrollTop;
      });
    }
  }

  // ---- 4. 顶栏按钮注入（CFM 风格 drawer 按钮）----
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
  }

  // ---- 5. 事件订阅 ----
  function subscribeEvents() {
    const events = ctx.eventSource;
    const types = ctx.eventTypes;
    if (!events || !types) return;

    // 聊天切换：清缓存并刷新（延迟等待 ST 数据更新）
    events.on(types.CHAT_CHANGED, () => {
      setTimeout(() => {
        bookshelf.clearCache();
        if (charListEl) bookshelf.render(charListEl, chatListEl);
      }, 300);
    });

    // 角色重命名：清缓存
    events.on(types.CHARACTER_RENAMED, () => {
      setTimeout(() => bookshelf.clearCache(), 300);
    });
  }

  // ---- 6. 启动 ----
  injectTopbarButton();
  subscribeEvents();

  // ---- 7. 暴露全局 API ----
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
