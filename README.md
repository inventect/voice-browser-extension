# Voice Browser — control *your own* Chrome by voice

A Manifest V3 Chrome extension port of [voice-browser](../voice-browser/). Open the side panel, tap
the mic, and talk: "go to wikipedia", "search for alan turing", "click the first result", "scroll
down a bit", "go back", "no, not that one", "close this" (when a pop-up is in the way). Speech
streams word by word from the side panel to the extension's service worker; on every partial
transcript the worker asks **Jev** (TypeSafe's System One model, pinned `jev-1.13.0`) one request
with ~12 typed questions — intent, target element, site, "is the command finished?", "is this even
for me?", "is it destructive?", "is this a correction?" — gets typed probabilities back in ~300 ms,
and code decides whether to act, wait, ask, or ignore. Then the extension acts on the tab you are
looking at.

Jev never generates text. Search queries, typed text and URLs are extracted as candidate spans by
code and Jev only *picks* one, which is copied verbatim.

```
 side panel (chrome.sidePanel)          service worker (owns the API key)             the active tab
 ────────────────────────────   port    ────────────────────────────────────  tabs.sendMessage  ────────────────
 mic → Web Speech API  ────────────────▶ debounce 200 ms, ≤2 in flight, abort stale   content script:
 "go to"  "go to wiki"                  snapshot (≤100 elements, pop-up first) ◀───── collect elements (DOM,
 "go to wikipedia" (final)              ONE Jev request, 9–12 questions               shadow roots, same-origin
 typed command fallback                 policy (thresholds in constants.js) ─────────▶ iframes), click / type /
 conversation, status, Details ◀──────── decision + probabilities + latency            scroll, highlight / toast /
                                        chrome.tabs: navigate, back, reload, tabs      numbered badges
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
2. Click the extension's **Details → Extension options** (or the gear in the side panel), paste
   your TypeSafe API key, **Save**, then **Test connection** — you should see
   `✓ jev-1.13.0 answered in ~300 ms`.
3. Pin the extension (puzzle-piece menu) and click its toolbar icon: the **side panel** opens.
   It stays open while you browse and switch tabs; it controls the active tab of its window.

## The side panel

The default view is for using it, not debugging it: a large mic button (pulsing ring while
listening), a plain-language status line ("Listening…", "Heard: “go to wikipedia”", "Did: Opened
en.wikipedia.org"), your words as chat bubbles and what the extension did as cards, suggestion chips
on first run, and a typed-command box. When something needs you it shows up as a card: "Which one?"
with numbered buttons, "Are you sure?" with Confirm / Cancel, "A pop-up is covering the page — say
close this", "Add your TypeSafe API key" with an *Open settings* button, "Microphone is blocked" with
a button to Chrome's site settings. Light and dark follow the OS.

Everything for developers lives under **Details** (collapsed): the page snapshot, the last
decision's gate table and probability bars, the element list sent to Jev, request latency / tokens /
cost / request id, the raw Web Speech events, and the worker log.

Screenshots (headless Chromium, `npm run ui:shots`): `reports/ui/`.

## Microphone: what actually works in current Chrome

Chrome cannot show a permission prompt inside a side panel (or a popup): `getUserMedia` fails there
with `NotAllowedError: Permission dismissed` even while the permission state is still `prompt`.
The permission is granted per *origin*, and the extension's origin is `chrome-extension://<id>`,
so the standard pattern — implemented in `src/sidepanel.js` + `src/permission.html` — is:

1. Tapping the mic checks `navigator.permissions.query({name: "microphone"})`.
2. If it is not `granted`, the panel tries `getUserMedia` once (some Chrome builds do prompt), and on
   failure opens `permission.html` **in a normal tab**, where Chrome does show the prompt.
3. Choose **Allow** (not "Allow this time"). The tab closes itself; the side panel polls the
   permission state and starts listening automatically. The grant is remembered for the extension.
4. If you had blocked it earlier (`denied`), the panel shows a "Microphone is blocked" card with a
   button to `chrome://settings/content/siteDetails?site=chrome-extension://<id>` — set
   **Microphone → Allow**.

Verified: the e2e test opens `permission.html` in Chromium with a fake media device and confirms
`getUserMedia` resolves in the extension page and the tab closes itself; the side panel page reports
`webkitSpeechRecognition` available. The actual prompt UI can only be exercised by hand (below).

### Manual smoke test (the part that cannot be automated)

1. `npm run build`, load `dist/` unpacked, paste the key in settings, **Test connection**.
2. Open any normal page (e.g. `https://example.com`), click the toolbar icon → side panel opens.
3. Tap the mic → a `permission.html` tab opens → **Allow** → tab closes → the ring pulses,
   "Listening…".
4. Say **"go to wikipedia"**. The tab navigates as the word "wikipedia" lands; the card says
   "Opened en.wikipedia.org · 0.6 s after your last word". Then try "search for alan turing",
   "scroll down a bit", "go back", "click the first result", "no, not that one".
5. No microphone? Type a command in the box or tap a suggestion chip.

## What you can say

| Say | What happens |
| --- | --- |
| "go to wikipedia" / "open youtube" / "go to example dot com" | navigates the active tab (site list or spoken domain; code owns the URLs) |
| "search for alan turing" | uses the page's own search box if it has one (Wikipedia, YouTube…), else DuckDuckGo |
| "search youtube for lofi beats" | site-specific search URL template |
| "click the first result" / "click the new link" / "open the comments tab" | clicks the element Jev picked from the snapshot; ambiguous → numbered badges in the page, say "two" (or tap it in the panel) |
| "type hello world into the search box" | types verbatim (Jev picked the span, code copies it) |
| "scroll down a bit" / "scroll to the bottom" / "scroll up a page" | scroll with amount from a 3-level Score |
| "go back" / "go forward" / "reload" | history (exactly one step — see *Duplicate protection*) |
| "open a new tab" / "close this tab" / "next tab" | tabs (in the side panel's window) |
| "close this" / "dismiss the popup" / "accept cookies" / "not now" / "no thanks" | dismisses the pop-up, dialog or cookie banner covering the page (see *Pop-ups*) |
| "no, not that one" / "undo that" / "wrong link" | correction: reverses the last action (click/navigate → back, typing → clear, scroll → opposite) |
| "no, the other one" | correction with a new target: the element just clicked is excluded |
| "click place order" | destructive → "Are you sure?" card; say **"confirm"** (or "cancel") |
| "so anyway I think we should get lunch" | ignored (`is_command` ≈ 0.02) |

Two commands in one breath work too: "go to example dot com and click the more information link".

## Pop-ups, dialogs and cookie banners

The content script detects what is covering the page: an open `<dialog>`, `[role=dialog]`,
`[role=alertdialog]`, `[aria-modal=true]`, a fixed panel with controls sitting on a scrim that
covers ≥ 30 % of the viewport (**modal**), or a wide fixed strip at the top/bottom edge with a
dismiss-style button or consent wording (**banner**). Sticky navigation bars and side rails are not
pop-ups. Elements behind a modal's backdrop are ignored for detection (they are unreachable anyway).

When a pop-up is present its controls are collected **first** (they can never be dropped by the
100-element cap), each element line is tagged `[popup]`, and the state carries
`page.modal_open: true`, `page.modal_kind` and `page.modal_text` (first 120 chars) so Jev knows
what is on screen. A `close_popup` intent ("close this", "dismiss", "accept cookies", "not now")
resolves to the pop-up's control: Jev's `target` pick when it is confident and inside the pop-up,
otherwise code ranks the pop-up's buttons by your words (accept / reject / close) with the patterns
in `constants.js`. Ordinary "click accept all cookies" works as before via `click_element`.

The collector also walks **open shadow roots** and **same-origin iframes** (elements are tagged
`[in frame]`); clicks and typing reach them through an in-page registry (`window.__vbById`) instead
of `querySelector`, and highlights are offset by the frame's position. Cross-origin iframes stay
invisible (Chrome does not allow it).

## Duplicate protection — why "go back" goes back exactly once

Chrome's Web Speech API can deliver the phrase you just said a second time: the final result lands
under a new result index, or the recognizer replays the last phrase after its automatic restart.
Every delivery used to be a fresh utterance, so "go back" could act two or three times. Two rules in
`controller.js` (constants in `constants.js`) stop that:

- **Transcript guard** (`DUPLICATE_TRANSCRIPT_MS` = 2.5 s): a transcript under a *new* utterance
  id that equals — or extends by one word — the text just acted on is consumed, not re-evaluated.
  Two or more new words after it are treated as the next command (like chaining).
- **Repeat guard** (`REPEAT_ACTION_MS` = 1.5 s): an identical closed-set action (back, forward,
  reload, scroll, tab ops) decided again within 1.5 s of the previous execution is ignored unless you
  say "again" / "once more". The panel says "Already did that a moment ago — say “again” to repeat".

Raw recognizer events (interim/final, result index, utterance id) are listed under
**Details → Speech events** so a real-microphone session can be inspected. Back/forward navigate
with an in-page `history.go()`; `chrome.tabs.goBack` refuses history entries that were created
without a user gesture — which is every navigation this extension makes.

## How a decision is made

Identical to voice-browser (see its README for the full table): one Jev request per transcript
update with state `{transcript, page{…, modal_open, modal_text}, elements, context{previous_page,
recent_actions}}` and the questions `intent · target · site · complete · is_command · destructive ·
scroll_amount · tab_direction` (+ `text_span` / `url_span` when the transcript has candidates,
+ `is_correction` when there is history). Policy gates (`T` in `src/constants.js`) are shown in
**Details → Last decision**. `context` is **per tab**: the page you came from and the last 3
executed actions with their outcome (derived from the tab's URL before/after the action).

## Architecture — what runs where

| File | Runs in | Role |
| --- | --- | --- |
| `src/constants.js` | everywhere (bundled) | model pin, thresholds `T`, duplicate windows, dismiss patterns, every question text, site templates — the one file to review |
| `src/policy.js`, `src/spans.js` | service worker | pure decision code (+ `close_popup` / `pickDismissControl`) and candidate extraction |
| `src/jev.js` | service worker (also Node tests) | `buildRequest` / `encodeContext`; `decide` is a plain `fetch` to `api.typesafe.ai` with `AbortController`, timeout, one retry |
| `src/controller.js` | service worker | debounce, ≤2 in-flight + abort, one action per utterance, chaining (`conjunctionCut`), duplicate/repeat guards, silence retry, candidate pick, confirm/cancel, per-tab context, stats; `persistable()/restore()` for `chrome.storage.session` |
| `src/chrome-browser.js` | service worker | adapter over `chrome.tabs`/`chrome.scripting`: which tab to control, snapshot via content script (inject on demand), navigation outcome detection, `historyGo` |
| `src/executor.js` | service worker | actions → content script (click/type/select/scroll/enter) or `chrome.tabs` (navigate/back/forward/reload/tabs) |
| `src/app.js`, `src/background.js` | service worker | wiring + the message protocol (`src/protocol.js`) |
| `src/snapshot.js` | content script (collector) + worker (compaction) | element collection incl. pop-up detection, shadow roots, same-origin iframes; compaction with pop-up-first ranking; site + search-box detection |
| `src/content.js`, `src/overlay.js` | every page (`<all_urls>`, isolated world) | DOM actions via the element registry, highlight / toast / badges |
| `src/sidepanel.html/css/js` | side panel | consumer UI + collapsed Details |
| `src/options.html/js`, `src/pages.css` | settings tab | API key, connection test, mic help, how-it-works, privacy, advanced (read-only) |
| `src/permission.html/js` | a tab | one-time microphone prompt |
| `assets/icon.svg` → `assets/icons/*.png` | toolbar | the mark; `npm run icons` rasterises with Playwright, `build` copies (procedural fallback) |

Content script delivery: declared in the manifest for `<all_urls>` at `document_idle` **and**
injected on demand with `chrome.scripting.executeScript` when a tab predates the extension load.
The script is idempotent (`window.__vbContentLoaded`); the e2e injects it three times and checks
that one scroll message scrolls once.

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
export TYPESAFE_API_KEY=…       # real-API tests only; the extension itself takes the key from the settings page
npm test                        # 83 unit tests, no network: spans, policy, snapshot, context (reused) + jev fetch layer,
                                #   controller (chaining, duplicate & repeat guards), pop-ups (ranking, state, close_popup),
                                #   Chrome adapter/executor and the message protocol against a chrome shim
npm run test:integration        # 42 real-API decision cases on captured page fixtures (incl. 8 pop-up cases) — expects ≥ 90%
npm run test:e2e                # builds dist/, loads it into headless Chromium (Playwright, channel "chromium"), drives 21 steps
                                #   word by word on wikipedia / example.com / HN / DuckDuckGo + local pages (modal, banner,
                                #   content-script re-injection, "go back" with re-delivered recognizer events)
npm run test:e2e:headed         # same, watch it
npm run ui:shots                # screenshots of every UI state into reports/ui/
node scripts/capture-fixture.mjs pages/modal.html modal-page   # refresh a fixture
```

Latest measured (Sep 2026, this machine): unit 83/83 · integration 42/42 (100%, latency avg
≈ 360 ms, p50 ≈ 330 ms) · e2e 21/21 in two consecutive headless runs, Jev latency avg ≈ 330–450 ms
depending on the API's mood, whole run ≈ $0.015 and ~65 Jev calls.

## Limitations

- **Chrome only** (side panel, `chrome.*` APIs, Web Speech API). The Web Speech API sends audio to
  Google; interim results arrive in bursts, so "acting before you finish" shows most on long phrases.
- **Pages the extension cannot see into**: `chrome://` pages, the Chrome Web Store, the built-in
  PDF viewer, other extensions' pages, **cross-origin iframes**. The panel says so; navigation,
  back/forward, reload and tab commands still work there.
- Pop-up detection is heuristic (dialog roles, scrims, edge strips with consent wording). A
  custom overlay that is neither will still be clickable by name, just not flagged.
- Snapshot capped at 100 elements (pop-up controls first, then viewport), 60 chars each — deep pages
  need a scroll before "click …" finds below-fold items.
- Clicks are synthesized events; `target=_blank` links are opened by the worker (a scripted click
  would hit the popup blocker). Sites requiring a trusted user gesture for an action will ignore it.
- Saying the exact same closed-set command twice within 1.5 s needs "again"; the same phrase within
  2.5 s under a new recognizer result is treated as a re-delivery.
- Confidence gates are calibrated on `jev-1.13.0`; re-check `T` if you move the model.

## Layout

```
manifest.json           MV3 manifest (copied into dist/)
assets/                 icon.svg (source) + icons/*.png (rasterised by `npm run icons`)
scripts/                build.mjs (esbuild + static copy), icons.mjs, ui-screenshots.mjs, capture-fixture.mjs
src/                    see the architecture table above
test/unit/              spans, policy, snapshot, context (reused) · jev, controller, chrome-adapter, app, popup (new)
test/helpers/           chrome-shim.js (in-memory chrome.* + fake content script), mock-jev.js
test/integration/       42 real-API cases on fixtures, prints pass rate + latency
test/e2e/               Playwright runner + local test pages (modal.html with dialog/banner/shadow/iframe, page-a/b/c)
test/fixtures/          captured page snapshots (incl. modal-page, banner-page)
reports/ui/             UI screenshots from `npm run ui:shots`
DEMO.md                 3–5 minute demo script
```
