/**
 * Lightweight feedback overlay installed by the content script.
 * Exposes window.__vb = { highlight, toast, candidates, clearCandidates }.
 * Self-contained: runs in the page, no closures over extension scope.
 *
 * Elements are resolved through `window.__vbById` (filled by collectElementsInPage) so targets
 * inside shadow roots and same-origin iframes are found; boxes are offset by iframe positions.
 */
export function installOverlay() {
  if (window.__vb) return;
  const Z = 2147483000;
  const FONT = `-apple-system, BlinkMacSystemFont, "SF Pro KR", "SF Pro Text", "Apple SD Gothic Neo", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif`;
  // Local redesign (apple.com-style): frosted dark pill toast, Apple blue (#0071e3) focus rings.
  const css = `
    .__vb-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(8px);display:flex;align-items:center;gap:9px;
      background:rgba(29,29,31,.82);color:#f5f5f7;font:400 14px/1.35 ${FONT};padding:10px 18px 10px 12px;border-radius:980px;
      -webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);
      box-shadow:0 8px 28px rgba(0,0,0,.22),0 0 0 .5px rgba(255,255,255,.12) inset;z-index:${Z};opacity:0;
      transition:opacity .25s cubic-bezier(.4,0,.6,1),transform .25s cubic-bezier(.28,.11,.32,1);
      pointer-events:none;max-width:70vw;letter-spacing:-.01em;word-break:keep-all}
    .__vb-toast.__vb-show{opacity:1;transform:translateX(-50%) translateY(0)}
    .__vb-toast .__vb-ic{width:18px;height:18px;border-radius:50%;background:#0071e3;display:inline-block;flex:none;position:relative}
    .__vb-toast .__vb-ic::after{content:"";position:absolute;left:6.5px;top:3.6px;width:3.6px;height:7.6px;border:solid #fff;border-width:0 1.8px 1.8px 0;transform:rotate(45deg)}
    .__vb-hl{position:absolute;border:2px solid #0071e3;border-radius:10px;box-shadow:0 0 0 4px rgba(0,113,227,.2),0 8px 24px rgba(0,113,227,.25);
      z-index:${Z};pointer-events:none;transition:opacity .3s;animation:__vb-in .22s cubic-bezier(.28,.11,.32,1)}
    @keyframes __vb-in{from{transform:scale(1.04);opacity:0}to{transform:scale(1);opacity:1}}
    .__vb-badge{position:absolute;min-width:24px;height:24px;padding:0 7px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
      background:#0071e3;color:#fff;font:600 13px/1 ${FONT};border-radius:980px;z-index:${Z};pointer-events:none;
      box-shadow:0 2px 8px rgba(0,0,0,.25),0 0 0 2px #fff}
    .__vb-cand{position:absolute;border:2px solid #0071e3;border-radius:10px;z-index:${Z};pointer-events:none;
      background:rgba(0,113,227,.08);box-shadow:0 0 0 3px rgba(255,255,255,.6)}
  `;
  const ensureStyle = () => {
    if (document.getElementById("__vb-style")) return;
    const s = document.createElement("style");
    s.id = "__vb-style";
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  };
  const byId = (id) => {
    const reg = window.__vbById;
    const el = reg && reg.get(id);
    if (el && el.isConnected) return el;
    return document.querySelector(`[data-vb-id="${id}"]`);
  };
  /** Box of `el` in top-document coordinates (walks up through same-origin iframes). */
  const box = (el) => {
    const r = el.getBoundingClientRect();
    let top = r.top;
    let left = r.left;
    let w = el.ownerDocument && el.ownerDocument.defaultView;
    while (w && w !== window && w.frameElement) {
      const fr = w.frameElement.getBoundingClientRect();
      top += fr.top;
      left += fr.left;
      w = w.parent;
    }
    return { top: top + window.scrollY, left: left + window.scrollX, width: r.width, height: r.height };
  };

  let toastEl = null;
  let toastTimer = null;
  const api = {
    toast(msg, ms = 1800) {
      ensureStyle();
      if (!toastEl || !toastEl.isConnected) {
        toastEl = document.createElement("div");
        toastEl.className = "__vb-toast";
        document.documentElement.appendChild(toastEl);
      }
      toastEl.textContent = "";
      const ic = document.createElement("span");
      ic.className = "__vb-ic";
      ic.textContent = "";
      const tx = document.createElement("span");
      tx.textContent = msg;
      toastEl.appendChild(ic);
      toastEl.appendChild(tx);
      requestAnimationFrame(() => toastEl.classList.add("__vb-show"));
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl && toastEl.classList.remove("__vb-show"), ms);
    },
    highlight(id, ms = 600) {
      ensureStyle();
      const el = byId(id);
      if (!el) return false;
      try {
        el.scrollIntoView({ block: "center", inline: "nearest" });
      } catch {}
      const b = box(el);
      const h = document.createElement("div");
      h.className = "__vb-hl";
      Object.assign(h.style, { top: b.top - 5 + "px", left: b.left - 5 + "px", width: b.width + 10 + "px", height: b.height + 10 + "px" });
      document.documentElement.appendChild(h);
      setTimeout(() => (h.style.opacity = "0"), ms);
      setTimeout(() => h.remove(), ms + 350);
      return true;
    },
    candidates(list, ms = 8000) {
      ensureStyle();
      api.clearCandidates();
      let first = true;
      for (const c of list) {
        const el = byId(c.id);
        if (!el) continue;
        if (first) {
          try {
            el.scrollIntoView({ block: "center" });
          } catch {}
          first = false;
        }
        const b = box(el);
        const frame = document.createElement("div");
        frame.className = "__vb-cand __vb-c";
        Object.assign(frame.style, { top: b.top - 4 + "px", left: b.left - 4 + "px", width: b.width + 8 + "px", height: b.height + 8 + "px" });
        const badge = document.createElement("div");
        badge.className = "__vb-badge __vb-c";
        badge.textContent = String(c.n);
        Object.assign(badge.style, { top: Math.max(0, b.top - 16) + "px", left: Math.max(0, b.left - 16) + "px" });
        document.documentElement.appendChild(frame);
        document.documentElement.appendChild(badge);
      }
      api._candTimer = setTimeout(api.clearCandidates, ms);
    },
    clearCandidates() {
      clearTimeout(api._candTimer);
      document.querySelectorAll(".__vb-c").forEach((n) => n.remove());
    },
  };
  window.__vb = api;
}
