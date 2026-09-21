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
  const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif`;
  const css = `
    .__vb-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(8px);display:flex;align-items:center;gap:10px;
      background:rgba(24,20,16,.94);color:#f7f2ea;font:500 14px/1.3 ${FONT};padding:11px 16px 11px 12px;border-radius:14px;
      box-shadow:0 12px 40px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.08) inset;z-index:${Z};opacity:0;transition:opacity .18s,transform .18s;
      pointer-events:none;max-width:70vw;letter-spacing:.1px;backdrop-filter:blur(8px)}
    .__vb-toast.__vb-show{opacity:1;transform:translateX(-50%) translateY(0)}
    .__vb-toast .__vb-ic{width:22px;height:22px;border-radius:50%;background:#f0a030;display:inline-flex;align-items:center;justify-content:center;flex:none;color:#1a1410;font-weight:700;font-size:13px}
    .__vb-hl{position:absolute;border:2px solid #f0a030;border-radius:10px;box-shadow:0 0 0 4px rgba(240,160,48,.22),0 10px 30px rgba(240,160,48,.35);
      z-index:${Z};pointer-events:none;transition:opacity .3s;animation:__vb-in .22s ease-out}
    @keyframes __vb-in{from{transform:scale(1.06);opacity:0}to{transform:scale(1);opacity:1}}
    .__vb-badge{position:absolute;min-width:26px;height:26px;padding:0 8px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
      background:#1a1410;color:#fff;font:700 14px/1 ${FONT};border-radius:999px;z-index:${Z};pointer-events:none;
      border:2px solid #f0a030;box-shadow:0 4px 14px rgba(0,0,0,.35),0 0 0 2px rgba(255,255,255,.9)}
    .__vb-cand{position:absolute;border:2px solid #f0a030;border-radius:10px;z-index:${Z};pointer-events:none;
      background:rgba(240,160,48,.10);box-shadow:0 0 0 3px rgba(255,255,255,.55)}
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
      ic.textContent = "●";
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
