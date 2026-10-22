// features/reader/render.js
// 小说正文渲染层。
// 关键安全点：Markdown → HTML 必须走独立安全管线 renderMarkdown
// （ST 的 converter/showdown + encodeStyleTags + DOMPurify.sanitize + decodeStyleTags），
// 禁止直接 innerHTML 原始消息。
// ⚠️ 不能复用 ST 的 messageFormatting：它严重依赖全局 chat 数组（chat.map / getRegexedString /
// chat[messageId]?.extra?.type），只能渲染「当前打开的聊天」，渲染非当前聊天时返回空。

import {
  hydrateHtmlApps,
  postprocessHtmlApps,
  preprocessHtmlApps,
} from "./iframe.js";

/**
 * 将单段文本渲染为安全的正文 HTML（复用现有 renderMarkdown/escapeHtmlFallback 管线）。
 * 楼层版本切换（swipe）每次渲染都经过这里，保证正则过滤与安全渲染一致。
 *
 * HTML 应用支持：正文中的 ```html 代码块在 markdown 渲染前被提取为占位符
 * （穿透 showdown + DOMPurify），渲染后再替换为沙箱 iframe，实现复杂交互界面。
 * @param {object} deps 依赖注入（renderMarkdown / regexFilter / getHtmlAppEnabled / getHtmlAppRootEl）
 * @param {string} text 消息正文（mes 或 swipes 中的某个版本）
 * @param {object} [options]
 * @param {string} [options.avatar] 当前角色头像（决定启用哪些角色级正则）
 * @returns {string} 安全 HTML
 */
export function renderTextBody(deps, text, options = {}) {
  let t = text || "";
  // HTML 应用开关（设置页开关，默认开启；关闭时退化为普通代码块渲染）
  const htmlAppsEnabled =
    typeof deps.getHtmlAppEnabled === "function"
      ? deps.getHtmlAppEnabled()
      : true;

  // 提取 ```html 代码块 → 占位符（仅当开关开启且存在 html 代码块）。
  // ⚠️ 必须先于 regexFilter 执行：用户启用的正则（如「不发送杂项」的
  // /<(style|Branch|Rant|Module|Special_Episode)>[\s\S]*?<\/\1>/g）会直接
  // 命中 ```html 代码块内部的 <style> 等标签并整块删除，导致 HTML 应用
  // 样式丢失。先提取为纯字母数字占位符（@@NOVEL_HTML_APP_n@@，不会被
  // 任何正则命中），正则只作用于普通正文，渲染后再替换回沙箱 iframe。
  let apps = [];
  if (htmlAppsEnabled) {
    const pre = preprocessHtmlApps(t);
    t = pre.text;
    apps = pre.apps;
  }

  if (typeof deps.regexFilter === "function" && t) {
    try {
      t = deps.regexFilter(t, options.avatar || "");
    } catch (err) {
      console.warn("[NovelReader] regexFilter 失败，使用原文:", err);
    }
  }

  try {
    if (typeof deps.renderMarkdown === "function") {
      const html = deps.renderMarkdown(t);
      // 占位符 → 沙箱 iframe（在 sanitize 之后替换，iframe 标签本身不再被清洗）
      return postprocessHtmlApps(html, apps);
    }
  } catch (err) {
    console.warn("[NovelReader] renderMarkdown 失败，回退转义输出:", err);
  }
  return escapeHtmlFallback(t);
}

/**
 * 计算楼层版本信息（renderMessage 与 renderMessagesBatched 共用，
 * 保证正文渲染、切换条、引用表三处数据一致）。
 * @param {object} mes 消息对象
 * @returns {{swipes: string[], origin: number, hasMulti: boolean}}
 *   swipes  = 全部版本正文数组（无多版本时 = [mes.mes || ""]）
 *   origin  = 酒馆最初选中的版本下标（swipe_id 合法时取之，越界/缺失回退 0）
 *   hasMulti= 是否含多个版本（swipes.length > 1）
 */
function getSwipeInfo(mes) {
  const hasMulti = Array.isArray(mes.swipes) && mes.swipes.length > 1;
  const swipes = hasMulti ? mes.swipes : [mes.mes || ""];
  let origin = 0;
  if (
    hasMulti &&
    typeof mes.swipe_id === "number" &&
    mes.swipe_id >= 0 &&
    mes.swipe_id < swipes.length
  ) {
    origin = mes.swipe_id;
  }
  return { swipes, origin, hasMulti };
}

/**
 * 单条消息渲染为安全的 HTML。
 * @param {object} deps 依赖注入
 * @param {object} mes 消息对象（ST 原始消息：name / is_user / is_system / mes / send_date / swipes）
 * @param {object} [options]
 * @param {string} [options.userName] 用户显示名（说话人标签兜底）
 * @param {string} [options.avatar] 当前角色头像（决定启用哪些角色级正则）
 * @returns {string} 安全的 HTML 字符串（已 sanitize）
 */
export function renderMessage(deps, mes, options = {}) {
  // 楼层版本切换条开关（默认开启；关闭时退化为只渲染 mes.mes，与现状一致）
  const showSwipeBar =
    typeof deps.getShowSwipeBar === "function" ? deps.getShowSwipeBar() : true;

  const name = mes.name || options.userName || "?";
  const isUser = Boolean(mes.is_user);
  const isSystem = Boolean(mes.is_system);

  // 楼层版本信息：有多个版本且开关开启时显示切换条
  const { swipes, origin, hasMulti } = getSwipeInfo(mes);
  const renderSwipes = showSwipeBar && hasMulti;
  const currentSwipe = renderSwipes ? origin : 0;
  const text = renderSwipes ? (swipes[currentSwipe] ?? "") : mes.mes || "";

  const bodyHtml = renderTextBody(deps, text, options);

  // 说话人标签（原样显示，不转换）
  const label = name;
  // 时间戳：年/月/日 时:分（本地时区；无效值兜底显示原文）
  const time = mes.send_date
    ? escapeHtmlFallback(formatTime(mes.send_date))
    : "";

  const cls = [
    "novel-msg",
    isUser ? "novel-msg-user" : "",
    isSystem ? "novel-msg-system" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const mesId = escapeHtmlFallback(String(mes.mesId ?? ""));

  // 切换条：仅当含多个版本且开关开启时显示（‹ 1/N › ↺）
  // 计数「1/N」可点击：点击后原地变为数字输入框，可手动输入版本号跳转
  const swipeBarHtml = renderSwipes
    ? `
      <div class="novel-swipe-bar" data-swipe-bar>
        <button type="button" class="novel-swipe-btn" data-swipe-prev title="上一个版本">‹</button>
        <span class="novel-swipe-count" data-swipe-jump title="点击跳转到指定版本">${currentSwipe + 1}/${swipes.length}</span>
        <button type="button" class="novel-swipe-btn" data-swipe-next title="下一个版本">›</button>
        <button type="button" class="novel-swipe-btn novel-swipe-reset" data-swipe-reset title="回到当前选中的版本" ${
          currentSwipe === origin ? "disabled" : ""
        }>↺</button>
      </div>`
    : "";

  return `
    <div class="${cls}" data-id="${mesId}" data-mes-id="${mesId}" data-swipe-idx="${currentSwipe}" data-swipe-total="${swipes.length}" data-swipe-origin="${origin}">
      <div class="novel-msg-head">
        <span class="novel-msg-name">${escapeHtmlFallback(label)}</span>
        ${time ? `<span class="novel-msg-time">${time}</span>` : ""}
      </div>
      <div class="novel-msg-body">${bodyHtml}</div>
      ${swipeBarHtml}
    </div>`;
}

/**
 * 将消息数组分批渲染到容器（避免一次性插入上万条 DOM 卡死），
 * 并绑定楼层版本切换条的事件委托（同一容器只绑一次）。
 * @param {object} deps 依赖注入
 * @param {HTMLElement} container 目标容器（.novel-msg-list）
 * @param {Array<object>} messages 消息数组
 * @param {object} [options] 见 renderMessage
 * @param {number} [options.batchSize=200] 每批渲染条数
 * @returns {Promise<void>} 渲染完成
 */
export async function renderMessagesBatched(
  deps,
  container,
  messages,
  options = {},
) {
  const { batchSize = 200, onProgress } = options;
  const total = messages.length;

  // 楼层版本引用表：mesId → { swipes, origin, avatar }
  // （不依赖全局 chat 数组；key 与楼层 data-mes-id 一致，供切换时回找消息对象）
  const swipeRefs = new Map();

  // 用 DocumentFragment 累积，避免多次重排
  let fragment = document.createDocumentFragment();
  let pending = 0;

  for (let i = 0; i < total; i += 1) {
    const mes = messages[i];
    if (!mes) continue;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderMessage(deps, mes, options);
    // wrapper 只含一个子节点（novel-msg），取其首个元素挂载
    const node = wrapper.firstElementChild;
    if (node) {
      // 引用表 key 与楼层 data-mes-id 保持一致：优先 mesId，缺失用章内序号
      const key = mes.mesId != null ? String(mes.mesId) : `m${i}`;
      node.dataset.mesId = key;
      const { swipes, origin } = getSwipeInfo(mes);
      swipeRefs.set(key, {
        swipes,
        origin,
        avatar: options.avatar || "",
        mes, // 原始消息对象：切换版本时写回 swipe_id，供翻页模式重排后保留所选版本
      });
      fragment.appendChild(node);
      pending += 1;
    }

    // 每 batchSize 条挂载一次，让出主线程
    if (pending >= batchSize) {
      container.appendChild(fragment);
      fragment = document.createDocumentFragment();
      pending = 0;
      onProgress?.(i + 1, total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (pending > 0) {
    container.appendChild(fragment);
  }

  bindSwipeBarEvents(deps, container, swipeRefs);

  // 水合 HTML 应用：确保全局 message 监听已绑定，并向已插入的 iframe 触发高度同步
  // （滚动模式每章块独立容器，各自调用一次；全局监听内部去重）
  try {
    hydrateHtmlApps(container, () => deps.getHtmlAppRootEl?.() || null);
  } catch (err) {
    console.warn("[NovelReader] HTML 应用水合失败:", err);
  }
}

// 模块级楼层版本引用表（key = .novel-msg 元素）：document 级事件委托用。
// 用 WeakMap 避免持有已移除的消息 DOM 导致内存泄漏。
const swipeRefsByEl = new WeakMap();
let swipeDocBound = false;

/**
 * 登记楼层版本切换条的引用并绑定 document 级事件委托。
 * 事件委托挂在 document 上（只绑一次），与消息 DOM 是否还在
 * .novel-msg-list 容器内无关：翻页模式把消息克隆/移动进显示页
 * （没有 .novel-msg-list 容器）后，事件仍能冒泡到 document 被处理。
 * @param {object} deps 依赖注入
 * @param {HTMLElement} container 正文容器（.novel-msg-list）
 * @param {Map<string, {swipes: string[], origin: number, avatar: string}>} swipeRefs 楼层版本引用表
 */
function bindSwipeBarEvents(deps, container, swipeRefs) {
  if (!container) return;
  // 登记本批消息：元素 → 引用（含原始消息对象与渲染 deps）
  container.querySelectorAll(".novel-msg").forEach((node) => {
    const key = node.dataset.mesId || "";
    const ref = swipeRefs.get(key);
    if (ref) swipeRefsByEl.set(node, { ref, deps, mes: ref.mes });
  });
  if (!swipeDocBound) {
    document.addEventListener("click", onSwipeDocClick);
    swipeDocBound = true;
  }
}

/** document 级点击委托：处理 .novel-swipe-bar 内的 ‹ › / 计数 / ↺ 点击 */
function onSwipeDocClick(e) {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (!target.closest(".novel-swipe-bar")) return; // 只处理切换条内点击
  const msg = target.closest(".novel-msg");
  if (!msg) return;
  const entry = swipeRefsByEl.get(msg);
  if (!entry) return;
  const { ref } = entry;
  const swipes = ref.swipes;
  if (!Array.isArray(swipes) || swipes.length === 0) return;
  const total = swipes.length;

  // 切换版本：‹ / ›（循环切换）
  const btn = target.closest("[data-swipe-prev], [data-swipe-next]");
  if (btn) {
    if (total < 2) return; // 无切换空间
    const idx = Number(msg.dataset.swipeIdx || 0);
    const dir = btn.hasAttribute("data-swipe-prev") ? -1 : 1;
    switchMessageSwipe(msg, (idx + dir + total) % total, entry);
    return;
  }

  // 手动输入跳转：点击计数「1/N」
  const jump = target.closest("[data-swipe-jump]");
  if (jump && !jump.dataset.swipeInput) {
    startSwipeJump(jump, msg, entry);
    return;
  }

  // 回到当前版本：↺（恢复为酒馆最初选中的 swipe_id 版本）
  const reset = target.closest("[data-swipe-reset]");
  if (reset) {
    switchMessageSwipe(msg, ref.origin, entry);
  }
}

/**
 * 切换/复位楼层显示的 swipe 版本（就地替换正文 + 更新计数与 ↺ 按钮态）。
 * 同时写回原始消息对象 mes.swipe_id，使翻页模式重排（reflow）后仍渲染所选版本。
 * @param {HTMLElement} msgEl 消息元素（.novel-msg）
 * @param {number} idx 目标版本下标（0 起，越界取模）
 * @param {{ref, deps, mes}} entry 引用表条目
 */
function switchMessageSwipe(msgEl, idx, entry) {
  const { ref, deps, mes } = entry;
  const swipes = ref.swipes;
  if (!Array.isArray(swipes) || swipes.length === 0) return;
  const total = swipes.length;
  const safeIdx = ((idx % total) + total) % total; // 越界取模兜底
  const body = msgEl.querySelector(".novel-msg-body");
  if (!body) return;
  // 新版本正文同样走正则过滤 + 安全渲染管线
  body.innerHTML = renderTextBody(deps, swipes[safeIdx] ?? "", {
    avatar: ref.avatar,
  });
  // 新版本正文可能含 HTML 应用：水合（绑定消息监听 + 触发高度同步）
  try {
    hydrateHtmlApps(body, () => deps.getHtmlAppRootEl?.() || null);
  } catch (err) {
    console.warn("[NovelReader] HTML 应用水合失败:", err);
  }
  msgEl.dataset.swipeIdx = String(safeIdx);
  // 写回原始消息：reflow / 重新渲染当前章时保留所选版本（仅影响内存数据，不落盘）
  if (mes && typeof mes === "object") {
    if (Array.isArray(mes.swipes)) mes.swipe_id = safeIdx;
    else mes.mes = swipes[safeIdx] ?? "";
  }
  const countEl = msgEl.querySelector(".novel-swipe-count");
  if (countEl) countEl.textContent = `${safeIdx + 1}/${total}`;
  // ↺ 按钮：当前显示酒馆最初选中版本时置灰，否则可用
  const resetBtn = msgEl.querySelector("[data-swipe-reset]");
  if (resetBtn) resetBtn.disabled = safeIdx === ref.origin;
  // 翻页模式：切换版本会改变消息高度，需重新分页（index.js 注入 onSwipeChanged 回调）
  try {
    deps.onSwipeChanged?.(msgEl);
  } catch (err) {
    console.warn("[NovelReader] swipe 切换后重排失败:", err);
  }
}

/**
 * 把计数「1/N」就地切换为数字输入框（保持 .novel-swipe-count 类名，便于样式复用）。
 * 输入范围 1~N，Enter/失焦确认跳转，Escape 取消。
 */
function startSwipeJump(countEl, msgEl, entry) {
  if (countEl.dataset.swipeInput === "1") return; // 已处于输入态
  const total = Number(msgEl.dataset.swipeTotal || 0);
  if (total < 2) return;
  const current = Number(msgEl.dataset.swipeIdx || 0) + 1;
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

  /** 结束输入态并恢复计数显示（失焦/确认/取消共用） */
  const finish = () => {
    countEl.dataset.swipeInput = "";
    countEl.textContent = `${Number(msgEl.dataset.swipeIdx || 0) + 1}/${total}`;
  };
  /** 读取输入并跳转（越界自动夹取到 1~N） */
  const commit = () => {
    const raw = Number(input.value);
    const target =
      Number.isFinite(raw) && raw >= 1 ? Math.min(Math.round(raw), total) : 0;
    if (target) switchMessageSwipe(msgEl, target - 1, entry);
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
    // 失焦即确认（与 Enter 行为一致）；Escape 已清空输入，此处置为取消
    commit();
    finish();
  });
}

/**
 * 纯文本兜底转义（messageFormatting 不可用时的最后防线）。
 * @param {string} str
 * @returns {string}
 */
function escapeHtmlFallback(str) {
  // 用字符串拼接构造实体，避免工具/编辑器对字面量做实体解码
  const AMP = "&" + "amp;";
  const QUOT = "&" + "quot;";
  return String(str ?? "")
    .replace(/&/g, AMP)
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, QUOT);
}

/**
 * 消息时间戳：年/月/日 时:分（本地时区）。
 * ST 消息的 send_date 形如 "2026-09-07T11:37:16.293Z"（ISO 8601 UTC）。
 * 解析失败 → 返回原文兜底。
 * @param {string|number|Date} value
 * @returns {string}
 */
function formatTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value ?? "");
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
}
