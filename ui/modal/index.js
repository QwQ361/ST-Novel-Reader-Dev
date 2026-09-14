// ui/modal/index.js
// 通用弹窗构建器。
// 移动端铁律（详见 MOBILE-POPUP-FIX.md）：
//   1) overlay 一律不加 overflow（WebView fixed+overflow flex bug）
//   2) 移动端媒体查询放 style.css 文件末尾
//   3) 弹窗容器用 margin:auto
//   4) 高度用 100vh
// 实现用纯 DOM（不依赖 ST 的 getContext().createPopperModal），CSS 类统一 novel- 前缀。

/**
 * 创建通用遮罩弹窗。
 * @param {object} options
 * @param {string} [options.title] 标题
 * @param {boolean} [options.backdropClose=true] 点击遮罩是否关闭
 * @param {boolean} [options.showClose=true] 是否显示右上角关闭按钮
 * @param {boolean} [options.compact=false] 紧凑弹窗（小尺寸、居中、可滚动内容），用于设置类小弹窗
 * @param {boolean} [options.floating=false] 悬浮窗模式：半透明遮罩 + 固定尺寸可拖动/可缩放窗口
 *        （标题栏拖动移动，右下角手柄缩放；移动端由媒体查询强制全屏，见 style.css 末尾）
 * @returns {{ overlay: HTMLElement, dialog: HTMLElement, content: HTMLElement, close: Function, onClose: Function }}
 */
export function createOverlayDialog(options = {}) {
  const {
    title = "",
    backdropClose = true,
    showClose = true,
    compact = false,
    floating = false,
  } = options;

  const overlay = document.createElement("div");
  overlay.className = "novel-overlay" + (floating ? " novel-overlay-floating" : "");
  overlay.dataset.novelOverlay = "";

  const dialog = document.createElement("div");
  dialog.className =
    "novel-dialog" +
    (compact ? " novel-dialog-compact" : "") +
    (floating ? " novel-dialog-floating" : "");

  // 仅在有标题或需要关闭按钮时才渲染 header（避免全屏弹窗出现空标题条）
  const content = document.createElement("div");
  content.className = "novel-dialog-content";

  let header = null;
  if (title || showClose) {
    header = document.createElement("div");
    header.className = "novel-dialog-header";
    if (title) {
      const titleEl = document.createElement("span");
      titleEl.className = "novel-dialog-title";
      titleEl.textContent = title;
      header.appendChild(titleEl);
    }
    if (showClose) {
      const closeBtn = document.createElement("div");
      closeBtn.className = "novel-dialog-close interactable";
      closeBtn.title = "关闭";
      closeBtn.textContent = "\u00d7";
      closeBtn.addEventListener("click", () => close());
      header.appendChild(closeBtn);
    }
    dialog.appendChild(header);
  }

  dialog.appendChild(content);
  overlay.appendChild(dialog);

  /** 关闭回调（由调用方覆盖） */
  let onClose = () => {};

  function close() {
    overlay.remove();
    onClose();
  }

  if (backdropClose) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
  }

  // ---- 悬浮窗模式：居中定位 + 标题栏拖动 + 右下角缩放 ----
  if (floating) {
    const vw = () => window.innerWidth;
    const vh = () => window.innerHeight;
    const initW = Math.min(880, vw() * 0.92);
    const initH = Math.min(620, vh() * 0.88);
    dialog.style.width = `${initW}px`;
    dialog.style.height = `${initH}px`;
    dialog.style.left = `${(vw() - initW) / 2}px`;
    dialog.style.top = `${(vh() - initH) / 2}px`;

    // 拖动：仅标题栏（点击关闭按钮不触发）
    if (header) {
      header.classList.add("novel-dialog-float-drag");
      let drag = null;
      header.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".novel-dialog-close")) return;
        drag = {
          startX: e.clientX,
          startY: e.clientY,
          origLeft: dialog.offsetLeft,
          origTop: dialog.offsetTop,
        };
        try {
          header.setPointerCapture(e.pointerId);
        } catch {}
        e.preventDefault();
      });
      header.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const left = Math.min(
          Math.max(drag.origLeft + (e.clientX - drag.startX), 0),
          vw() - dialog.offsetWidth,
        );
        const top = Math.min(
          Math.max(drag.origTop + (e.clientY - drag.startY), 0),
          vh() - dialog.offsetHeight,
        );
        dialog.style.left = `${left}px`;
        dialog.style.top = `${top}px`;
      });
      const endDrag = (e) => {
        drag = null;
        try {
          header.releasePointerCapture(e.pointerId);
        } catch {}
      };
      header.addEventListener("pointerup", endDrag);
      header.addEventListener("pointercancel", endDrag);
    }

    // 缩放：右下角手柄
    const handle = document.createElement("div");
    handle.className = "novel-dialog-resize-handle";
    handle.title = "拖动调整大小";
    dialog.appendChild(handle);

    let resize = null;
    handle.addEventListener("pointerdown", (e) => {
      resize = {
        startX: e.clientX,
        startY: e.clientY,
        origW: dialog.offsetWidth,
        origH: dialog.offsetHeight,
      };
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {}
      e.preventDefault();
      e.stopPropagation();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!resize) return;
      const minW = 360;
      const minH = 240;
      const w = Math.min(
        Math.max(resize.origW + (e.clientX - resize.startX), minW),
        vw() - dialog.offsetLeft,
      );
      const h = Math.min(
        Math.max(resize.origH + (e.clientY - resize.startY), minH),
        vh() - dialog.offsetTop,
      );
      dialog.style.width = `${w}px`;
      dialog.style.height = `${h}px`;
    });
    const endResize = (e) => {
      resize = null;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {}
    };
    handle.addEventListener("pointerup", endResize);
    handle.addEventListener("pointercancel", endResize);
  }

  document.body.appendChild(overlay);
  return {
    overlay,
    dialog,
    content,
    close,
    set onClose(fn) {
      onClose = fn;
    },
  };
}

/**
 * 创建选择对话框（带若干按钮）。
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.message]
 * @param {Array<{label: string, value: any, primary?: boolean}>} options.choices
 * @param {Function} [options.onSelect] (value) => void
 * @returns {{ dialog: HTMLElement, close: Function }}
 */
export function createChoiceDialog(options = {}) {
  const {
    title = "",
    message = "",
    choices = [],
    onSelect = () => {},
  } = options;
  const dlg = createOverlayDialog({ title, backdropClose: false });
  const content = dlg.content;

  if (message) {
    const p = document.createElement("div");
    p.className = "novel-dialog-message";
    p.textContent = message;
    content.appendChild(p);
  }

  const btnRow = document.createElement("div");
  btnRow.className = "novel-dialog-actions";
  choices.forEach((ch) => {
    const btn = document.createElement("div");
    btn.className = `novel-btn${ch.primary ? " novel-btn-primary" : ""}`;
    btn.textContent = ch.label;
    btn.addEventListener("click", () => {
      dlg.close();
      onSelect(ch.value);
    });
    btnRow.appendChild(btn);
  });
  content.appendChild(btnRow);

  return { dialog: dlg.dialog, close: dlg.close };
}
