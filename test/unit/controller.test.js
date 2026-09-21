/**
 * Controller flow with a mocked Jev and a fake browser adapter: debounce, one action per
 * utterance, stale-request handling, candidate picking by number, chaining commands in one
 * breath, per-tab context recording. (Ported from voice-browser/test/unit/controller.test.js.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../../src/controller.js";
import { DEBOUNCE_MS } from "../../src/constants.js";
import { mockDecide } from "../helpers/mock-jev.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeBrowser() {
  return {
    url: "https://example.com/",
    activeKey: "tab-1",
    listeners: [],
    onChange(fn) {
      this.listeners.push(fn);
      return () => {};
    },
    contextKey() {
      return this.activeKey;
    },
    tabInfo() {
      return [{ index: 0, url: this.url, active: true }];
    },
    async currentUrl() {
      return this.url;
    },
    async snapshot() {
      return {
        url: this.url,
        title: "Example",
        site: "example_com",
        searchBoxId: null,
        elements: [
          { id: "e01", role: "link", text: "More information" },
          { id: "e02", role: "link", text: "Other link" },
        ],
        tabs: this.tabInfo(),
      };
    },
    overlayCalls: [],
    async overlay(fn, ...args) {
      this.overlayCalls.push([fn, ...args]);
    },
  };
}

function setup(opts = {}) {
  const browser = fakeBrowser();
  const executed = [];
  const decideFn = mockDecide(opts);
  const executeFn = async (action) => {
    executed.push(action);
    await sleep(opts.execMs ?? 10);
    if (action.type === "navigate_url") browser.url = action.url;
    if (action.type === "go_back") browser.url = "https://example.com/";
    return { ok: true, detail: action.type === "scroll_down" ? "scrollY=300" : browser.url };
  };
  const c = new Controller({ browser, decideFn, executeFn });
  return { c, browser, executed, decideFn };
}

test("debounces partials into one request and acts once per utterance", async () => {
  const { c, executed, decideFn } = setup();
  await c.start();
  c.handleTranscript({ text: "go", final: false, utteranceId: "u1" });
  await sleep(50);
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u1" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "go_back");
  assert.equal(decideFn.calls.length, 1, "first partial was debounced away");
  c.handleTranscript({ text: "go back please", final: true, utteranceId: "u1" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(executed.length, 1);
  assert.equal(c.uiState().stats.calls, 1);
  assert.ok(c.uiState().stats.costUsd > 0);
  await c.close();
});

test("waits on an incomplete partial, then acts when the recognizer marks it final", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleTranscript({ text: "scroll", final: false, utteranceId: "u2" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(executed.length, 0);
  assert.equal(c.lastDecision.policy.decision, "wait");
  c.handleTranscript({ text: "scroll", final: true, utteranceId: "u2" });
  await sleep(150);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].type, "scroll_down");
  await c.close();
});

test("cancels stale in-flight requests beyond MAX_INFLIGHT", async () => {
  const { c, executed, decideFn } = setup({ latency: 400 });
  await c.start();
  c.handleTranscript({ text: "go", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  c.handleTranscript({ text: "go ba", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u3" });
  await sleep(DEBOUNCE_MS + 20);
  assert.equal(c.inflight.length, 2, "oldest request aborted, two in flight");
  await sleep(600);
  assert.equal(executed.length, 1);
  assert.equal(decideFn.calls.length, 3);
  await c.close();
});

test("ambiguous target shows numbered candidates; a spoken number picks without a model call", async () => {
  const { c, executed, browser, decideFn } = setup();
  await c.start();
  c.handleTranscript({ text: "click ambiguous thing", final: true, utteranceId: "u4" });
  await sleep(150);
  assert.equal(executed.length, 0);
  assert.ok(c.candidates, "candidates pending");
  assert.deepEqual(
    c.candidates.list.map((x) => x.id),
    ["e02", "e01"],
  );
  assert.ok(browser.overlayCalls.some(([fn]) => fn === "candidates"));
  const callsBefore = decideFn.calls.length;
  c.handleTranscript({ text: "the second one", final: true, utteranceId: "u5" });
  await sleep(100);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].targetId, "e01");
  assert.equal(decideFn.calls.length, callsBefore, "no Jev call for the number");
  await c.close();
});

test("commands spoken in one breath: words after an executed command become a new command", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1);
  c.handleTranscript({ text: "go back scroll down", final: false, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 2);
  assert.equal(executed[1].type, "scroll_down");
  c.handleTranscript({ text: "go back scroll down please", final: true, utteranceId: "u6" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 2);
  await c.close();
});

test("a finished utterance that still waits / disambiguates is asked once, not in a loop", async () => {
  const { c, decideFn } = setup();
  await c.start();
  c.handleCommand("go to"); // final, but no destination → wait
  await sleep(150);
  assert.equal(c.lastDecision.policy.decision, "wait");
  const calls = decideFn.calls.length;
  await sleep(1200);
  assert.equal(decideFn.calls.length, calls, "no silence retries for a final utterance");
  // partial → wait → exactly one silence retry (bypasses `complete`), then stop
  c.handleTranscript({ text: "click ambiguous thing", final: false, utteranceId: "u9" });
  await sleep(DEBOUNCE_MS + 100);
  assert.equal(c.lastDecision.policy.decision, "disambiguate");
  const calls2 = decideFn.calls.length;
  await sleep(1400);
  assert.equal(decideFn.calls.length, calls2 + 1, "one retry after the silence window, then idle");
  await c.close();
});

test("typed command is treated as a final utterance", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleCommand("go back");
  await sleep(150);
  assert.equal(executed.length, 1);
  await c.close();
});

test("context: outcome derived from the URL change, kept per tab, and a correction reverses the last action", async () => {
  const { c, executed, browser, decideFn } = setup();
  await c.start();
  c.handleCommand("go to wikipedia");
  await sleep(150);
  assert.equal(executed[0].type, "navigate_url");
  const ctx = c.context;
  assert.equal(ctx.recentActions.length, 1);
  assert.match(ctx.recentActions[0].outcome, /^navigated to en\.wikipedia\.org/);
  assert.equal(ctx.previousPage.url, "https://example.com/");
  // the next request carries the context and asks is_correction
  c.handleCommand("scroll down a bit");
  await sleep(150);
  assert.ok(decideFn.calls.at(-1).context.recentActions.length >= 1);
  assert.equal(c.context.recentActions.at(-1).outcome, "scrollY=300");
  // a different tab has its own, empty context
  browser.activeKey = "tab-2";
  assert.equal(c.context.recentActions.length, 0);
  browser.activeKey = "tab-1";
  assert.equal(c.context.recentActions.length, 2);
  // "no not that one" → reverse the last action (scroll_down → scroll_up)
  c.handleCommand("no not that one");
  await sleep(150);
  assert.equal(executed.at(-1).type, "scroll_up");
  assert.equal(c.lastDecision.policy.decision, "act");
  assert.ok(c.lastDecision.policy.reasons.some((r) => r.name === "is_correction"));
  await c.close();
});

test("persistable()/restore() round-trip stats and per-tab contexts", async () => {
  const { c } = setup();
  await c.start();
  c.handleCommand("go to wikipedia");
  await sleep(150);
  const saved = JSON.parse(JSON.stringify(c.persistable()));
  const { c: c2 } = setup();
  c2.restore(saved);
  assert.equal(c2.stats.actions, 1);
  assert.equal(c2.stats.calls, 1);
  assert.equal(c2.contexts.get("tab-1").recentActions.length, 1);
  await c.close();
  await c2.close();
});

test("a tab switch invalidates the snapshot so the next decision re-scans", async () => {
  const { c, browser } = setup();
  await c.start();
  assert.ok(c.snapshotAt > 0);
  browser.listeners.forEach((fn) => fn({ activeChanged: true }));
  assert.equal(c.snapshotAt, 0);
  await c.close();
});
