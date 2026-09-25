# Privacy Policy

Effective date: September 22, 2026

Voice Browser processes information only to interpret and carry out the user's voice or typed
browser commands. It does not sell personal data, serve ads, or use analytics.

## Information processed

- Voice input is transcribed by Chrome's Web Speech API. Depending on the user's Chrome
  configuration, Google may process the audio under Google's applicable privacy terms. Voice
  Browser does not record or store microphone audio.
- If the user saves an ElevenLabs API key, voice input is instead streamed to ElevenLabs'
  real-time speech-to-text service (`api.elevenlabs.io`) while the microphone is on, together with
  up to 50 visible on-screen labels used as recognition hints. The key is stored in
  `chrome.storage.local` and is sent only to ElevenLabs, to obtain short-lived single-use tokens.
- The command transcript, active page URL and title, a limited snapshot of actionable page
  elements (such as visible labels, links, and form-field descriptions), and up to three recent
  actions are sent to TypeSafe's System One API at `api.typesafe.ai` to determine the intended
  action. Password fields and user-entered form values are excluded from the snapshot.
- The user's TypeSafe API key is stored in `chrome.storage.local` on the user's device and is sent
  only to `api.typesafe.ai` as an authorization credential. It is not exposed to visited pages.
- Short-lived decision state, recent actions, and usage statistics are stored in
  `chrome.storage.session` and are cleared when the browser session ends.

## Data sharing and retention

Voice Browser sends data only to the service providers required for speech transcription and
command interpretation, as described above. The extension itself has no server and does not
maintain a user database. Retention by Google, ElevenLabs, and TypeSafe is governed by their respective terms
and privacy policies. Data is not sold, used for advertising, used to determine creditworthiness,
or transferred for purposes unrelated to the extension's single purpose.

## Permissions

The extension requires access to pages the user visits so it can identify controls and perform
the requested click, typing, scrolling, navigation, and tab actions. It acts only on the active
tab. A detailed explanation of each Chrome permission is available in the project README.

## User controls

Users can stop microphone access in Chrome's site settings, remove the saved API keys from the
extension settings, clear extension storage, or uninstall the extension at any time.

## Contact

For privacy questions, open an issue at
https://github.com/moritzkremb/jev-voice-browser/issues.
