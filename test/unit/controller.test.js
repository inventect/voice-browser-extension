/**
 * Controller flow with a mocked Jev and a fake browser adapter: debounce, one action per
 * utterance, stale-request handling, candidate picking by number, chaining commands in one
 * breath, per-tab context recording. (Ported from voice-browser/test/unit/controller.test.js.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Controller, conjunctionCut } from "../../src/controller.js";
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

test("dedupe: the phrase just acted on re-delivered under a NEW utterance id within 2.5 s is consumed, not re-run", async () => {
  const { c, executed, decideFn } = setup();
  await c.start();
  // realistic Web Speech sequence: interim "go", interim "go back", final "go back" (same id)...
  c.handleTranscript({ text: "go", final: false, utteranceId: "u0-3" });
  await sleep(30);
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u0-3" });
  await sleep(DEBOUNCE_MS + 120);
  assert.equal(executed.length, 1);
  c.handleTranscript({ text: "go back", final: true, utteranceId: "u0-3" });
  // ...then the recognizer re-indexes / restarts and delivers the same phrase again as a new utterance
  c.handleTranscript({ text: "Go back.", final: true, utteranceId: "u0-4" });
  await sleep(150);
  c.handleTranscript({ text: "go back", final: false, utteranceId: "u1-0" });
  await sleep(DEBOUNCE_MS + 150);
  assert.equal(executed.length, 1, "exactly one history step");
  const calls = decideFn.calls.length;
  // one extra trailing word is still the same utterance
  c.handleTranscript({ text: "go back please", final: true, utteranceId: "u1-1" });
  await sleep(150);
  assert.equal(executed.length, 1);
  assert.equal(decideFn.calls.length, calls, "no Jev call for duplicates");
  // two or more new words after the acted phrase are a fresh command
  c.handleTranscript({ text: "go back scroll down", final: true, utteranceId: "u1-2" });
  await sleep(150);
  assert.equal(executed.length, 2);
  assert.equal(executed[1].type, "scroll_down");
  await c.close();
});

test("dedupe: an identical closed-set action within 1.5 s is ignored unless the user says 'again'", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleCommand("scroll down a bit");
  await sleep(150);
  assert.equal(executed.length, 1);
  c.handleCommand("scroll down a bit "); // different utterance id (typed), same text: caught by the transcript guard
  await sleep(150);
  assert.equal(executed.length, 1);
  c.handleCommand("scroll down a little bit"); // different words, same action → repeat guard
  await sleep(150);
  assert.equal(executed.length, 1);
  assert.equal(c.lastDecision.policy.decision, "ignore");
  assert.ok(c.lastDecision.policy.reasons.some((r) => r.name === "repeat"));
  c.handleCommand("scroll down a bit again");
  await sleep(150);
  assert.equal(executed.length, 2, '"again" repeats');
  // a different amount is a different action
  c.handleCommand("scroll down to the bottom");
  await sleep(150);
  assert.equal(executed.length, 3);
  await c.close();
});

test("dedupe: after the windows have passed the same phrase acts again", async () => {
  const { c, executed } = setup();
  await c.start();
  c.handleCommand("go back");
  await sleep(150);
  assert.equal(executed.length, 1);
  // simulate time passing beyond both windows
  c.lastActed.at -= 3000;
  c.history[c.history.length - 1].at -= 3000;
  c.handleCommand("go back");
  await sleep(150);
  assert.equal(executed.length, 2);
  await c.close();
});

test("chaining is robust to latency: a decision on 'X and Y' consumes only X, Y runs next (never for free-text payloads)", async () => {
  assert.equal(conjunctionCut("go to example dot com and click the more", { type: "navigate_url", url: "https://example.com" }), "go to example dot com");
  assert.equal(conjunctionCut("go to example dot com and click", { type: "navigate_url" }), "go to example dot com and click", "a one-word tail is not a command");
  assert.equal(conjunctionCut("search for cats and dogs", { type: "navigate_url", query: "cats and dogs" }), "search for cats and dogs");
  assert.equal(conjunctionCut("type salt and pepper into the box", { type: "type_into_field", text: "salt and pepper" }), "type salt and pepper into the box");
  assert.equal(conjunctionCut("scroll down then go back", { type: "scroll_down" }), "scroll down");

  const { c, executed } = setup();
  await c.start();
  // the whole breath arrives at once (earlier partials were cancelled)
  c.handleTranscript({ text: "go to wikipedia and scroll down a bit", final: true, utteranceId: "u8" });
  await sleep(400);
  assert.deepEqual(
    executed.map((a) => a.type),
    ["navigate_url", "scroll_down"],
  );
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
