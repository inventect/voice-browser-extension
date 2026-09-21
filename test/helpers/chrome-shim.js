/**
 * Minimal in-memory `chrome` shim for unit tests of the service-worker side
 * (chrome-browser.js, executor.js, app.js). Emulates: tabs (query/get/create/update/remove/
 * goBack/goForward/reload/sendMessage + events), scripting.executeScript, storage.local/session,
 * runtime (id, onMessage, sendMessage, onConnect, connect), webNavigation.onCommitted,
 * sidePanel.setPanelBehavior, windows.getCurrent — and a fake content script per tab that
 * answers the vb:* messages the way content.js does.
 */
import { MSG } from "../../src/protocol.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function makeEvent() {
  const fns = new Set();
  return {
    addListener: (fn) => fns.add(fn),
    removeListener: (fn) => fns.delete(fn),
    hasListener: (fn) => fns.has(fn),
    emit: (...args) => {
      const out = [];
      for (const fn of [...fns]) out.push(fn(...args));
      return out;
    },
    get size() {
      return fns.size;
    },
  };
}

function memStorage() {
  let data = {};
  return {
    async get(keys) {
      if (keys == null) return { ...data };
      const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    async clear() {
      data = {};
    },
    _dump: () => data,
  };
}

/** Raw element record as collectElementsInPage() would emit it. */
export function rawEl(id, over = {}) {
  return {
    id,
    tag: "a",
    role: "link",
    text: `Link ${id}`,
    placeholder: "",
    href: "",
    type: "",
    inputName: "",
    inViewport: true,
    top: 100,
    left: 0,
    ...over,
  };
}

export function createChromeShim({ extensionId = "abcdefghijklmnopabcdefghijklmnop", windowId = 1 } = {}) {
  const tabs = new Map(); // id -> tab
  const pages = new Map(); // id -> fake page state
  let nextTabId = 1;
  const focused = { windowId };

  const ev = {
    tabsCreated: makeEvent(),
    tabsRemoved: makeEvent(),
    tabsUpdated: makeEvent(),
    tabsActivated: makeEvent(),
    committed: makeEvent(),
    runtimeMessage: makeEvent(),
    runtimeConnect: makeEvent(),
    installed: makeEvent(),
    focusChanged: makeEvent(),
  };

  const tabOf = (id) => {
    const t = tabs.get(id);
    if (!t) throw new Error(`No tab with id: ${id}.`);
    return t;
  };

  function newPage(url, opts = {}) {
    return {
      url,
      title: opts.title ?? (url ? new URL(url, "https://x/").hostname : ""),
      elements: opts.elements ?? [],
      scrollY: 0,
      history: [url],
      histIndex: 0,
      hasContent: opts.hasContent ?? !/^(chrome|about|chrome-extension|devtools):/.test(url || "about:blank"),
      injected: 0,
      clicked: [],
      typed: [],
      overlay: [],
      messages: [],
      linkTargets: opts.linkTargets ?? {}, // elementId -> url navigated to on click
      submitUrl: opts.submitUrl ?? null, // url navigated to when a field is submitted
    };
  }

  /** Emulate a navigation of `tabId` to `url` (loading → committed → complete). */
  async function navigate(tabId, url, { pushHistory = true, delay = 5 } = {}) {
    const tab = tabOf(tabId);
    const page = pages.get(tabId);
    tab.status = "loading";
    tab.url = url;
    if (page) {
      if (pushHistory) {
        page.history = page.history.slice(0, page.histIndex + 1);
        page.history.push(url);
        page.histIndex = page.history.length - 1;
      }
      page.url = url;
      page.title = new URL(url, "https://x/").hostname;
      page.scrollY = 0;
      page.hasContent = !/^(chrome|about|chrome-extension|devtools):/.test(url);
      page.elements = shim.siteElements?.(url) ?? page.elements;
    }
    await tick(0);
    ev.tabsUpdated.emit(tabId, { status: "loading", url }, { ...tab });
    ev.committed.emit({ tabId, frameId: 0, url });
    await tick(delay);
    tab.status = "complete";
    tab.title = page?.title || "";
    ev.tabsUpdated.emit(tabId, { status: "complete" }, { ...tab });
  }

  function contentHandler(tabId, msg) {
    const page = pages.get(tabId);
    page.messages.push(msg);
    switch (msg.type) {
      case MSG.CS_PING:
        return { ok: true, url: page.url };
      case MSG.CS_SNAPSHOT:
        return { url: page.url, title: page.title, scrollY: page.scrollY, scrollHeight: 5000, viewportHeight: 900, elements: page.elements };
      case MSG.CS_OVERLAY:
        page.overlay.push([msg.fn, ...(msg.args || [])]);
        return { ok: true };
      case MSG.CS_EXEC: {
        const a = msg.action;
        if (a.type === "click") {
          const el = page.elements.find((e) => e.id === a.id);
          if (!el) return { ok: false, detail: "element not found" };
          page.clicked.push(a.id);
          const target = page.linkTargets[a.id] || (el.href ? `https://${el.href}` : null);
          if (el.target === "_blank" && target) return { ok: true, openUrl: target };
          if (target) setTimeout(() => navigate(tabId, target), 10);
          return { ok: true, detail: "clicked" };
        }
        if (a.type === "type") {
          const el = page.elements.find((e) => e.id === a.id);
          if (!el) return { ok: false, detail: "field not found" };
          page.typed.push({ id: a.id, text: a.text, submit: a.submit });
          if (a.submit && page.submitUrl) setTimeout(() => navigate(tabId, page.submitUrl.replace("%s", encodeURIComponent(a.text))), 10);
          return { ok: true, detail: a.submit ? "typed + enter" : "typed" };
        }
        if (a.type === "scroll") {
          const px = a.amount === "end" ? 4000 : a.amount === "little" ? 300 : 800;
          page.scrollY = Math.max(0, page.scrollY + a.direction * px);
          return { ok: true, detail: `scrollY=${page.scrollY}` };
        }
        if (a.type === "select") return { ok: true, detail: a.text };
        if (a.type === "press_enter") return { ok: true, detail: "enter" };
        return { ok: false, detail: `unknown ${a.type}` };
      }
      default:
        return { ok: false, error: "unknown" };
    }
  }

  const chrome = {
    runtime: {
      id: extensionId,
      onMessage: ev.runtimeMessage,
      onConnect: ev.runtimeConnect,
      onInstalled: ev.installed,
      getURL: (p) => `chrome-extension://${extensionId}/${p}`,
      async sendMessage(msg) {
        return new Promise((resolve) => {
          let async = false;
          for (const r of ev.runtimeMessage.emit(msg, { id: extensionId }, resolve)) if (r === true) async = true;
          if (!async) resolve(undefined);
        });
      },
      connect({ name }) {
        return shim.connect(name).client;
      },
    },
    tabs: {
      onCreated: ev.tabsCreated,
      onRemoved: ev.tabsRemoved,
      onUpdated: ev.tabsUpdated,
      onActivated: ev.tabsActivated,
      async query(q = {}) {
        let list = [...tabs.values()];
        if (q.active != null) list = list.filter((t) => t.active === q.active);
        if (q.windowId != null) list = list.filter((t) => t.windowId === q.windowId);
        if (q.lastFocusedWindow) list = list.filter((t) => t.windowId === focused.windowId);
        return list.map((t) => ({ ...t }));
      },
      async get(id) {
        return { ...tabOf(id) };
      },
      async create({ url = "about:blank", active = true, windowId: w = focused.windowId, openerTabId } = {}) {
        const id = nextTabId++;
        const index = [...tabs.values()].filter((t) => t.windowId === w).length;
        const tab = { id, url, pendingUrl: url, title: "", active: false, windowId: w, index, status: "complete", openerTabId, lastAccessed: Date.now() };
        tabs.set(id, tab);
        pages.set(id, newPage(url));
        ev.tabsCreated.emit({ ...tab });
        if (active) await chrome.tabs.update(id, { active: true });
        if (url && url !== "about:blank" && !url.startsWith("chrome")) navigate(id, url, { pushHistory: false });
        return { ...tab };
      },
      async update(id, props) {
        const tab = tabOf(id);
        if (props.active) {
          for (const t of tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
          tab.lastAccessed = Date.now();
          ev.tabsActivated.emit({ tabId: id, windowId: tab.windowId });
        }
        if (props.url) navigate(id, props.url);
        return { ...tab };
      },
      async remove(id) {
        const tab = tabOf(id);
        tabs.delete(id);
        pages.delete(id);
        const siblings = [...tabs.values()].filter((t) => t.windowId === tab.windowId).sort((a, b) => a.index - b.index);
        siblings.forEach((t, i) => (t.index = i));
        if (tab.active && siblings.length) {
          const next = siblings[Math.min(tab.index, siblings.length - 1)];
          next.active = true;
          ev.tabsActivated.emit({ tabId: next.id, windowId: tab.windowId });
        }
        ev.tabsRemoved.emit(id, { windowId: tab.windowId, isWindowClosing: siblings.length === 0 });
      },
      async goBack(id) {
        const page = pages.get(id);
        if (!page || page.histIndex <= 0) throw new Error("Cannot find a previous page in history.");
        page.histIndex -= 1;
        await navigate(id, page.history[page.histIndex], { pushHistory: false });
      },
      async goForward(id) {
        const page = pages.get(id);
        if (!page || page.histIndex >= page.history.length - 1) throw new Error("Cannot find a next page in history.");
        page.histIndex += 1;
        await navigate(id, page.history[page.histIndex], { pushHistory: false });
      },
      async reload(id) {
        const tab = tabOf(id);
        navigate(id, tab.url, { pushHistory: false });
      },
      async sendMessage(id, msg) {
        tabOf(id);
        const page = pages.get(id);
        if (!page || !page.hasContent) throw new Error("Could not establish connection. Receiving end does not exist.");
        return contentHandler(id, msg);
      },
    },
    scripting: {
      async executeScript({ target, files, func, args = [] }) {
        const tab = tabOf(target.tabId);
        const page = pages.get(target.tabId);
        if (/^(chrome|chrome-extension|about|devtools):/.test(tab.url) && tab.url !== "about:blank") {
          throw new Error(`Cannot access a chrome:// URL`);
        }
        if (func) {
          // Only history.go(delta) is emulated (what chrome-browser.historyGo injects).
          if (/history\.go/.test(String(func))) {
            const delta = args[0];
            const idx = page.histIndex + delta;
            if (idx < 0 || idx >= page.history.length) return [{ result: null }]; // no-op like a real history.go
            page.histIndex = idx;
            setTimeout(() => navigate(target.tabId, page.history[idx], { pushHistory: false }), 0);
            return [{ result: null }];
          }
          return [{ result: func(...args) }];
        }
        page.injected += 1;
        page.hasContent = true;
        shim.injections.push({ tabId: target.tabId, files });
        return [{ result: null }];
      },
    },
    storage: { local: memStorage(), session: memStorage() },
    webNavigation: { onCommitted: ev.committed },
    windows: {
      onFocusChanged: ev.focusChanged,
      async getCurrent() {
        return { id: focused.windowId };
      },
      async getLastFocused() {
        return { id: focused.windowId };
      },
    },
    sidePanel: {
      async setPanelBehavior(b) {
        shim.panelBehavior = b;
      },
    },
  };

  const shim = {
    chrome,
    tabs,
    pages,
    events: ev,
    injections: [],
    panelBehavior: null,
    focused,
    /** Optional: elements a navigated page should have, by URL. */
    siteElements: null,
    navigate,
    tick,
    /** Add a tab with a fake page. */
    async addTab({ url = "about:blank", active = true, elements = [], windowId: w = focused.windowId, hasContent, title, linkTargets, submitUrl } = {}) {
      const id = nextTabId++;
      const index = [...tabs.values()].filter((t) => t.windowId === w).length;
      const tab = { id, url, title: title ?? "", active: false, windowId: w, index, status: "complete", lastAccessed: Date.now() };
      tabs.set(id, tab);
      pages.set(id, newPage(url, { elements, hasContent, title, linkTargets, submitUrl }));
      if (active) for (const t of tabs.values()) if (t.windowId === w) t.active = t.id === id;
      return tab;
    },
    /** Create a port pair and fire runtime.onConnect with the worker-side end. */
    connect(name) {
      const workerMsg = makeEvent();
      const workerDisc = makeEvent();
      const client = { name, received: [], onMessage: makeEvent(), onDisconnect: makeEvent() };
      const worker = {
        name,
        sender: { id: extensionId },
        onMessage: workerMsg,
        onDisconnect: workerDisc,
        postMessage(m) {
          client.received.push(m);
          client.onMessage.emit(m);
        },
        disconnect() {
          workerDisc.emit();
        },
      };
      client.postMessage = (m) => workerMsg.emit(m, worker);
      client.disconnect = () => workerDisc.emit();
      ev.runtimeConnect.emit(worker);
      return { client, worker };
    },
  };
  return shim;
}
