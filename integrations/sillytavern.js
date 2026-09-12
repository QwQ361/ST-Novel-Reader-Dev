// integrations/sillytavern.js
// SillyTavern 集成层：集中管理与 ST 核心的交互。
// - getStContext()：获取 ST 上下文
// - loadStCoreModules()：动态导入 ST 核心脚本（幂等，各自 try/catch + null 兜底）
// - 全局函数访问器：getPastCharacterChatsFunc / openCharacterChatFunc / messageFormattingFunc

/**
 * 获取 SillyTavern 上下文对象。
 * @returns {object|null} SillyTavern.getContext() 的结果，不可用时返回 null
 */
export function getStContext() {
  try {
    return window.SillyTavern?.getContext?.() ?? null;
  } catch (err) {
    console.warn("[NovelReader] getStContext 失败:", err);
    return null;
  }
}

/**
 * 动态导入单个 ST 核心脚本。
 * 这些脚本都是传统脚本（无 ES export），import 的目的只是确保其已执行、
 * 全局函数已就绪。返回 true 表示成功，失败返回 null（不阻断其他模块）。
 * @param {string} relativePath 相对当前文件的导入路径
 * @returns {Promise<boolean|null>}
 */
async function importModule(relativePath) {
  try {
    await import(/* @vite-ignore */ relativePath);
    return true;
  } catch (err) {
    console.warn("[NovelReader] 动态导入失败:", relativePath, err);
    return null;
  }
}

// 模块加载状态缓存（幂等）
let _loaded = false;

/**
 * 加载 ST 核心模块（幂等，可多次调用）。
 * script.js 位于 public/ 根目录，需要 5 级 .. 跳出插件目录。
 * @returns {Promise<boolean>} 是否加载完成
 */
export async function loadStCoreModules() {
  if (_loaded) return true;
  const results = await Promise.all([
    importModule("../../../../../script.js"), // public/script.js（Markdown 渲染、API 请求头等）
    importModule("../../../../personas.js"), // public/scripts/personas.js
    importModule("../../../../utils.js"), // public/scripts/utils.js
    importModule("../../../../popup.js"), // public/scripts/popup.js
    importModule("../../../../chats.js"), // public/scripts/chats.js（openCharacterChat / getPastCharacterChats）
  ]);
  _loaded = results.some(Boolean);
  return _loaded;
}

/**
 * 取「某角色的全部聊天列表」全局函数（带缓存优先的 ST 实现）。
 * @returns {Function|null} getPastCharacterChats(charIdx) => Promise<Array>
 */
export function getPastCharacterChatsFunc() {
  return window.getPastCharacterChats ?? null;
}

/**
 * 取「打开指定聊天」全局函数。
 * @returns {Function|null} openCharacterChat(fileNameWithoutExt) => Promise
 */
export function openCharacterChatFunc() {
  return window.openCharacterChat ?? null;
}

/**
 * 取「Markdown 消息渲染」全局函数（官方管线：showdown + sanitize）。
 * @returns {Function|null} messageFormatting(mes, ch_name, isSystem, isUser, messageId, sanitizerOverrides)
 */
export function messageFormattingFunc() {
  return window.messageFormatting ?? null;
}

/**
 * 取 ST 的 API 请求头（含 CSRF）。
 * @returns {object} 请求头对象
 */
export function getRequestHeaders() {
  try {
    return window.getRequestHeaders?.() ?? {};
  } catch (err) {
    console.warn("[NovelReader] getRequestHeaders 失败:", err);
    return {};
  }
}
