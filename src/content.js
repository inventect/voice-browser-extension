/**
 * Content script: the extension's perception + hands inside the page.
 *
 *  - snapshot: collectElementsInPage() (tags elements with data-vb-id, from snapshot.js)
 *  - DOM actions: click / type / select / press enter / scroll (the DOM half of the old executor)
 *  - overlay: highlight / toast / numbered candidate badges (overlay.js)
 *
 * Declared for <all_urls> in the manifest AND injectable on demand via chrome.scripting; the
 * guard below makes a second injection a no-op. Bundled as an IIFE (content scripts can't be ESM).
 * It never sees the API key and only answers messages from this extension's service worker.
 */
import { collectElementsInPage } from "./snapshot.js";
import { installOverlay } from "./overlay.js";
import { HIGHLIGHT_MS } from "./constants.js";
import { MSG } from "./protocol.js";

(() => {
  if (window.__vbContentLoaded) return;
  window.__vbContentLoaded = true;
  installOverlay();

  const byId = (id) => document.querySelector(`[data-vb-id="${id}"]`);
  const vb = () => window.__vb;

  function fire(el, type, init = {}) {
    const Ctor = type.startsWith("pointer") ? PointerEvent : type.startsWith("key") ? KeyboardEvent : type === "input" ? InputEvent : MouseEvent;
    const ev = new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, ...init });
    return el.dispatchEvent(ev);
  }

  function realClick(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {}
    const r = el.getBoundingClientRect();
    const pos = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1 };
    fire(el, "pointerdown", pos);
    fire(el, "mousedown", pos);
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    fire(el, "pointerup", { ...pos, buttons: 0 });
    fire(el, "mouseup", { ...pos, buttons: 0 });
    if (typeof el.click === "function") el.click();
    else fire(el, "click", pos);
  }

  /** Set an input's value the way a user would, so React/Vue-style controlled inputs notice. */
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }

  function typeInto(el, text) {
    el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, text);
      return;
    }
    setValue(el, "");
    fire(el, "input", { inputType: "deleteContentBackward", data: null });
    let cur = "";
    for (const ch of text) {
      fire(el, "keydown", { key: ch, bubbles: true });
      cur += ch;
      setValue(el, cur);
      fire(el, "input", { inputType: "insertText", data: ch });
      fire(el, "keyup", { key: ch, bubbles: true });
    }
    fire(el, "change");
  }

  function pressEnter(el) {
    const target = el || document.activeElement || document.body;
    const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13 };
    const notPrevented = fire(target, "keydown", init);
    fire(target, "keypress", init);
    fire(target, "keyup", init);
    const form = target.form || target.closest?.("form");
    if (notPrevented && form) {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
      return "submitted form";
    }
    return notPrevented ? "enter pressed" : "enter handled by page";
  }

  function exec(action) {
    switch (action.type) {
      case "click": {
        const el = byId(action.id);
        if (!el) return { ok: false, detail: "element not found (page changed?) — say it again" };
        vb().clearCandidates();
        vb().highlight(action.id, HIGHLIGHT_MS);
        if (action.label) vb().toast(action.label);
        const a = el.closest("a[href]") || el;
        if (a.tagName === "A" && a.target === "_blank" && a.href) {
          // A programmatic click on a new-window link is eaten by the popup blocker; let the
          // service worker open the tab instead.
          return { ok: true, openUrl: a.href };
        }
        // Respond first: if the click navigates, this script is torn down with the page and the
        // response would never arrive. 180 ms lets the human see the highlight.
        setTimeout(() => {
          try {
            realClick(el);
          } catch (err) {
            vb().toast(`click failed: ${err?.message || err}`);
          }
        }, 180);
        return { ok: true, detail: "clicked" };
      }

      case "type": {
        const el = byId(action.id);
        if (!el) return { ok: false, detail: "field not found — say it again" };
        vb().clearCandidates();
        vb().highlight(action.id, HIGHLIGHT_MS + 400);
        if (action.label) vb().toast(action.label);
        typeInto(el, action.text || "");
        if (action.submit) setTimeout(() => pressEnter(el), 40); // respond before the navigation kills us
        return { ok: true, detail: action.submit ? "typed + enter" : "typed" };
      }

      case "select": {
        const sel = byId(action.id);
        if (!sel) return { ok: false, detail: "dropdown not found" };
        vb().highlight(action.id, HIGHLIGHT_MS);
        if (action.label) vb().toast(action.label);
        const w = String(action.text || "").toLowerCase();
        const opts = Array.from(sel.options || []);
        const hit = opts.find((o) => o.label.toLowerCase() === w) || opts.find((o) => o.label.toLowerCase().includes(w));
        if (!hit) return { ok: false, detail: "no matching option" };
        sel.value = hit.value;
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, detail: hit.label };
      }

      case "press_enter": {
        vb().toast("⏎ enter");
        const el = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
        setTimeout(() => pressEnter(el), 20);
        return { ok: true, detail: "enter" };
      }

      case "scroll": {
        const dir = action.direction > 0 ? 1 : -1;
        const amount = action.amount || "page";
        if (action.label) vb().toast(action.label);
        const vh = window.innerHeight;
        if (amount === "end") {
          window.scrollTo({ top: dir > 0 ? document.documentElement.scrollHeight : 0, behavior: "auto" });
        } else {
          const px = amount === "little" ? vh * 0.35 : vh * 0.85;
          window.scrollBy({ top: dir * px, behavior: "smooth" });
        }
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true, detail: `scrollY=${Math.round(window.scrollY)}` }), 400));
      }

      default:
        return { ok: false, detail: `unknown content action ${action.type}` };
    }
  }

  function handle(msg) {
    switch (msg.type) {
      case MSG.CS_PING:
        return { ok: true, url: location.href };
      case MSG.CS_SNAPSHOT:
        return collectElementsInPage();
      case MSG.CS_OVERLAY: {
        const fn = vb()?.[msg.fn];
        if (typeof fn !== "function") return { ok: false, error: `no overlay fn ${msg.fn}` };
        return { ok: true, result: fn(...(msg.args || [])) ?? null };
      }
      case MSG.CS_EXEC:
        return exec(msg.action || {});
      default:
        return { ok: false, error: `unknown message ${msg.type}` };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("vb:")) return false;
    let result;
    try {
      result = handle(msg);
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
      return false;
    }
    if (result && typeof result.then === "function") {
      result.then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // async response
    }
    sendResponse(result);
    return false;
  });
})();
