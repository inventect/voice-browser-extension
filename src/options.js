/**
 * Settings page: API key (chrome.storage.local via the service worker), connection test, mic
 * permission help, and a read-only advanced section (model pin, thresholds, questions).
 */
import { MODEL, PRICE_PER_M_INPUT_TOKENS_USD, T, QUESTIONS } from "./constants.js";
import { MSG } from "./protocol.js";

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ask = (msg) => chrome.runtime.sendMessage(msg);

  $("model").textContent = MODEL;
  $("price").textContent = `$${PRICE_PER_M_INPUT_TOKENS_USD} per 1M input tokens, output free — a session is about a cent`;
  $("qcount").textContent = `${Object.keys(QUESTIONS).length} question types (text_span / url_span / is_correction only when relevant)`;
  $("thresholds").querySelector("tbody").innerHTML = Object.entries(T)
    .map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join("");
  $("questions").querySelector("tbody").innerHTML = Object.entries(QUESTIONS)
    .map(([k, q]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(q.instructions?.question || q.instructions || "")}</td></tr>`)
    .join("");

  function renderStatus(s) {
    const el = $("keystatus");
    if (s?.hasKey) {
      el.className = "pill ok";
      $("keystatustext").textContent = `key saved · ${s.masked}`;
    } else {
      el.className = "pill warn";
      $("keystatustext").textContent = "no key yet";
    }
  }
  ask({ type: MSG.API_KEY_STATUS }).then(renderStatus).catch(() => {});

  $("keyform").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const apiKey = $("apikey").value.trim();
    if (!apiKey) return;
    renderStatus(await ask({ type: MSG.SET_API_KEY, apiKey }));
    $("apikey").value = "";
    $("savemsg").textContent = "Saved. Click “Test connection” to verify it works.";
  });
  $("clear").onclick = async () => {
    renderStatus(await ask({ type: MSG.SET_API_KEY, apiKey: "" }));
    $("savemsg").textContent = "Key removed.";
  };
  $("toggle").onclick = () => {
    const i = $("apikey");
    i.type = i.type === "password" ? "text" : "password";
  };
  $("test").onclick = async () => {
    const out = $("testresult");
    out.className = "result";
    out.textContent = "testing…";
    const typed = $("apikey").value.trim();
    const r = await ask({ type: MSG.TEST_CONNECTION, ...(typed ? { apiKey: typed } : {}) });
    out.className = `result ${r?.ok ? "ok" : "err"}`;
    out.textContent = r?.ok ? `✓ ${r.model} answered in ${r.latencyMs} ms${typed ? " — key not saved yet, click Save" : ""}` : `✗ ${r?.error || "failed"}`;
  };

  // ---- microphone
  async function micState() {
    try {
      return (await navigator.permissions.query({ name: "microphone" })).state;
    } catch {
      return "unknown";
    }
  }
  micState().then((s) => ($("micstate").textContent = s === "granted" ? "allowed" : s === "denied" ? "blocked — use Chrome site settings" : "not asked yet"));
  $("grantmic").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
  $("micsettings").onclick = () => chrome.tabs.create({ url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(`chrome-extension://${chrome.runtime.id}`)}` });
})();
