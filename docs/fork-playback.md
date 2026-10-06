# Spotifast Lab browser playback

The fork keeps Spotifast's native Rust/egui interface and uses one paired
Spotify web-player tab in an installed browser for playback. This avoids
shipping or running another bundled Chromium distribution. It is a prototype:
Free-account playback and uninterrupted ad-free listening require a real
Free-account test. A Premium trial cannot validate either claim.

## Setup on macOS

1. Build and launch the native app:
   `cargo run --locked --no-default-features -- --browser-playback`.
   Sign in to your own Spotify account through the normal OAuth page.
   To build a Finder-launchable app, run `cargo build --locked --release
   --no-default-features`, then `python3 packaging/macos/bundle-lab.py
   target/release/spotifast "dist/Spotifast Lab.app" 0.12.0`.
   The separate app bundle launches browser playback automatically.
2. Preview the native host registration:
   `python3 browser-companion/install-host.py --browser brave`.
   Add `--install` to register the reviewed, limited relay.
3. Open the browser's extensions page, enable developer mode, and load
   `browser-companion/` as an unpacked extension. Review its permissions:
   native messaging and request filtering on the listed Spotify hosts.
4. Open `https://open.spotify.com` in the same browser profile and sign in
   to the same account. The browser may ask to enable Widevine; the user
   must review Google's terms and that prompt themselves.
5. Click the companion's toolbar button on the Spotify tab. Its badge
   shows `ON` after pairing or `!` with an actionable error. Keep that tab
   open, optionally in the background. Use the native app to choose tracks.

Brave rejects an unpacked extension containing names beginning with `_`,
including Python's `__pycache__` directory. Run companion Python checks with
`python3 -B -m unittest discover -s browser-companion -p 'test_*.py'` so they
do not write bytecode into the extension. If an older check created a cache,
move that generated directory outside `browser-companion/`, then retry loading.

Chromium and Chrome have installer options. Linux native host registration
is implemented but unverified. Windows Rust code remains portable; a Windows
native host registration installer has not been supplied. No extension is
installed automatically and no browser security protections are disabled.

## Implemented transport

The native app translates play, pause/toggle, next, previous, track/context
loads, seek, volume, shuffle, repeat and add-to-queue into bounded commands.
The companion operates Spotify's existing web-player controls and reports
the public now-playing metadata. When the song title links to an album,
its public drag-and-drop song link supplies the track URI; the system
clipboard and private application state are not read. Unsupported or changed controls return a
visible failure instead of silently succeeding. Browser UI selectors are
integration contracts that still require a live check.

Commands are retained until acknowledged. The companion acknowledges each
command once and does not replay toggles or skips after a transport retry.
A failed command reports an error and can be retried by the user. Closing
the tab disconnects playback; signing out closes the native bridge. Closing
the native app does not close or sign out the browser tab.

Repeated playback errors refresh one visible notice rather than stacking
copies. Bursts of different errors keep at most the four latest notices.

Spotify context loads use its own web-player queue. Selecting a track within
a native playlist currently opens that track directly, so retaining the
original playlist context is not yet implemented. Selecting a new item while
paused is explicitly unsupported. Clearing the web-player
queue is explicitly unsupported. Session-only features backed by librespot,
native audio EQ, visualisers, native audio-device selection, normalisation,
and Spotify Connect transfer are not supported by this transport. Web API
library requests retain their existing Spotify permissions and rate limits.

## Experimental advertisement handling

Two narrow declarative request rules block dedicated Spotify advertisement
endpoints initiated by the Spotify web player. They do not block Spotify's
general music CDN, change the account plan, or handle DRM keys. If a visible
audio advertisement still plays, the content script attempts to mute its
media element and restores the prior mute state afterward. A muted break
may remain. Detection and filtering can break when Spotify changes its web
player. None of this has yet been verified on a Free account.

## Data and pairing

Native settings, state and caches use the separate `spotifast-lab` profile.
The platform credential-store service is `io.github.natanra.SpotifastLab`.
The app instance slot and update repository are separate from upstream.
Upstream tokens are not imported or deleted. Updates target
`NatanRA/spotifast`; no fork release is currently published.

The app binds an ephemeral port on `127.0.0.1`. A 64-character random pairing
token is written atomically to an owner-only discovery ticket in the fork's
state directory. Only the native messaging relay reads it. The relay accepts
one message type, playback polling, and cannot run arbitrary commands or
select arbitrary files or hosts. Its browser registration permits only the
companion's fixed extension ID. The browser identifies its account through
the profile-menu link, and the native app compares that ID with its verified
Web API account before dispatching any controls. Failure to identify the
account prevents pairing.

Spotify cookies, account credentials, OAuth tokens, license responses and
audio never cross this bridge. Playback state includes the account ID,
track URI, title, artists, position, duration, volume, shuffle and repeat.
Oversized messages, malformed command values, wrong pairing tokens,
different accounts and invalid acknowledgements are rejected. No telemetry
or cloud backend is added.

## Verification

- Rust command translation, account binding, authentication, command ACKs
  and advertisement-state handling have unit coverage.
- The native host has framing, input rejection, private-file permissions,
  loopback round-trip and error-redaction coverage.
- The content script has URI/position validation and unavailable-control
  coverage, independent of a real Spotify account. Worker tests cover command
  replay, reconnect acknowledgement recovery, old callbacks and delayed polls.
- The October 5 macOS all-features run passed 950 library tests, with one
  credential-store test ignored, plus all executable and integration targets.
  The companion passed five Python relay tests and nine JavaScript tests.
- The live signed-in web-player DOM confirmed the profile link, transport
  controls, sliders, repeat labels and the changed shuffle selector. Actual
  extension execution and native playback remain unverified until installation.
- Live native-to-browser playback, current DOM selectors, advertisement
  suppression and Free-account behavior must be tested separately. Passing
  local contract tests does not establish those capabilities.
