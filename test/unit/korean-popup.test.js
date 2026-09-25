// Local addition (not upstream): Korean pop-up dismissal ranking, done in code (no Jev).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickDismissControl } from "../../src/policy.js";

const modal = (buttons) => ({
  popup: { kind: "modal" },
  elements: buttons.map((text, i) => ({ id: `e0${i + 1}`, role: "button", text, popup: "modal" })),
});

test("ko popup: '닫아 줘' picks the 닫기 button", () => {
  const snap = modal(["오늘 하루 보지 않기", "닫기", "자세히 보기"]);
  assert.equal(pickDismissControl(snap, "팝업 닫아 줘")?.text, "닫기");
});

test("ko popup: '나중에 할게' / '괜찮아' pick the reject-style button", () => {
  const snap = modal(["동의하고 계속", "나중에"]);
  assert.equal(pickDismissControl(snap, "나중에 할게")?.text, "나중에");
  assert.equal(pickDismissControl(snap, "괜찮아 안 할래")?.text, "나중에");
});

test("ko popup: '동의해 줘' picks the accept button", () => {
  const snap = modal(["모두 동의", "거부"]);
  assert.equal(pickDismissControl(snap, "쿠키 동의해 줘")?.text, "모두 동의");
  assert.equal(pickDismissControl(snap, "쿠키 거부해 줘")?.text, "거부");
});

test("ko popup: '오늘 하루 보지 않기' counts as a dismiss control", () => {
  const snap = modal(["이벤트 참여하기", "오늘 하루 보지 않기"]);
  assert.equal(pickDismissControl(snap, "이거 꺼 줘")?.text, "오늘 하루 보지 않기");
});

test("English pop-up ranking unchanged", () => {
  const snap = modal(["Subscribe", "Not now", "Close"]);
  assert.equal(pickDismissControl(snap, "close this")?.text, "Close");
  assert.equal(pickDismissControl(snap, "not now")?.text, "Not now");
});
