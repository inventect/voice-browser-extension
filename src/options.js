/**
 * Options page: API key (chrome.storage.local via the service worker), model pin, read-only
 * thresholds and question texts (bundled from constants.js), connection test, mic permission help.
 */
import { MODEL, PRICE_PER_M_INPUT_TOKENS_USD, T, QUESTIONS } from "./constants.js";
import { MSG } from "./protocol.js";

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ask = (msg) => chrome.runtime.sendMessage(msg);

  $("model").textContent = MODEL;
  $("model2").textContent = MODEL;
  $("price").textContent = `$${PRICE_PER_M_INPUT_TOKENS_USD} per 1M input tokens (output free) — a whole session is about a cent`;
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
      el.innerHTML = `key <b>${esc(s.masked)}</b>`;
    } else {
      el.className = "pill warn";
      el.innerHTML = "key: <b>missing</b>";
    }
  }
  ask({ type: MSG.API_KEY_STATUS }).then(renderStatus).catch(() => {});

  $("keyform").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const apiKey = $("apikey").value.trim();
    if (!apiKey) return;
    const s = await ask({ type: MSG.SET_API_KEY, apiKey });
    renderStatus(s);
    $("apikey").value = "";
    $("savemsg").textContent = "saved. Click “Test connection” to verify.";
  });
  $("clear").onclick = async () => {
    const s = await ask({ type: MSG.SET_API_KEY, apiKey: "" });
    renderStatus(s);
    $("savemsg").textContent = "key removed.";
  };
  $("toggle").onclick = () => {
    const i = $("apikey");
    i.type = i.type === "password" ? "text" : "password";
  };
  $("test").onclick = async () => {
    $("testresult").textContent = "testing…";
    const typed = $("apikey").value.trim();
    const r = await ask({ type: MSG.TEST_CONNECTION, ...(typed ? { apiKey: typed } : {}) });
    $("testresult").textContent = r?.ok
      ? `✓ ${r.model} answered in ${r.latencyMs} ms (${r.inputTokens} input tokens, is_command=${(r.noul ?? 0).toFixed(2)})${typed ? " — key not saved yet, click Save" : ""}`
      : `✗ ${r?.error || "failed"}`;
  };

  // ---- microphone
  async function micState() {
    try {
      const st = await navigator.permissions.query({ name: "microphone" });
      return st.state;
    } catch {
      return "unknown";
    }
  }
  micState().then((s) => ($("micstate").textContent = s));
  $("grantmic").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
  $("micsettings").onclick = () => chrome.tabs.create({ url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(`chrome-extension://${chrome.runtime.id}`)}` });
})();
