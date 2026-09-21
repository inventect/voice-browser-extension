# voice-browser-extension — control *your own* Chrome by voice

A Manifest V3 Chrome extension port of [voice-browser](../voice-browser/). Open the side panel,
press **Start mic**, and talk: "go to wikipedia", "search for alan turing", "click the first
result", "scroll down a bit", "go back", "no, not that one". Speech streams word by word from the
side panel to the extension's service worker; on every partial transcript the worker asks **Jev**
(TypeSafe's System One model, pinned `jev-1.13.0`) one request with ~11 typed questions — intent,
target element, site, "is the command finished?", "is this even for me?", "is it destructive?" — gets
typed probabilities back in ~300 ms, and code decides whether to act, wait, ask, or ignore. Then the
extension acts on the tab you are looking at.

Jev never generates text. Search queries, typed text and URLs are extracted as candidate spans by
code and Jev only *picks* one, which is copied verbatim.

```
 side panel (chrome.sidePanel)          service worker (owns the API key)             the active tab
 ────────────────────────────   port    ────────────────────────────────────  tabs.sendMessage  ────────────────
 mic → Web Speech API  ────────────────▶ debounce 200 ms, ≤2 in flight, abort stale   content script:
 "go to"  "go to wiki"                  snapshot (≤100 elements, e01..eNN) ◀────────── collect elements,
 "go to wikipedia" (final)              ONE Jev request, 9–11 questions               click / type / scroll,
 typed command fallback                 policy (thresholds in constants.js) ─────────▶ highlight / toast /
 gate table, bars, log, cost ◀────────── decision + probabilities + latency            numbered badges
                                        chrome.tabs: navigate, back, reload, tabs
```

## Install (load unpacked)

Requirements: Chrome ≥ 116 (side panel + `AbortSignal.any`), Node ≥ 20 for building/testing, a
TypeSafe API key ([console.typesafe.ai/keys](https://console.typesafe.ai/keys)). Real API calls
cost ~$0.0002 each; a whole session is about a cent.

```bash
cd voice-browser-extension
npm install
npm run build            # esbuild → dist/  (dist/ is gitignored; rebuild after edits, or `npm run watch`)
```

1. Open `chrome://extensions`, enable **Developer mode** (top right), click **Load unpacked** and
   choose the `dist/` folder.
2. Click the extension's **Details → Extension options** (or the *options* link in the side panel),
   paste your TypeSafe API key, **Save**, then **Test connection** — you should see
   `✓ jev-1.13.0 answered in ~300 ms`.
3. Pin the extension (puzzle-piece menu) and click its toolbar icon: the **side panel** opens.
   It stays open while you browse and switch tabs; it controls the active tab of its window.

## Microphone: what actually works in current Chrome

Chrome cannot show a permission prompt inside a side panel (or a popup): `getUserMedia` fails there
with `NotAllowedError: Permission dismissed` even while the permission state is still `prompt`.
The permission is granted per *origin*, and the extension's origin is `chrome-extension://<id>`,
so the standard pattern — implemented in `src/sidepanel.js` + `src/permission.html` — is:

1. **Start mic** checks `navigator.permissions.query({name: "microphone"})`.
2. If it is not `granted`, the panel tries `getUserMedia` once (some Chrome builds do prompt), and on
   failure opens `permission.html` **in a normal tab**, where Chrome does show the prompt.
3. Choose **Allow** (not "Allow this time"). The tab closes itself; the side panel polls the
   permission state and starts listening automatically. The grant is remembered for the extension.
4. If you had blocked it earlier (`denied`), the page offers a button to
   `chrome://settings/content/siteDetails?site=chrome-extension://<id>` — set **Microphone → Allow**.

Verified: the e2e test opens `permission.html` in Chromium with a fake media device and confirms
`getUserMedia` resolves in the extension page and the tab closes itself; the side panel page reports
`webkitSpeechRecognition` available. The actual prompt UI can only be exercised by hand (below).

### Manual smoke test (the part that cannot be automated)

1. `npm run build`, load `dist/` unpacked, paste the key in options, **Test connection**.
2. Open any normal page (e.g. `https://example.com`), click the toolbar icon → side panel opens.
3. Press **Start mic** → a `permission.html` tab opens → **Allow** → tab closes → red dot pulses,
   status "listening".
4. Say **"go to wikipedia"**. The tab navigates as the word "wikipedia" lands; the header pills show
   the Jev latency (~300 ms) and cost. Then try "search for alan turing", "scroll down a bit",
   "go back", "click the first result", "no, not that one".
5. No microphone? Type a command in the text box and press Enter.

## What you can say

| Say | What happens |
| --- | --- |
| "go to wikipedia" / "open youtube" / "go to example dot com" | navigates the active tab (site list or spoken domain; code owns the URLs) |
| "search for alan turing" | uses the page's own search box if it has one (Wikipedia, YouTube…), else DuckDuckGo |
| "search youtube for lofi beats" | site-specific search URL template |
| "click the first result" / "click the new link" / "open the comments tab" | clicks the element Jev picked from the snapshot; ambiguous → numbered blue badges in the page, say "two" |
| "type hello world into the search box" | types verbatim (Jev picked the span, code copies it) |
| "scroll down a bit" / "scroll to the bottom" / "scroll up a page" | scroll with amount from a 3-level Score |
| "go back" / "go forward" / "reload" | history |
| "open a new tab" / "close this tab" / "next tab" | tabs (in the side panel's window) |
| "no, not that one" / "undo that" / "wrong link" | correction: reverses the last action (click/navigate → back, typing → clear, scroll → opposite) |
| "no, the other one" | correction with a new target: the element just clicked is excluded |
| "click place order" | destructive → toast asks you to say **"confirm"** (or "cancel") |
| "so anyway I think we should get lunch" | ignored (`is_command` ≈ 0.02) |

Two commands in one breath work too: "go to example dot com and click the more information link".

## How a decision is made

Identical to voice-browser (see its README for the full table): one Jev request per transcript
update with state `{transcript, page, elements, context{previous_page, recent_actions}}` and the
questions `intent · target · site · complete · is_command · destructive · scroll_amount ·
tab_direction` (+ `text_span` / `url_span` when the transcript has candidates, + `is_correction`
when there is history). Policy gates (`T` in `src/constants.js`) are shown live in the side panel's
gate table. `context` is **per tab**: the page you came from and the last 3 executed actions with
their outcome (derived from the tab's URL before/after the action).

## Architecture — what runs where

| File | Runs in | Role |
| --- | --- | --- |
| `src/constants.js` | everywhere (bundled) | model pin, thresholds `T`, every question text, site templates — the one file to review |
| `src/policy.js`, `src/spans.js` | service worker | pure decision code + candidate extraction (verbatim from voice-browser) |
| `src/jev.js` | service worker (also Node tests) | `buildRequest` / `encodeContext` verbatim; `decide` now a plain `fetch` to `api.typesafe.ai` with `AbortController`, timeout, one retry |
| `src/controller.js` | service worker | debounce, ≤2 in-flight + abort, one action per utterance, chaining, silence retry, candidate pick, confirm/cancel, per-tab context, stats; `persistable()/restore()` for `chrome.storage.session` |
| `src/chrome-browser.js` | service worker | adapter over `chrome.tabs`/`chrome.scripting`: which tab to control, snapshot via content script (inject on demand), navigation outcome detection, `history.go` |
| `src/executor.js` | service worker | actions → content script (click/type/select/scroll/enter) or `chrome.tabs` (navigate/back/forward/reload/tabs) |
| `src/app.js`, `src/background.js` | service worker | wiring + the message protocol (`src/protocol.js`); `background.js` only registers listeners |
| `src/content.js` | every page (`<all_urls>`, isolated world) | `snapshot.js` element collector, DOM actions, `overlay.js` highlight/toast/badges; answers `vb:*` messages only |
| `src/sidepanel.html/js` | side panel | mic (Web Speech API), transcript, gate table, bars, log, stats, typed fallback |
| `src/options.html/js` | options tab | API key → `chrome.storage.local`, model pin, read-only thresholds/questions, connection test, mic help |
| `src/permission.html/js` | a tab | one-time microphone prompt for the extension origin |

Content script delivery: declared in the manifest for `<all_urls>` at `document_idle` **and**
injected on demand with `chrome.scripting.executeScript` when a tab predates the extension load
(the script is idempotent). Declared injection means there is no race after a navigation — the
script is already there when the page finishes loading; the on-demand path covers tabs that were
open before you clicked "Load unpacked" / reloaded the extension.

Service-worker lifetime: the side panel holds a port and pings every 20 s while open, which keeps
the worker warm; stats and per-tab context are additionally persisted to `chrome.storage.session`
after every decision/action and restored when the worker restarts.

## Permissions and why

| Permission | Why |
| --- | --- |
| `sidePanel` | the UI lives in the side panel and persists across tabs |
| `storage` | API key in `chrome.storage.local` (this device only); stats/context in `chrome.storage.session` |
| `tabs` | read the active tab's URL/title, navigate it, back/forward/reload, open/close/switch tabs |
| `scripting` + host permission `<all_urls>` | read the clickable elements of the page you are looking at and click/type/scroll in it. Voice control has to work on whatever site you are on, so it cannot be limited to a fixed host list. |
| `activeTab` | the extension only ever acts on the active tab |
| `webNavigation` | detect that an action led to a navigation (the `outcome` in Jev's context) |

Safety: destructive clicks (buy, delete, send, post, log out) need a spoken "confirm"; the extension
acts only on the active tab; the API key is read only by the service worker and sent only to
`api.typesafe.ai` as a `Bearer` header — never to pages, content scripts or the side panel (the UI
sees a masked status only); no remote code; no analytics. Treat "confirm" as a convenience, not a
guarantee — do not run this in a profile logged into anything a mis-heard "click place order"
could hurt.

## Tests

```bash
export TYPESAFE_API_KEY=…       # real-API tests only; the extension itself takes the key from the options page
npm test                        # 72 unit tests, no network: spans, policy, snapshot, context (reused) + jev fetch layer,
                                #   controller, Chrome adapter/executor and the message protocol against a chrome shim
npm run test:integration        # 34 real-API decision cases on captured page fixtures — expects ≥ 90% (measured 100%)
npm run test:e2e                # builds dist/, loads it into headless Chromium (Playwright, channel "chromium"),
                                #   drives 17 steps word by word on wikipedia / example.com / HN / DuckDuckGo
npm run test:e2e:headed         # same, watch it happen
node test/e2e/extension.e2e.mjs --debug --word-ms 300   # print the worker log per step
```

Latest measured (Sep 2026, this machine): unit 72/72 · integration 34/34 (100%, latency avg ≈ 390 ms
incl. first-call TLS, p50 ≈ 340 ms) · e2e 17/17 in two consecutive headless runs, Jev latency avg
≈ 330–366 ms (p50 ≈ 320 ms), last word→decision ≈ 300–350 ms incl. the 200 ms debounce, whole run
≈ $0.015 and ~70 Jev calls. The e2e also verifies the mic-permission page (`getUserMedia` in an
extension tab) and the side panel's typed-command path.

## Limitations

- **Chrome only** (side panel, `chrome.*` APIs, Web Speech API). The Web Speech API sends audio to
  Google; interim results arrive in bursts, so "acting before you finish" shows most on long phrases.
- **Pages the extension cannot see into**: `chrome://` pages, the Chrome Web Store, the built-in
  PDF viewer, other extensions' pages. The side panel says "can't control this page"; navigation,
  back/forward, reload and tab commands still work there. Elements inside **iframes** are invisible.
- Snapshot capped at 100 elements (viewport first), 60 chars each — deep pages need a scroll before
  "click …" finds below-fold items. Sites with heavy bot protection may not render for the e2e.
- Clicks are synthesized events from the content script; links with `target=_blank` are opened by
  the worker instead (a scripted click would hit the popup blocker). Sites that require a trusted
  user gesture for an action (e.g. some video autoplay) will ignore it.
- Back/forward use an in-page `history.go()`; `chrome.tabs.goBack` alone refuses entries that were
  created without a user gesture — which is every navigation this extension makes.
- One action per utterance; extra words after an executed command become a new command only if
  there are at least two of them. Chaining depends on the first command being decided while you are
  still talking (Jev ≈ 300 ms + 200 ms debounce), which is the normal case but not guaranteed.
- Confidence gates are calibrated on `jev-1.13.0`; re-check `T` if you move the model.

## Layout

```
manifest.json           MV3 manifest (copied into dist/)
scripts/build.mjs       esbuild bundles + static copy + generated icons → dist/
src/                    see the architecture table above
test/unit/              spans, policy, snapshot, context (reused) · jev, controller, chrome-adapter, app (new)
test/helpers/           chrome-shim.js (in-memory chrome.* + fake content script), mock-jev.js
test/integration/       34 real-API cases on fixtures (reused), prints pass rate + latency
test/e2e/               Playwright: load dist/ into Chromium, replay 17 spoken commands, assert outcomes
test/fixtures/          captured page snapshots (reused)
DEMO.md                 3–5 minute demo script
```
