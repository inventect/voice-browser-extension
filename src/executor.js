/**
 * Execute a policy action on the user's browser with Chrome extension APIs.
 *
 *  click / type / select / scroll / press enter  → content script (DOM, overlay feedback)
 *  navigate / reload / back / forward             → chrome.tabs.update / reload / goBack / goForward
 *  tabs                                           → chrome.tabs.create / remove / update({active})
 *
 * Port of voice-browser/src/executor.js (Playwright). Same action shapes, same return contract:
 * { ok: boolean, detail?: string }.
 */
import { describe } from "./policy.js";

const NAV_TIMEOUT = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} action  from policy.evaluatePolicy
 * @param {import('./chrome-browser.js').ChromeBrowser} browser
 * @returns {Promise<{ok: boolean, detail?: string}>}
 */
export async function execute(action, browser) {
  const chrome = browser.chrome;
  const tab = await browser.activeTab();
  const label = describe(action);

  switch (action.type) {
    case "navigate_url": {
      await browser.overlay("toast", `→ ${label}`);
      const host = new URL(action.url).hostname.replace(/^www\./, "");
      const nav = browser.waitForNavigation(tab.id, { startMs: 4000, completeMs: NAV_TIMEOUT });
      await chrome.tabs.update(tab.id, { url: action.url });
      const res = await nav;
      let url = (await browser.currentUrl()) || res.url || action.url;
      if (!url.includes(host)) {
        // Transient failure (network blip, interstitial): retry once.
        await sleep(500);
        const nav2 = browser.waitForNavigation(tab.id, { startMs: 4000, completeMs: NAV_TIMEOUT });
        await chrome.tabs.update(tab.id, { url: action.url }).catch(() => {});
        await nav2;
        url = (await browser.currentUrl()) || url;
      }
      await sleep(120);
      return { ok: true, detail: url };
    }

    case "click_element": {
      const nav = browser.waitForNavigation(tab.id, { startMs: 1200, completeMs: 8000 });
      const newTab = browser.waitForNewTab(tab.id, 1400);
      const res = await browser.exec(tab.id, { type: "click", id: action.targetId, label });
      if (!res?.ok) {
        return { ok: false, detail: res?.detail || "click failed" };
      }
      if (res.openUrl) {
        // target=_blank link: a programmatic click would hit the popup blocker; open the tab ourselves.
        const t = await chrome.tabs.create({ url: res.openUrl, active: true, openerTabId: tab.id });
        await browser.setActive(t.id);
        await browser.waitForNavigation(t.id, { startMs: 3000, completeMs: 8000 });
        return { ok: true, detail: (await browser.currentUrl()) || res.openUrl };
      }
      const navRes = await nav;
      const opened = navRes.navigated ? null : await newTab;
      if (opened && opened.id !== tab.id) {
        await browser.setActive(opened.id);
        await browser.waitForNavigation(opened.id, { startMs: 1500, completeMs: 8000 });
      } else if (!navRes.navigated) {
        await sleep(150); // in-page effect (menu, accordion, SPA route change)
      }
      return { ok: true, detail: (await browser.currentUrl()) || "" };
    }

    case "type_into_field": {
      const nav = browser.waitForNavigation(tab.id, { startMs: action.submit ? 1500 : 0, completeMs: 8000 });
      const res = await browser.exec(tab.id, { type: "type", id: action.targetId, text: action.text, submit: Boolean(action.submit), label });
      if (!res?.ok) return { ok: false, detail: res?.detail || "type failed" };
      if (action.submit) await nav;
      else await sleep(60);
      return { ok: true, detail: (await browser.currentUrl()) || "" };
    }

    case "select_option": {
      const res = await browser.exec(tab.id, { type: "select", id: action.targetId, text: action.text, label });
      return { ok: Boolean(res?.ok), detail: res?.detail || (res?.ok ? "selected" : "no matching option") };
    }

    case "press_enter": {
      const nav = browser.waitForNavigation(tab.id, { startMs: 1500, completeMs: 8000 });
      const res = await browser.exec(tab.id, { type: "press_enter", label });
      if (!res?.ok) return { ok: false, detail: res?.detail || "press enter failed" };
      await nav;
      return { ok: true, detail: (await browser.currentUrl()) || "" };
    }

    case "scroll_down":
    case "scroll_up": {
      const res = await browser.exec(tab.id, { type: "scroll", direction: action.type === "scroll_down" ? 1 : -1, amount: action.amount || "page", label });
      return { ok: Boolean(res?.ok), detail: res?.detail || "scrolled" };
    }

    case "go_back":
    case "go_forward": {
      const back = action.type === "go_back";
      await browser.overlay("toast", back ? "← back" : "→ forward");
      const nav = browser.waitForNavigation(tab.id, { startMs: 2500, completeMs: NAV_TIMEOUT });
      let failed = null;
      await browser.historyGo(tab.id, back ? -1 : 1).catch((e) => (failed = e));
      const res = await nav;
      if (!res.navigated) return { ok: false, detail: `no ${back ? "previous" : "next"} page in this tab${failed ? ` (${failed.message || failed})` : ""}` };
      await sleep(120);
      return { ok: true, detail: (await browser.currentUrl()) || "" };
    }

    case "reload": {
      await browser.overlay("toast", "↻ reload");
      const nav = browser.waitForNavigation(tab.id, { startMs: 2500, completeMs: NAV_TIMEOUT });
      await chrome.tabs.reload(tab.id).catch(() => {});
      await nav;
      return { ok: true, detail: (await browser.currentUrl()) || "" };
    }

    case "open_new_tab": {
      const t = await chrome.tabs.create({ active: true, windowId: tab.windowId });
      await browser.setActive(t.id);
      const tabs = await browser.windowTabs();
      return { ok: true, detail: `tabs=${tabs.length}` };
    }

    case "close_tab": {
      const before = await browser.windowTabs();
      const i = before.findIndex((t) => t.id === tab.id);
      await chrome.tabs.remove(tab.id);
      await sleep(80);
      let after = await browser.windowTabs();
      if (after.length === 0) {
        const all = (await chrome.tabs.query({})).filter((t) => !(t.url || "").startsWith(`chrome-extension://${browser.extensionId}/`));
        if (all.length === 0) await chrome.tabs.create({ active: true });
        after = await browser.windowTabs();
      }
      // Chrome activates a neighbour; mirror that choice so the next command targets it.
      const next = after.find((t) => t.active) || after[Math.min(i, after.length - 1)] || after[0];
      if (next) await browser.setActive(next.id);
      return { ok: true, detail: `tabs=${after.length}` };
    }

    case "switch_tab": {
      const tabs = await browser.windowTabs();
      if (tabs.length < 2) return { ok: false, detail: "only one tab" };
      const i = tabs.findIndex((t) => t.id === tab.id);
      let next;
      if (action.direction === "previous") next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (action.direction === "first") next = tabs[0];
      else next = tabs[(i + 1) % tabs.length];
      await browser.setActive(next.id);
      await browser.overlay("toast", "switched tab");
      return { ok: true, detail: next.url || "" };
    }

    default:
      return { ok: false, detail: `unknown action ${action.type}` };
  }
}
