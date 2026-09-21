/**
 * jev.js HTTP layer with a mocked fetch: request shape, retry, abort, key handling, cost.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { configureJev, systemOne, decide, isAbortError, costUsd, API_URL, buildRequest } from "../../src/jev.js";
import { MODEL } from "../../src/constants.js";

const ok = (answers, tokens = 1000) =>
  new Response(JSON.stringify({ model: MODEL, answers, usage: { input_tokens: tokens, output_tokens: 5 } }), { status: 200, headers: { "x-typesafe-request-id": "req-1" } });

afterEach(() => configureJev({ getApiKey: async () => "", fetch: (...a) => globalThis.fetch(...a) }));

test("systemOne posts {state, model, questions} with a Bearer header and returns data + requestId", async () => {
  const seen = [];
  configureJev({
    getApiKey: async () => "ts-key",
    fetch: async (url, init) => {
      seen.push({ url, init });
      return ok({ q: { type: "noul", noul: 0.9 } });
    },
  });
  const r = await systemOne({ state: { a: 1 }, questions: { q: { type: "noul", instructions: "x" } } });
  assert.equal(seen[0].url, API_URL);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers.Authorization, "Bearer ts-key");
  assert.deepEqual(JSON.parse(seen[0].init.body), { state: { a: 1 }, model: MODEL, questions: { q: { type: "noul", instructions: "x" } } });
  assert.equal(r.requestId, "req-1");
  assert.equal(r.data.answers.q.noul, 0.9);
  assert.ok(r.latencyMs >= 0);
});

test("missing key → error with code no_api_key, no network call", async () => {
  let called = 0;
  configureJev({ getApiKey: async () => "", fetch: async () => (called++, ok({})) });
  await assert.rejects(systemOne({ state: "x", questions: { q: { type: "noul", instructions: "x" } } }), (e) => e.code === "no_api_key" && e.status === 401);
  assert.equal(called, 0);
});

test("retries once on 5xx / 429, then throws JevApiError with the status", async () => {
  let n = 0;
  configureJev({ getApiKey: async () => "k", fetch: async () => (n++ === 0 ? new Response("overloaded", { status: 529 }) : ok({ q: { noul: 1 } })) });
  const r = await systemOne({ state: "x", questions: { q: { type: "noul", instructions: "x" } } });
  assert.equal(n, 2);
  assert.equal(r.data.answers.q.noul, 1);

  n = 0;
  configureJev({ getApiKey: async () => "k", fetch: async () => (n++, new Response("nope", { status: 401 })) });
  await assert.rejects(systemOne({ state: "x", questions: { q: { type: "noul", instructions: "x" } } }), (e) => e.name === "JevApiError" && e.status === 401 && /rejected/.test(e.message));
  assert.equal(n, 1, "401 is not retried");
});

test("abort signal cancels the request and is recognised by isAbortError", async () => {
  configureJev({
    getApiKey: async () => "k",
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init.signal.aborted) return reject(init.signal.reason);
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
  });
  // abort before the request leaves
  const ac = new AbortController();
  const p = systemOne({ state: "x", questions: { q: { type: "noul", instructions: "x" } } }, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => isAbortError(e));
  // abort while in flight
  const ac2 = new AbortController();
  const p2 = systemOne({ state: "x", questions: { q: { type: "noul", instructions: "x" } } }, { signal: ac2.signal });
  await new Promise((r) => setTimeout(r, 10));
  ac2.abort();
  await assert.rejects(p2, (e) => isAbortError(e));
});

test("decide: builds the request, returns answers + cost; questions carry the pinned model", async () => {
  let body;
  configureJev({
    getApiKey: async () => "k",
    fetch: async (_u, init) => {
      body = JSON.parse(init.body);
      return ok({ intent: { type: "choice", choice: "scroll_down", confidence: 0.9, probabilities: { scroll_down: 0.9 } } }, 2000);
    },
  });
  const snapshot = { url: "https://example.com/", title: "Example", site: "example_com", elements: [{ id: "e01", role: "link", text: "More information", href: "iana.org/domains/example" }] };
  const r = await decide({ transcript: "scroll down", snapshot });
  assert.equal(body.model, MODEL);
  assert.equal(body.state.transcript, "scroll down");
  assert.deepEqual(body.state.elements, ['e01 link "More information" → iana.org']);
  assert.deepEqual(Object.keys(body.questions).sort(), Object.keys(buildRequest({ transcript: "scroll down", snapshot }).questions).sort());
  assert.equal(r.answers.intent.choice, "scroll_down");
  assert.equal(r.costUsd, costUsd({ input_tokens: 2000 }));
  assert.ok(Math.abs(r.costUsd - 0.000084) < 1e-9);
  assert.equal(r.questionCount, 9); // 8 base + text_span ("scroll down" yields text candidates)
});
