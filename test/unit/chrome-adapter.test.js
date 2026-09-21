/**
 * ChromeBrowser adapter + executor against the chrome shim: tab selection, snapshot via content
 * script (with on-demand injection fallback), restricted pages, every action type, and the
 * outcome recorded in context after a click that navigates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChromeShim, rawEl } from "../helpers/chrome-shim.js";
import { ChromeBrowser } from "../../src/chrome-browser.js";
import { execute } from "../../src/executor.js";
import { Controller } from "../../src/controller.js";
import { mockDecide } from "../helpers/mock-jev.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup({ url = "https://example.com/", elements = [rawEl("e01", { text: "More information", href: "iana.org/domains/example" })], ...rest } = {}) {
  const shim = createChromeShim();
  const tab = await shim.addTab({ url, elements, ...rest });
  const browser = new ChromeBrowser(shim.chrome);
  await browser.init();
  return { shim, tab, browser };
}

test("activeTab picks the active tab of the focused window and skips our own extension pages", async () => {
  const { shim, tab, browser } = await setup();
  assert.equal((await browser.activeTab()).id, tab.id);
  // the side panel opened as a tab (e2e) or the options page must never be "the controlled tab"
  const own = await shim.addTab({ url: `chrome-extension://${shim.chrome.runtime.id}/sidepanel.html`, active: true });
  assert.notEqual((await browser.activeTab()).id, own.id);
  assert.equal((await browser.activeTab()).id, tab.id);
  assert.equal(browser.tabInfo().length, 1, "own pages are not listed");
});

test("snapshot: compacts the content script's elements, detects site + search box", async () => {
  const { browser } = await setup({
    url: "https://en.wikipedia.org/wiki/Main_Page",
    elements: [rawEl("e01", { text: "Main page", href: "en.wikipedia.org/wiki/Main_Page" }), rawEl("e02", { tag: "input", role: "searchbox", text: "", placeholder: "Search Wikipedia", inputName: "search" })],
  });
  const s = await browser.snapshot();
  assert.equal(s.site, "wikipedia");
  assert.equal(s.searchBoxId, "e02");
  assert.equal(s.elements.length, 2);
  assert.equal(s.restricted, undefined);
});

test("snapshot: injects content.js on demand when the tab predates the extension", async () => {
  const { shim, tab, browser } = await setup({ hasContent: false });
  const s = await browser.snapshot();
  assert.equal(s.elements.length, 1);
  assert.equal(shim.injections.length, 1);
  assert.deepEqual(shim.injections[0], { tabId: tab.id, files: ["content.js"] });
  // second snapshot: script already there, no re-injection
  await browser.snapshot();
  assert.equal(shim.injections.length, 1);
});

test("restricted pages (chrome://) give a restricted snapshot; navigation still works", async () => {
  const { shim, browser } = await setup({ url: "chrome://extensions/" });
  const s = await browser.snapshot();
  assert.equal(s.restricted, true);
  assert.equal(s.elements.length, 0);
  assert.equal(shim.injections.length, 0, "no injection attempted on chrome://");
  const r = await execute({ type: "navigate_url", url: "https://example.com/", label: "example" }, browser);
  assert.equal(r.ok, true);
  assert.equal(r.detail, "https://example.com/");
  const s2 = await browser.snapshot();
  assert.equal(s2.restricted, undefined);
  // about:blank is restricted too but flagged blank (no warning)
  const { browser: b2 } = await setup({ url: "about:blank" });
  const s3 = await b2.snapshot();
  assert.equal(s3.restricted, true);
  assert.equal(s3.blank, true);
});

test("execute: navigate waits for the load and returns the final URL", async () => {
  const { browser } = await setup();
  const t0 = Date.now();
  const r = await execute({ type: "navigate_url", url: "https://en.wikipedia.org/wiki/Main_Page", label: "wikipedia" }, browser);
  assert.equal(r.ok, true);
  assert.equal(r.detail, "https://en.wikipedia.org/wiki/Main_Page");
  assert.ok(Date.now() - t0 < 3000, "did not wait for the start timeout");
});

test("execute: click follows the link navigation; target=_blank links are opened by the worker", async () => {
  const { shim, tab, browser } = await setup();
  await browser.snapshot();
  const r = await execute({ type: "click_element", targetId: "e01", label: "more information" }, browser);
  assert.equal(r.ok, true);
  assert.equal(r.detail, "https://iana.org/domains/example");
  assert.deepEqual(shim.pages.get(tab.id).clicked, ["e01"]);
  assert.ok(shim.pages.get(tab.id).messages.some((m) => m.type === "vb:exec"));

  const { shim: s2, browser: b2 } = await setup({ elements: [rawEl("e01", { text: "Docs", href: "docs.example.com", target: "_blank" })] });
  const r2 = await execute({ type: "click_element", targetId: "e01", label: "docs" }, b2);
  assert.equal(r2.ok, true);
  assert.equal(s2.tabs.size, 2, "a new tab was created for the _blank link");
  assert.equal((await b2.activeTab()).url, "https://docs.example.com");
});

test("execute: type + submit navigates; scroll reports scrollY; select/press_enter go to the content script", async () => {
  const { shim, tab, browser } = await setup({
    url: "https://en.wikipedia.org/wiki/Main_Page",
    elements: [rawEl("e02", { tag: "input", role: "searchbox", text: "", placeholder: "Search Wikipedia", inputName: "search" })],
    submitUrl: "https://en.wikipedia.org/w/index.php?search=%s",
  });
  const r = await execute({ type: "type_into_field", targetId: "e02", text: "alan turing", submit: true, label: "search box" }, browser);
  assert.equal(r.ok, true);
  assert.equal(r.detail, "https://en.wikipedia.org/w/index.php?search=alan%20turing");
  assert.deepEqual(shim.pages.get(tab.id).typed, [{ id: "e02", text: "alan turing", submit: true }]);

  const s = await execute({ type: "scroll_down", amount: "page", label: "scroll" }, browser);
  assert.equal(s.detail, "scrollY=800");
  const s2 = await execute({ type: "scroll_down", amount: "end", label: "scroll" }, browser);
  assert.equal(s2.detail, "scrollY=4800");
  const s3 = await execute({ type: "scroll_up", amount: "little", label: "scroll" }, browser);
  assert.equal(s3.detail, "scrollY=4500");
  assert.equal((await execute({ type: "press_enter" }, browser)).ok, true);
});

test("execute: back / forward / reload use chrome.tabs history", async () => {
  const { browser } = await setup();
  await execute({ type: "navigate_url", url: "https://en.wikipedia.org/wiki/Main_Page" }, browser);
  const back = await execute({ type: "go_back" }, browser);
  assert.equal(back.ok, true);
  assert.equal(back.detail, "https://example.com/");
  const fwd = await execute({ type: "go_forward" }, browser);
  assert.equal(fwd.detail, "https://en.wikipedia.org/wiki/Main_Page");
  const again = await execute({ type: "go_forward" }, browser);
  assert.equal(again.ok, false, "no next page");
  assert.equal((await execute({ type: "reload" }, browser)).ok, true);
});

test("execute: open / close / switch tabs act on the controlled window", async () => {
  const { shim, tab, browser } = await setup();
  const open = await execute({ type: "open_new_tab" }, browser);
  assert.equal(open.detail, "tabs=2");
  assert.notEqual(browser.activeTabId, tab.id);
  const sw = await execute({ type: "switch_tab", direction: "next" }, browser);
  assert.equal(sw.ok, true);
  assert.equal(browser.activeTabId, tab.id);
  await execute({ type: "switch_tab", direction: "next" }, browser);
  const close = await execute({ type: "close_tab" }, browser);
  assert.equal(close.detail, "tabs=1");
  assert.equal(browser.activeTabId, tab.id);
  assert.equal(shim.tabs.size, 1);
  assert.equal((await execute({ type: "switch_tab" }, browser)).ok, false);
});

test("controller + adapter + executor: a click that navigates is recorded with its outcome", async () => {
  const { browser } = await setup();
  const c = new Controller({ browser, decideFn: mockDecide(), executeFn: execute });
  await c.start();
  c.handleCommand("click the more information link");
  await sleep(400);
  assert.equal(c.stats.actions, 1);
  const a = c.context.recentActions[0];
  assert.equal(a.type, "click_element");
  assert.equal(a.targetId, "e01");
  assert.equal(a.outcome, "navigated to iana.org/domains/example");
  assert.equal(c.context.previousPage.url, "https://example.com/");
  assert.equal(c.snapshot.url, "https://iana.org/domains/example");
  await c.close();
});

test("waitForNavigation resolves { navigated:false } quickly when nothing happens", async () => {
  const { tab, browser } = await setup();
  const t0 = Date.now();
  const r = await browser.waitForNavigation(tab.id, { startMs: 80 });
  assert.equal(r.navigated, false);
  assert.ok(Date.now() - t0 < 500);
});
