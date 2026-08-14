# GameSDK — portable portal bridge

One interface for CrazyGames, YouTube Playables and Yandex Games. Game code
never names a platform; swapping portals means swapping one `<script>` tag.

```
sdk-core.js              interface, capabilities, config, ad orchestration
platform-crazygames.js   CrazyGamesAdapter + CrazyGamesMock
platform-youtube.js      YouTubePlayablesAdapter + YouTubeMock
platform-yandex.js       YandexAdapter + YandexMock
conformance.html         contract test harness (dev tool, never shipped)
sync-sdk.sh              copy this folder into a game
```

## Install

Copy `sdk-core.js` + **exactly one** platform file into the game's `js/`.

**CrazyGames** — the adapter loads the portal SDK itself, so no vendor tag:

```html
<script src="js/sdk-core.js"></script>
<script src="js/platform-crazygames.js"></script>
```

**YouTube Playables** — vendor tag required, and it must be parser-blocking and
above core:

```html
<script src="https://www.youtube.com/game_api/v1"></script>
<script src="js/sdk-core.js"></script>
<script src="js/platform-youtube.js"></script>
```

**Yandex Games** — the adapter loads `/sdk.js` itself, so no vendor tag:

```html
<script src="js/sdk-core.js"></script>
<script src="js/platform-yandex.js"></script>
```

> **Never ship two adapters in one build.** Beyond the wasted bytes, YouTube
> Playables certification greps the whole bundle *as text*: the CrazyGames
> adapter's browser-storage and locale references would flag a Playables build
> even though that code could never run there. Core warns if a second adapter
> registers.

## Use

```js
GameSDK.configure({ gameKey: 'mygame' });   // before your first save/load
await GameSDK.init();                       // never rejects, never hangs

GameSDK.loadingStart();
await loadAssets();
GameSDK.firstFrameReady();
GameSDK.loadingStop();

GameSDK.gameplayStart();                    // menus and ads are NOT gameplay
GameSDK.gameplayStop();
```

Every method is safe to call on every platform — unsupported ones are no-ops or
return documented defaults, so game code never guards a call.

**`configure()` timing.** The deadline is your first **save or load**, not
`init()`. `saveKey` resolves per access, so calling `configure()` after
`await init()` is fine and applies to everything that follows. What cannot be
undone is a write that already went to a different namespace, so the bridge
warns in exactly two cases: storage touched while `gameKey` is still the shared
default `'game'`, and `gameKey` changed after storage was already accessed
(earlier data is then orphaned). Calling it early — synchronously, right after
the script tags — sidesteps both.

### Ads

```js
const earned = await GameSDK.showAd('rewarded', {
  onStarted:  () => { game.pause(); audio.mute(); },
  onFinished: () => grantReward(),          // rewarded: the reward is EARNED
  onError:    () => {}                      // resume; grant NOTHING
}, 'double-coins-v1');                      // reward id — see below
```

The third argument identifies **which** reward this is. YouTube requires it to be
stable and non-user-specific — never a player id, session id or timestamp. A game
with two distinct rewards must pass two distinct ids; it defaults to
`config.rewardId` for games that only have one. Other platforms ignore it.

Guaranteed on every platform, verified in `conformance.html`:

- settles **exactly once** — even if the portal never answers (watchdog), fires
  its callbacks twice, or throws synchronously
- a rewarded ad that did not genuinely play **never** calls `onFinished`
- `onStarted` fires on the real signal where one exists (CrazyGames `adStarted`)
  and immediately before the request where it doesn't (YouTube). Treat it as
  "may fire just before the ad is visible" and be safe to pause early.

The bridge injects no DOM and no CSS. Ad transitions, pausing and muting belong
to the game — the bridge only says *when*.

### Capabilities

Branch on capability, never on platform. `if (getEnvironment() === 'youtube')`
in game code is the one thing that stops these builds being interchangeable.

```js
if (GameSDK.supports('leaderboard')) showLeaderboardButton();
```

| capability | CrazyGames | YouTube | Yandex |
|---|:--:|:--:|:--:|
| `interstitial` / `rewarded` | ✅ | ✅ | ✅ |
| `adblockProbe` | ✅ | — | — |
| `cloudSave` | ✅ | ✅ | ✅ |
| `keyValueStore` | ✅ | — (in-memory) | ✅ |
| `leaderboard` | — | ✅ | ✅ (needs `leaderboardName`) |
| `signIn` / `userProfile` | ✅ | — | ✅ |
| `loadingSignals` | ✅ | partial¹ | partial¹ |
| `firstFrame` | ✅² | ✅ (must precede `loadingStop`) | — |
| `gameplaySignals` | ✅ | — | ✅ |
| `progressReport` / `happyTime` | ✅ | — | — |
| `hostPause` | — | ✅ | ✅ |
| `diagnostics` | — | ✅ | — |

¹ `loadingStart()` is a no-op; only `loadingStop()` maps to a platform signal.
² Called only if the SDK build exposes it; silent when absent.

**Yandex-only:** `GameSDK.serverTime()` returns a tamper-proof clock in ms — use
it for daily-reward timers instead of `Date.now()`. `GameSDK.getNativeSDK()`
returns the raw `ysdk` for payments, flags, stats, shortcut and GamesAPI, which
have no counterpart on the other portals and are deliberately outside this
interface.

### Saving

```js
await GameSDK.saveJSON(state);
const state = await GameSDK.loadJSON();     // null on a corrupt save — start fresh

// Pause-time final flush: a much tighter ceiling, and best-effort only.
await GameSDK.saveData(small, { finalFlush: true });
```

Save at **material progress points** — level complete, chapter advance, major
unlock — not only on pause or exit. YouTube enforces ceilings the bridge checks
for you (3 MiB normal, 64 KiB final flush) and refuses an over-limit write
loudly rather than letting the platform reject it silently. Save schema
versioning and migration are the game's job: the bridge will hand you back
whatever was stored, including a save written by an older build.

**Durability differs by platform and this will bite you.** On YouTube `saveData`
has a real completion signal, so an awaited write that *resolves* means the
platform reported success — but a rejection is caught and logged, so treat it as
best-effort. On CrazyGames the write is fire-and-forget with no completion
signal, so the promise resolves long before the data is safe — anything that
must survive a reload needs its own durable marker written before unload.

Key-value storage (`setItem`/`getItem`) is **in-memory by default** because
YouTube Playables forbids browser persistence; CrazyGames overrides it to cloud
storage. Don't use it as a save mechanism unless `supports('keyValueStore')`.

### Locale

`getLanguage()` returns a **Promise** on every platform, because YouTube's is
async. If it were sync anywhere, callers would break only on YouTube — the one
environment that is hardest to debug.

⚠️ **Match on the primary subtag.** CrazyGames and YouTube return full BCP-47
tags (`"en-US"`, `"pt-BR"`); Yandex returns bare ISO 639-1 (`"en"`, `"tr"`).
Code comparing against `'en-US'` silently falls through to its default on every
Yandex locale — nothing throws, the game just ships in English. `lang.split('-')[0]`
on all three. The Yandex mock returns a bare code too, so this fails in dev
rather than in production.

## What the bridge does NOT cover

It handles the SDK contract. These are certification requirements it cannot
satisfy for you — they live in the game:

**YouTube** — no page-visibility or browser-locale APIs anywhere in the bundle
(grep the *built* bundle, not the source); no in-game master mute competing with
YouTube's; no in-game quit button or platform-control lookalikes; no external
network calls; relative asset paths only; no orientation lock; resize must not
reset state; SPA with no page reloads; bundle and heap ceilings; touch **and**
mouse input; `Escape` not `preventDefault`ed; save schema migration.

**CrazyGames** — never call `gameplayStop()` from your own page focus or
visibility events (the SDK detects those itself); balance gameplay start/stop
across nested popups with a counter, not ad-hoc calls; give any UI state driven
by ad callbacks its own dead-man switch, so a lost callback can't leave a button
permanently dead; unfreeze before side effects in your resume path, and isolate
anything that can throw.

**Yandex** — mute in `onPause` (that is how the sound-stops-when-minimized rule
is met; do not add a page-visibility listener, which would also poison a shared
YouTube build); never call an interstitial during active gameplay; rewarded ads
must be behind a deliberate button that states the reward, and must never gate
baseline completion; 100 MB uncompressed archive with `index.html` at the root
and no spaces or Russian characters in filenames; no external links except your
own games via GamesAPI; no YouTube embeds; long side of the play area ≤ 2× the
short side; full remote control on TV including **OK** and **Back**.

## Dev

```bash
python -m http.server 8000
```

| query | effect |
|---|---|
| `?sdk=mock` (or `local`) | force the mock adapter |
| `?sdk=real` | force the real adapter on localhost |
| `?lang=fr` | override the mock's locale |

Off localhost the **real** adapter is always chosen, even if the portal SDK
never loaded. Falling back to a mock in production would hand out every rewarded
prize free and write saves to the wrong place; the real adapters degrade
gracefully instead.

`GameSDK.configure({ skipAdsInDev: true })` makes every ad settle instantly as a
success. It is hard-gated to localhost and cannot ship live.

Mock helpers in DevTools: `__mockAudioEnabledChange(false)`, `__mockPause()`,
`__mockResume()`.

## Conformance

```
final/conformance.html?platform=crazygames
final/conformance.html?platform=youtube
final/conformance.html?platform=crazygames&sdk=real
```

22 checks covering the interface, the init contract, save round-trips, corrupt
saves, and the ad settle-once rules. Run it against a new adapter before it goes
anywhere near a portal. It loads adapters dynamically, which a real build must
never do — it is a dev tool and is never shipped.

## Adding a platform

1. Copy `platform-crazygames.js` as a starting point.
2. Implement `_boot()`, `_requestAd(type, hooks)` and the platform calls. **Do
   not** reimplement flow control — core owns memoization, the init timeout,
   ad dedupe, both watchdogs and settle-once, so every platform inherits them.
3. Declare `capabilities` honestly. A faked capability is worse than a missing
   one: it puts a dead button in the UI.
4. Ship a mock alongside it in the same file, so platform-specific restrictions
   (like YouTube's) stay partitioned.
5. Register at the bottom: `GameSDK._register({ name, Adapter, Mock })`.
6. Run `conformance.html?platform=<name>` until it is green.

## Versioning

`GameSDK.VERSION` is logged on init. Since adapters are copied into each game
rather than shared, that constant is how you tell which games have a stale copy
when you fix a bug months from now. Bump it on every change to this folder.

```bash
./sync-sdk.sh ../../mygame/js crazygames
```
