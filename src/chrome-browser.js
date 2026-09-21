/**
 * Browser adapter over chrome.tabs / chrome.scripting for the controller and executor
 * (the role voice-browser/src/browser.js played with Playwright).
 *
 *  - resolves "the tab to control": the active tab of the side panel's window, skipping our own
 *    extension pages (options page, side panel opened as a tab in tests)
 *  - snapshot(): asks the content script for the raw element list, compacts it here (snapshot.js)
 *  - content script delivery: declared in the manifest for <all_urls> (runs on every navigation,
 *    no race after a page load) + on-demand chrome.scripting.executeScript as a fallback for tabs
 *    that were already open when the extension was (re)loaded. content.js is idempotent.
 *  - waitForNavigation(): tabs.onUpdated + webNavigation.onCommitted based outcome detection
 *  - pages where no script can run (chrome://, Web Store, PDF viewer) yield a `restricted` snapshot
 */
import { buildSnapshot } from "./snapshot.js";
import { MSG, isRestrictedUrl, isBlankUrl, isOwnExtensionUrl } from "./protocol.js";

const CONTENT_TIMEOUT_MS = 5000;

const withTimeout = (p, ms, what) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

export class ChromeBrowser {
  constructor(chromeApi = globalThis.chrome) {
    this.chrome = chromeApi;
    this.tabs = new Map(); // tabId -> chrome tab (cached)
    this.activeTabId = null; // the tab we control
    this.preferredWindowId = null; // set by the side panel (chrome.windows.getCurrent)
    this.listeners = new Set();
    this._navWaiters = new Set();
    this._newTabWaiters = new Set();
    this._lastNormalTab = new Map(); // windowId -> last activated non-extension tab id
  }

  get extensionId() {
    return this.chrome.runtime?.id || "";
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit(info = {}) {
    for (const fn of this.listeners) {
      try {
        fn(info);
      } catch (err) {
        console.error("browser listener failed", err);
      }
    }
  }

  async init() {
    const all = await this.chrome.tabs.query({});
    for (const t of all) this._upsert(t);
    const c = this.chrome;
    c.tabs.onCreated.addListener((tab) => {
      this._upsert(tab);
      for (const w of [...this._newTabWaiters]) w(tab);
      this._emit({ tabsChanged: true });
    });
    c.tabs.onRemoved.addListener((tabId) => {
      this.tabs.delete(tabId);
      if (this.activeTabId === tabId) this.activeTabId = null;
      this._emit({ tabsChanged: true, activeChanged: this.activeTabId === null });
    });
    c.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (tab) this._upsert(tab);
      else {
        const cur = this.tabs.get(tabId);
        if (cur) this.tabs.set(tabId, { ...cur, ...changeInfo });
      }
      for (const w of [...this._navWaiters]) w(tabId, changeInfo);
      if (tabId === this.activeTabId && (changeInfo.status === "complete" || changeInfo.url)) this._emit({ navigated: true, tabId });
    });
    c.tabs.onActivated.addListener(({ tabId, windowId }) => {
      const t = this.tabs.get(tabId);
      for (const [id, tab] of this.tabs) if (tab.windowId === windowId) this.tabs.set(id, { ...tab, active: id === tabId });
      const url = t?.url || t?.pendingUrl || "";
      if (!isOwnExtensionUrl(url, this.extensionId)) {
        this._lastNormalTab.set(windowId, tabId);
        if (tabId !== this.activeTabId) {
          this.activeTabId = tabId;
          this._emit({ activeChanged: true, tabId });
          return;
        }
      }
      this._emit({ tabsChanged: true });
    });
    c.webNavigation?.onCommitted?.addListener((details) => {
      if (details.frameId !== 0) return;
      for (const w of [...this._navWaiters]) w(details.tabId, { status: "loading", url: details.url, committed: true });
    });
    await this.activeTab();
    return this;
  }

  _upsert(tab) {
    if (!tab || tab.id == null) return;
    const prev = this.tabs.get(tab.id) || {};
    this.tabs.set(tab.id, { ...prev, ...tab, url: tab.url || tab.pendingUrl || prev.url || "" });
  }

  setPreferredWindow(windowId) {
    this.preferredWindowId = windowId ?? null;
  }

  /** Mark a tab as the one we control (after open_new_tab / switch_tab / a click that opened a tab). */
  async setActive(tabId) {
    this.activeTabId = tabId;
    await this.chrome.tabs.update(tabId, { active: true }).catch(() => {});
    const t = await this.chrome.tabs.get(tabId).catch(() => null);
    if (t) this._upsert(t);
    this._emit({ activeChanged: true, tabId });
  }

  /**
   * The tab to control: active tab of the preferred (side panel) window, else of the last focused
   * window; our own extension pages are skipped in favour of the last normal tab of that window.
   */
  async activeTab() {
    const all = await this.chrome.tabs.query({});
    this.tabs.clear();
    for (const t of all) this._upsert(t);
    const own = (t) => isOwnExtensionUrl(t.url || t.pendingUrl, this.extensionId);

    let windowId = this.preferredWindowId;
    if (windowId != null && !all.some((t) => t.windowId === windowId)) windowId = null;
    if (windowId == null) {
      const focused = await this.chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      if (focused[0]) windowId = focused[0].windowId;
    }
    if (windowId == null && this.activeTabId != null && this.tabs.has(this.activeTabId)) windowId = this.tabs.get(this.activeTabId).windowId;
    if (windowId == null && all[0]) windowId = all[0].windowId;

    const inWindow = all.filter((t) => t.windowId === windowId);
    let pick = inWindow.find((t) => t.active && !own(t));
    if (!pick) {
      const last = this._lastNormalTab.get(windowId);
      pick = inWindow.find((t) => t.id === last && !own(t));
    }
    if (!pick) {
      // sticky: keep controlling the tab we controlled before if it still exists in this window
      pick = inWindow.find((t) => t.id === this.activeTabId && !own(t));
    }
    if (!pick) pick = inWindow.filter((t) => !own(t)).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (!pick) pick = all.filter((t) => !own(t)).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (!pick) {
      pick = await this.chrome.tabs.create({ active: true });
      this._upsert(pick);
    }
    if (pick.id !== this.activeTabId) {
      this.activeTabId = pick.id;
      this._emit({ activeChanged: true, tabId: pick.id });
    }
    return this.tabs.get(pick.id) || pick;
  }

  /** Key for the per-tab conversation context. */
  contextKey() {
    return String(this.activeTabId ?? "default");
  }

  /** Cached tab list (sync; used in uiState / Jev state). */
  tabInfo() {
    return [...this.tabs.values()]
      .filter((t) => !isOwnExtensionUrl(t.url, this.extensionId))
      .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
      .map((t, i) => ({ index: i, id: t.id, url: t.url || "", title: t.title || "", active: t.id === this.activeTabId, windowId: t.windowId }));
  }

  /** Tabs in the controlled tab's window, in tab-strip order (for switch_tab / close_tab). */
  async windowTabs() {
    const cur = this.tabs.get(this.activeTabId);
    const all = await this.chrome.tabs.query(cur ? { windowId: cur.windowId } : {});
    for (const t of all) this._upsert(t);
    return all.filter((t) => !isOwnExtensionUrl(t.url, this.extensionId)).sort((a, b) => a.index - b.index);
  }

  /** URL of the controlled tab right now (used to derive an action's outcome). */
  async currentUrl() {
    if (this.activeTabId == null) return null;
    try {
      const t = await this.chrome.tabs.get(this.activeTabId);
      this._upsert(t);
      return t.url || t.pendingUrl || null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------- content script plumbing

  async _send(tabId, msg) {
    const res = await withTimeout(this.chrome.tabs.sendMessage(tabId, msg), CONTENT_TIMEOUT_MS, `content script (${msg.type})`);
    if (res && res.ok === false && res.error) throw new Error(res.error);
    return res;
  }

  async ensureContentScript(tabId) {
    await this.chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await new Promise((r) => setTimeout(r, 30));
  }

  /** Message the content script; if it is not there yet (pre-existing tab), inject it and retry once. */
  async sendToContent(tabId, msg) {
    try {
      return await this._send(tabId, msg);
    } catch (err) {
      const m = String(err?.message || err);
      // "Could not establish connection. Receiving end does not exist." = no content script yet.
      if (!/Receiving end|establish connection|message port closed|timed out/i.test(m)) throw err;
      try {
        await this.ensureContentScript(tabId);
      } catch (injErr) {
        throw new Error(`cannot run on this page: ${String(injErr?.message || injErr).slice(0, 120)}`);
      }
      return await this._send(tabId, msg);
    }
  }

  /** Snapshot the controlled tab (URL, title, compact element list, search box, site). */
  async snapshot() {
    const tab = await this.activeTab();
    const tabs = this.tabInfo();
    const url = tab.url || tab.pendingUrl || "about:blank";
    const minimal = { url, title: tab.title || "", scrollY: 0, scrollHeight: 0, viewportHeight: 0, elements: [] };
    if (isRestrictedUrl(url)) {
      return buildSnapshot(minimal, { tabs, tabId: tab.id, restricted: true, blank: isBlankUrl(url), error: isBlankUrl(url) ? null : "content scripts cannot run on this page" });
    }
    try {
      const data = await this.sendToContent(tab.id, { type: MSG.CS_SNAPSHOT });
      return buildSnapshot(data, { tabs, tabId: tab.id });
    } catch (err) {
      return buildSnapshot(minimal, { tabs, tabId: tab.id, restricted: true, error: String(err?.message || err) });
    }
  }

  /** Call window.__vb.<fn>(...args) in the controlled page, swallowing errors. */
  async overlay(fn, ...args) {
    const tabId = this.activeTabId;
    if (tabId == null) return;
    const tab = this.tabs.get(tabId);
    if (tab && isRestrictedUrl(tab.url)) return;
    await this.sendToContent(tabId, { type: MSG.CS_OVERLAY, fn, args }).catch(() => {});
  }

  /** Run a DOM action in the controlled page (click / type / select / press_enter / scroll). */
  async exec(tabId, action) {
    return this.sendToContent(tabId, { type: MSG.CS_EXEC, action });
  }

  /**
   * history.go(delta) for the controlled tab. chrome.tabs.goBack/goForward refuse entries that
   * were created without a user gesture (Chrome's history-manipulation intervention marks them
   * "skippable" — and every navigation this extension makes is gesture-less), so an in-page
   * `history.back()` is the primary path; the chrome.tabs API is the fallback for pages where no
   * script can run (chrome://, Web Store, PDF viewer).
   */
  async historyGo(tabId, delta) {
    const tab = this.tabs.get(tabId) || (await this.chrome.tabs.get(tabId).catch(() => null));
    const url = tab?.url || "";
    if (!isRestrictedUrl(url)) {
      try {
        await this.chrome.scripting.executeScript({ target: { tabId }, func: (d) => history.go(d), args: [delta] });
        return { via: "history.go" };
      } catch {
        /* fall through to the tabs API */
      }
    }
    if (delta < 0) await this.chrome.tabs.goBack(tabId);
    else await this.chrome.tabs.goForward(tabId);
    return { via: "chrome.tabs" };
  }

  // --------------------------------------------------------------- navigation outcome

  /**
   * Resolve once a navigation that starts within `startMs` reaches status "complete" (or after
   * `completeMs`). Resolves { navigated: false } if none starts. Register BEFORE triggering the
   * action so an early "loading" event is not missed.
   */
  waitForNavigation(tabId, { startMs = 600, completeMs = 10000 } = {}) {
    return new Promise((resolve) => {
      let started = false;
      let done = false;
      let startTimer = null;
      let completeTimer = null;
      const finish = (navigated) => {
        if (done) return;
        done = true;
        clearTimeout(startTimer);
        clearTimeout(completeTimer);
        this._navWaiters.delete(w);
        resolve({ navigated, url: this.tabs.get(tabId)?.url || null });
      };
      const w = (id, info) => {
        if (id !== tabId) return;
        if (!started && (info.status === "loading" || info.url)) {
          started = true;
          clearTimeout(startTimer);
          completeTimer = setTimeout(() => finish(true), completeMs);
        }
        if (started && info.status === "complete") finish(true);
      };
      this._navWaiters.add(w);
      startTimer = setTimeout(() => {
        if (!started) finish(false);
      }, startMs);
    });
  }

  /** Resolve with a tab opened from `openerTabId` within `ms`, else null. */
  waitForNewTab(openerTabId, ms = 500) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (tab) => {
        if (done) return;
        done = true;
        this._newTabWaiters.delete(w);
        resolve(tab);
      };
      const w = (tab) => {
        if (tab.openerTabId === openerTabId || tab.openerTabId == null) finish(tab);
      };
      this._newTabWaiters.add(w);
      setTimeout(() => finish(null), ms);
    });
  }
}
