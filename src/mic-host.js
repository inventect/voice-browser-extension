/**
 * Offscreen-document host for the microphone (local addition). The service worker cannot use the
 * microphone itself, and the side panel stops everything when it closes, so the recognisers run in
 * one offscreen document (reason USER_MEDIA) that the worker creates on "mic on" and closes on
 * "mic off". Injectable in createApp() so unit tests can use a fake.
 */
export const OFFSCREEN_URL = "offscreen.html";

export function createMicHost(chrome, { url = OFFSCREEN_URL } = {}) {
  let creating = null;
  const fullUrl = () => chrome.runtime.getURL(url);

  async function exists() {
    if (!chrome.runtime?.getContexts) return false;
    try {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [fullUrl()] });
      return ctx.length > 0;
    } catch {
      return false;
    }
  }

  async function ensure() {
    if (!chrome.offscreen?.createDocument) throw new Error("offscreen documents need Chrome 116 or newer");
    if (await exists()) return;
    if (!creating) {
      creating = chrome.offscreen
        .createDocument({
          url,
          reasons: ["USER_MEDIA"],
          justification: "Listen to the microphone for voice commands, also while the side panel is closed.",
        })
        .catch((err) => {
          if (!/single offscreen|already/i.test(String(err?.message || err))) throw err;
        })
        .finally(() => {
          creating = null;
        });
    }
    await creating;
  }

  async function close() {
    try {
      if (await exists()) await chrome.offscreen.closeDocument();
    } catch {}
  }

  /** Message the document; retries briefly while its listener is not registered yet. */
  async function send(msg) {
    let last;
    for (let i = 0; i < 6; i++) {
      try {
        return await chrome.runtime.sendMessage({ ...msg, target: "offscreen" });
      } catch (err) {
        last = err;
        if (!/Receiving end does not exist|Could not establish connection/i.test(String(err?.message || err))) throw err;
        await new Promise((r) => setTimeout(r, 60 * (i + 1)));
      }
    }
    throw last;
  }

  return { ensure, close, send, exists };
}
