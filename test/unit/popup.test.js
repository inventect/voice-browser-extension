/**
 * Pop-ups: ranking of modal / banner controls, the modal_open state Jev sees, and the
 * close_popup decision path (Jev pick vs. code-ranked dismiss control).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compactElements, findSearchBox } from "../../src/snapshot.js";
import { buildRequest, encodeElement } from "../../src/jev.js";
import { evaluatePolicy, pickDismissControl } from "../../src/policy.js";
import { MAX_ELEMENTS } from "../../src/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", `${name}.json`), "utf8"));

const raw = (i, over = {}) => ({ id: `e${String(i).padStart(2, "0")}`, tag: "a", role: "link", text: `Link ${i}`, placeholder: "", href: "", type: "", inputName: "", inViewport: true, top: i * 20, left: 0, ...over });

test("compactElements: pop-up controls rank first (modal before banner) and survive the cap", () => {
  const els = Array.from({ length: 300 }, (_, i) => raw(i + 1));
  els.push(raw(901, { role: "button", text: "Accept all cookies", popup: "banner", top: 880, inViewport: true }));
  els.push(raw(902, { role: "button", text: "Close", popup: "modal", top: 300 }));
  els.push(raw(903, { role: "button", text: "Not now", popup: "modal", top: 500, inViewport: false }));
  const out = compactElements(els);
  assert.equal(out.length, MAX_ELEMENTS);
  assert.deepEqual(
    out.slice(0, 3).map((e) => e.text),
    ["Close", "Not now", "Accept all cookies"],
  );
  assert.equal(out[0].popup, "modal");
  assert.equal(out[2].popup, "banner");
  assert.equal(out[1].below_fold, true, "flags are kept on popup elements too");
});

test("captured modal page: dialog controls (incl. the shadow-root button) come first; iframe element is tagged", () => {
  const snap = fixture("modal-page");
  assert.equal(snap.popup.kind, "modal");
  assert.match(snap.popup.text, /^Join our newsletter/);
  assert.deepEqual(
    snap.elements.slice(0, 5).map((e) => e.text),
    ["Close", "you@example.com", "Subscribe", "Not now", "Remind me later"],
  );
  assert.ok(snap.elements.slice(0, 5).every((e) => e.popup === "modal"));
  assert.equal(snap.searchBoxId, null, "an e-mail field in a newsletter dialog is not a search box");
  const banner = fixture("banner-page");
  assert.equal(banner.popup.kind, "banner");
  assert.deepEqual(banner.elements.slice(0, 2).map((e) => e.text), ["Accept all cookies", "Reject non-essential"]);
});

test("findSearchBox needs a real search signal", () => {
  assert.equal(findSearchBox([raw(1, { role: "textbox", tag: "input", placeholder: "you@example.com", inputName: "email" })]), null);
  assert.equal(findSearchBox([raw(2, { role: "textbox", tag: "input", placeholder: "Search Wikipedia", inputName: "search" })]), "e02");
});

test("buildRequest / encodeElement expose the pop-up to Jev", () => {
  const snap = fixture("modal-page");
  const { state } = buildRequest({ transcript: "close this", snapshot: snap });
  assert.equal(state.page.modal_open, true);
  assert.equal(state.page.modal_kind, "dialog");
  assert.match(state.page.modal_text, /Join our newsletter/);
  assert.ok(state.page.modal_text.length <= 120);
  assert.equal(state.elements[0], 'e01 button "Close" [popup]');
  assert.equal(encodeElement({ id: "e09", role: "button", text: "Frame action button", frame: 1 }), 'e09 button "Frame action button" [in frame]');
  const plain = buildRequest({ transcript: "scroll down", snapshot: fixture("example") });
  assert.equal(plain.state.page.modal_open, undefined);
});

test("pickDismissControl: the user's words choose the family, labels are matched in code", () => {
  const modal = fixture("modal-page");
  assert.equal(pickDismissControl(modal, "close this").text, "Close");
  assert.equal(pickDismissControl(modal, "not now").text, "Not now");
  assert.equal(pickDismissControl(modal, "no thanks").text, "Not now");
  assert.equal(pickDismissControl(modal, "dismiss the popup").text, "Close");
  const banner = fixture("banner-page");
  assert.equal(pickDismissControl(banner, "accept cookies").text, "Accept all cookies");
  assert.equal(pickDismissControl(banner, "reject cookies").text, "Reject non-essential");
  assert.equal(pickDismissControl(banner, "get rid of that").text, "Reject non-essential", "no family named → the least committing control");
  assert.equal(pickDismissControl(fixture("example"), "close this"), null);
});

const ch = (c, conf = 0.95, extra = {}) => ({ type: "choice", choice: c, confidence: conf, probabilities: { [c]: conf, ...extra } });
const base = (intent, target = ch("none", 0.9)) => ({
  intent,
  target,
  site: ch("none"),
  complete: { noul: 0.95 },
  is_command: { noul: 0.95 },
  destructive: { noul: 0.02 },
  scroll_amount: { score: 1, confidence: 0.9, probabilities: {} },
  tab_direction: ch("none"),
});
const cands = { text: [], url: [] };

test("policy close_popup: Jev's confident in-popup target wins; otherwise the code-ranked control; no pop-up → wait", () => {
  const modal = fixture("modal-page");
  const viaTarget = evaluatePolicy({ answers: base(ch("close_popup"), ch("e04", 0.9)), candidates: cands, snapshot: modal, isFinal: true, transcript: "not now" });
  assert.equal(viaTarget.decision, "act");
  assert.equal(viaTarget.action.type, "click_element");
  assert.equal(viaTarget.action.targetId, "e04");
  assert.equal(viaTarget.action.via, "close_popup");

  const viaCode = evaluatePolicy({ answers: base(ch("close_popup")), candidates: cands, snapshot: modal, isFinal: true, transcript: "close this" });
  assert.equal(viaCode.decision, "act");
  assert.equal(viaCode.action.targetId, "e01");
  assert.ok(viaCode.reasons.some((r) => r.name === "popup" && r.pass));

  // a target outside the pop-up is not trusted for "close this": code picks inside the pop-up
  const outside = evaluatePolicy({ answers: base(ch("close_popup"), ch("e40", 0.9)), candidates: cands, snapshot: modal, isFinal: true, transcript: "close this" });
  assert.equal(outside.action.targetId, "e01");

  const none = evaluatePolicy({ answers: base(ch("close_popup")), candidates: cands, snapshot: fixture("example"), isFinal: true, transcript: "close this" });
  assert.equal(none.decision, "wait");
  assert.match(none.summary, /no pop-up/);
});

test("policy: 'accept cookies' as click_element still resolves to the banner button by target", () => {
  const banner = fixture("banner-page");
  const r = evaluatePolicy({ answers: base(ch("click_element"), ch("e01", 0.9)), candidates: cands, snapshot: banner, isFinal: true, transcript: "click accept all cookies" });
  assert.equal(r.decision, "act");
  assert.equal(r.action.label, 'button "Accept all cookies"');
});
