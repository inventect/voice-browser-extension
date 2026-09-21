/**
 * Perception: turn the controlled page into a compact, Jev-friendly state.
 *
 *  - `collectElementsInPage` runs INSIDE the page (Playwright page.evaluate). It tags every
 *    interactive element with a stable `data-vb-id` (e01, e02, ...) and returns raw records.
 *  - `compactElements` runs in Node: prioritises viewport-visible elements, dedupes, truncates
 *    text and guards the total state size so it stays far below Jev's 32k-token limit.
 */
import { MAX_ELEMENTS, MAX_ELEMENT_TEXT, MAX_STATE_CHARS } from "./constants.js";

/**
 * Runs in the browser. Must be self-contained (no closures).
 *
 * Collects interactive elements from the main document, open shadow roots and same-origin
 * iframes; tags each with a stable `data-vb-id` and registers it in `window.__vbById` (a Map the
 * content script / overlay use to find elements that `document.querySelector` cannot reach —
 * inside shadow roots or other frames).
 *
 * Pop-ups: an open `<dialog>`, `[role=dialog|alertdialog]`, `[aria-modal=true]`, or a
 * fixed/sticky overlay that has controls and sits in a stack with a scrim covering ≥ 30 % of the
 * viewport is a "modal"; a smaller fixed strip with controls (cookie banner) is a "banner". Their
 * controls are collected FIRST (so the raw cap can never drop them), flagged `popup`, and the
 * pop-up's text is returned as `popup: {kind, text}` so Jev knows something is covering the page.
 */
export function collectElementsInPage() {
  const SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=option]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=switch]",
    "[role=searchbox]",
    "[role=combobox]",
    "[role=textbox]",
    "[contenteditable=true]",
    "[onclick]",
  ].join(",");
  const MAX_RAW = 400;
  const MODAL_COVERAGE = 0.3; // a scrim / panel covering this much of the viewport => modal
  const BANNER_COVERAGE = 0.03; // a fixed strip this big with buttons => banner (cookie bar)

  const win = window;
  const doc = document;
  if (!win.__vbNextId) win.__vbNextId = 1;
  const registry = new Map();
  win.__vbById = registry;

  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const out = [];
  const seen = new Set();
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  const visible = (el, style) => {
    if (!style) return false;
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility()) return false;
    return true;
  };

  // --- pop-up detection (main document) -------------------------------------------------------
  const popups = []; // [{ el, kind }]
  const addPopup = (el, kind) => {
    if (popups.some((p) => p.el === el)) return;
    // a dialog inside an already-detected overlay (or vice versa) counts once, as the outer node
    if (popups.some((p) => p.el.contains(el))) return;
    for (let i = popups.length - 1; i >= 0; i--) if (el.contains(popups[i].el)) popups.splice(i, 1);
    popups.push({ el, kind });
  };
  try {
    for (const el of doc.querySelectorAll("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]")) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || !visible(el, win.getComputedStyle(el))) continue;
      addPopup(el, "modal");
    }
    // A cookie / consent / newsletter strip: fixed to the top or bottom edge, wide, and carrying a
    // dismiss-style button or consent wording. (Sticky navigation bars and side panels are not.)
    const DISMISSY = /\b(accept|agree|allow|reject|decline|got it|ok(ay)?|close|dismiss|no thanks|not now|later|understood)\b|^\s*[×✕✖xX]\s*$/i;
    const CONSENTY = /cookie|consent|privacy|gdpr|newsletter|subscribe|sign up|we use|your experience/i;
    const looksLikeBanner = (node, r) => {
      const atEdge = r.top <= 2 || r.bottom >= vh - 2;
      if (!atEdge || r.width < vw * 0.5) return false;
      const text = clean((node.innerText || "").slice(0, 500));
      if (CONSENTY.test(text)) return true;
      for (const b of node.querySelectorAll("button,[role=button],a")) {
        if (DISMISSY.test(clean(b.getAttribute("aria-label") || b.innerText || "").slice(0, 40))) return true;
      }
      return false;
    };
    // Fixed overlays: look at what is stacked at a few points of the viewport.
    const points = [
      [vw / 2, vh / 2],
      [vw / 2, vh * 0.03],
      [vw / 2, vh * 0.97],
      [vw * 0.12, vh / 2],
      [vw * 0.88, vh / 2],
      [vw * 0.5, vh * 0.85],
    ];
    for (const [x, y] of points) {
      let stack;
      try {
        stack = doc.elementsFromPoint(x, y);
      } catch {
        continue;
      }
      // Stack is topmost first. The first fixed/sticky node that has controls is the panel; a big
      // fixed node BENEATH it is its scrim (=> modal). A big fixed node WITHOUT controls above
      // everything else is a backdrop covering whatever lies below, so that is not a pop-up.
      let panel = null;
      let scrim = false;
      for (const node of stack) {
        if (node === doc.documentElement || node === doc.body || node.nodeType !== 1) continue;
        const st = win.getComputedStyle(node);
        if (st.position !== "fixed") continue;
        const r = node.getBoundingClientRect();
        const frac = (Math.max(0, r.width) * Math.max(0, r.height)) / (vw * vh);
        const hasControls = node.matches(SELECTOR) || Boolean(node.querySelector(SELECTOR));
        if (!panel) {
          if (hasControls) panel = { node, frac, r };
          else if (frac >= MODAL_COVERAGE) break; // backdrop on top: what is beneath is covered
          continue;
        }
        if (frac >= MODAL_COVERAGE) {
          scrim = true;
          break;
        }
      }
      if (!panel) continue;
      if (scrim || panel.frac >= MODAL_COVERAGE) addPopup(panel.node, "modal");
      else if (panel.frac >= BANNER_COVERAGE && looksLikeBanner(panel.node, panel.r)) addPopup(panel.node, "banner");
    }
  } catch {
    /* detection is best effort */
  }
  popups.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "modal" ? -1 : 1));

  /** Is `el` inside `container`, crossing shadow boundaries and same-origin frames? */
  const within = (container, el) => {
    let n = el;
    while (n) {
      if (n === container) return true;
      if (n.nodeType === 11) n = n.host; // ShadowRoot -> host
      else if (n.nodeType === 9) n = n.defaultView && n.defaultView.frameElement; // Document -> <iframe>
      else n = n.parentNode;
    }
    return false;
  };

  // --- element collection -----------------------------------------------------------------------
  function visit(el, frame, popupKind) {
    if (seen.has(el) || out.length >= MAX_RAW) return;
    seen.add(el);
    let rect;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      return;
    }
    if (!rect || rect.width < 2 || rect.height < 2) return;
    const fwin = frame.win;
    if (!visible(el, fwin.getComputedStyle(el))) return;
    // viewport coordinates in the top window
    const top = rect.top + frame.y;
    const left = rect.left + frame.x;
    const bottom = rect.bottom + frame.y;
    const right = rect.right + frame.x;
    // clipped away by the iframe's own box?
    if (frame.depth && (rect.bottom < 0 || rect.top > frame.h || rect.right < 0 || rect.left > frame.w)) return;

    let id = el.getAttribute("data-vb-id");
    if (!id) {
      id = "e" + String(win.__vbNextId++).padStart(2, "0");
      el.setAttribute("data-vb-id", id);
    }
    registry.set(id, el);

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    let role = el.getAttribute("role") || "";
    if (!role) {
      if (tag === "a") role = "link";
      else if (tag === "button" || type === "submit" || type === "button" || type === "reset") role = "button";
      else if (tag === "select") role = "select";
      else if (tag === "textarea") role = "textbox";
      else if (tag === "summary") role = "button";
      else if (tag === "input") {
        if (type === "search") role = "searchbox";
        else if (type === "checkbox") role = "checkbox";
        else if (type === "radio") role = "radio";
        else role = "textbox";
      } else if (el.isContentEditable) role = "textbox";
      else role = "clickable";
    }

    const img = el.querySelector && el.querySelector("img[alt]");
    const name =
      clean(el.getAttribute("aria-label")) ||
      clean(el.innerText) ||
      clean(el.value) ||
      clean(el.getAttribute("placeholder")) ||
      clean(el.getAttribute("title")) ||
      (img && clean(img.getAttribute("alt"))) ||
      clean(el.getAttribute("name")) ||
      "";

    const placeholder = clean(el.getAttribute("placeholder"));
    let href = "";
    if (tag === "a") {
      try {
        const u = new URL(el.href, el.ownerDocument.location.href);
        href = u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname : "");
      } catch {
        href = "";
      }
    }

    const inViewport = bottom > 0 && top < vh && right > 0 && left < vw;
    const inputName = clean(el.getAttribute("name")) || clean(el.getAttribute("id"));
    const kind = popupKind || (popups.find((p) => within(p.el, el)) || {}).kind || "";

    const rec = {
      id,
      tag,
      role,
      text: name,
      placeholder,
      href,
      type,
      inputName,
      inViewport,
      top: Math.round(top + win.scrollY),
      left: Math.round(left + win.scrollX),
    };
    if (kind) rec.popup = kind;
    if (frame.depth) rec.frame = frame.depth;
    out.push(rec);
  }

  /** Collect from a document / shadow root / element subtree, descending into shadow roots and same-origin iframes. */
  function collectIn(root, frame, popupKind) {
    if (out.length >= MAX_RAW) return;
    if (root.nodeType === 1 && root.matches(SELECTOR)) visit(root, frame, popupKind);
    for (const el of root.querySelectorAll(SELECTOR)) visit(el, frame, popupKind);
    // open shadow roots
    for (const host of root.querySelectorAll("*")) {
      if (host.shadowRoot) collectIn(host.shadowRoot, frame, popupKind);
    }
    // same-origin iframes (cross-origin ones throw / have no contentDocument and stay invisible)
    if (frame.depth < 2) {
      for (const f of root.querySelectorAll("iframe,frame")) {
        let fdoc = null;
        try {
          fdoc = f.contentDocument;
        } catch {
          fdoc = null;
        }
        if (!fdoc || !fdoc.body || !fdoc.defaultView) continue;
        const fr = f.getBoundingClientRect();
        if (fr.width < 2 || fr.height < 2) continue;
        collectIn(fdoc, { x: frame.x + fr.left, y: frame.y + fr.top, w: fr.width, h: fr.height, win: fdoc.defaultView, depth: frame.depth + 1 }, popupKind);
      }
    }
  }

  const topFrame = { x: 0, y: 0, w: vw, h: vh, win, depth: 0 };
  // Pop-up controls first: they can never be dropped by the raw cap and rank first for Jev.
  for (const p of popups) collectIn(p.el, topFrame, p.kind);
  collectIn(doc, topFrame, "");

  let popup = null;
  if (popups.length) {
    const first = popups[0];
    const text = clean(first.el.innerText || first.el.textContent || first.el.getAttribute("aria-label") || "")
      .replace(/^[×✕✖xX]\s+/, "") // a leading close glyph is not part of the message
      .slice(0, 160);
    popup = { kind: first.kind, text, count: popups.length };
  }

  return {
    url: location.href,
    title: doc.title,
    scrollY: win.scrollY,
    scrollHeight: doc.documentElement.scrollHeight,
    viewportHeight: vh,
    popup,
    elements: out,
  };
}

/** Coarse site detection from the URL (code, not Jev). */
export function detectSite(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "generic";
  }
  if (host.endsWith("google.com") || host.endsWith("google.co.uk")) return "google";
  if (host.endsWith("duckduckgo.com")) return "duckduckgo";
  if (host.endsWith("youtube.com")) return "youtube";
  if (host.endsWith("wikipedia.org")) return "wikipedia";
  if (host.endsWith("github.com")) return "github";
  if (host.endsWith("amazon.com") || host.endsWith("amazon.de") || host.endsWith("amazon.co.uk")) return "amazon";
  if (host.endsWith("reddit.com")) return "reddit";
  if (host === "x.com" || host.endsWith("twitter.com")) return "twitter_x";
  if (host.endsWith("news.ycombinator.com")) return "hacker_news";
  if (host === "example.com") return "example_com";
  if (!host || url.startsWith("about:")) return "blank";
  return "generic";
}

const SEARCHY = /(^|[^a-z])(q|query|search|s|keyword|k|search_query)($|[^a-z])/i;

/** Heuristic: which element id is the page's main search box? */
export function findSearchBox(elements) {
  const inputs = elements.filter((e) => ["searchbox", "textbox", "combobox"].includes(e.role));
  const scored = inputs.map((e) => {
    let s = 0;
    if (e.role === "searchbox" || e.type === "search") s += 5;
    if (SEARCHY.test(e.inputName || "")) s += 3;
    if (/search/i.test(e.placeholder || "") || /search/i.test(e.text || "")) s += 3;
    if (e.inViewport) s += 1;
    return { e, s };
  });
  scored.sort((a, b) => b.s - a.s || a.e.top - b.e.top);
  // Needs at least one real search signal: being a visible textbox alone (an e-mail field in a
  // newsletter pop-up) does not make a search box.
  return scored.length && scored[0].s > 1 ? scored[0].e.id : null;
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

const POPUP_RANK = { modal: 0, banner: 1 };

/**
 * Build the compact element list that goes into the Jev state.
 * Priority: pop-up controls (modal, then banner) first, then viewport-visible (top-to-bottom),
 * then the rest. Dedupe on (role, text, href). Drops nameless elements unless they are inputs.
 * Enforces MAX_ELEMENTS and MAX_STATE_CHARS.
 */
export function compactElements(rawElements, opts = {}) {
  const maxElements = opts.maxElements ?? MAX_ELEMENTS;
  const maxText = opts.maxText ?? MAX_ELEMENT_TEXT;
  const maxChars = opts.maxChars ?? MAX_STATE_CHARS;

  const rank = (e) => (e.popup ? POPUP_RANK[e.popup] ?? 1 : 2);
  const sorted = [...rawElements].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
    return a.top - b.top || a.left - b.left;
  });

  const seen = new Set();
  const out = [];
  for (const e of sorted) {
    const isInput = ["textbox", "searchbox", "combobox", "select", "checkbox", "radio"].includes(e.role);
    const text = truncate(e.text || e.placeholder, maxText);
    if (!text && !isInput) continue;
    const key = `${e.role}|${text.toLowerCase()}|${e.href || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = { id: e.id, role: e.role, text };
    if (e.placeholder && e.placeholder !== text) rec.placeholder = truncate(e.placeholder, 40);
    if (e.href) rec.href = truncate(e.href, 50);
    if (!e.inViewport) rec.below_fold = true;
    if (e.popup) rec.popup = e.popup;
    if (e.frame) rec.frame = e.frame;
    out.push(rec);
    if (out.length >= maxElements) break;
  }

  // Size guard: shrink until the serialized list fits the budget.
  while (out.length > 5 && JSON.stringify(out).length > maxChars) {
    out.length = Math.max(5, Math.floor(out.length * 0.8));
  }
  return out;
}

/** Full snapshot record used by the controller: raw (for execution) + compact (for Jev). */
export function buildSnapshot(pageData, extra = {}) {
  const elements = compactElements(pageData.elements);
  const searchBoxId = findSearchBox(pageData.elements);
  const site = detectSite(pageData.url);
  return {
    url: pageData.url,
    title: pageData.title,
    site,
    scrollY: pageData.scrollY,
    scrollHeight: pageData.scrollHeight,
    viewportHeight: pageData.viewportHeight,
    searchBoxId,
    popup: pageData.popup || null, // { kind: "modal" | "banner", text, count } when something covers the page
    elements,
    rawById: Object.fromEntries(pageData.elements.map((e) => [e.id, e])),
    ...extra,
  };
}

/** Approximate token count for observability (~4 chars/token English). */
export function approxTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}
