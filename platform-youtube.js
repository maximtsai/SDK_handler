/*
 * GameSDK — YouTube Playables adapter
 * ===================================
 *
 * Requires sdk-core.js FIRST, and the vendor tag BEFORE both (it is
 * parser-blocking, exactly as YouTube's docs specify):
 *
 *   <script src="https://www.youtube.com/game_api/v1"></script>
 *   <script src="js/sdk-core.js"></script>
 *   <script src="js/platform-youtube.js"></script>
 *
 * Docs: https://developers.google.com/youtube/gaming/playables
 *
 * Module map (window.ytgame):
 *   .game       firstFrameReady, gameReady, saveData, loadData
 *   .system     isAudioEnabled, onAudioEnabledChange, onPause, onResume,
 *               getLanguage
 *   .engagement sendScore
 *   .ads        requestInterstitialAd, requestRewardedAd
 *   .health     logError, logWarning
 *
 * CERTIFICATION — READ BEFORE EDITING
 * -----------------------------------
 * Playables review greps the whole bundle AS TEXT, so this file must not name
 * any of the banned browser APIs — the browser's own persistence mechanisms or
 * the property that reports the browser's language — even in dead code, even
 * in the mock, and even inside a comment. A comment that merely mentions one
 * still matches the scan. Key-value storage is
 * therefore in-memory (the core default) and the locale comes from
 * ytgame.system.getLanguage(), or from ?lang=xx in the mock. That restriction
 * is why this platform ships its own mock instead of sharing one.
 *
 * Not available here: gameplayStart/Stop, happy time, adblock probing, player
 * identity, and any interactive sign-in. Declared absent in `capabilities`
 * rather than faked.
 */
(function () {
    'use strict';

    const core = window.GameSDKCore;
    if (!core) {
        console.error('[GameSDK] platform-youtube.js requires sdk-core.js to be loaded first.');
        return;
    }
    const { BaseSDKAdapter, log, warn } = core;

    const DEFAULT_LANGUAGE = 'en-US';

    // Platform save ceilings. Normal saves must stay under 3 MiB; a pause-time
    // final flush must stay under 64 KiB. Both are measured here in UTF-16 code
    // units, which is what the platform stores — a byte length would understate
    // a save full of non-ASCII text and let an over-limit payload through.
    const SAVE_LIMIT_UNITS = 3 * 1024 * 1024;
    const FLUSH_LIMIT_UNITS = 64 * 1024;

    const CAPABILITIES = [
        'interstitial', 'rewarded',
        'cloudSave',
        'leaderboard',
        'loadingSignals', 'firstFrame',
        'hostPause',
        'diagnostics'
    ];

    // ==========================================================================
    // YouTubePlayablesAdapter
    // ==========================================================================

    class YouTubePlayablesAdapter extends BaseSDKAdapter {
        constructor() {
            super();
            this.yt = null;
            // The in-flight (or settled) first loadData(); after the first
            // accepted write it also tracks the latest value so loadData()
            // stays fresh. Every saveData() chains behind it — the platform
            // REJECTS a save issued before the initial load has completed,
            // which would silently drop the write.
            this._loadPromise = null;
            // Serializes saves in call order. The load gate alone lets two
            // rapid writes run concurrently, and the platform does not promise
            // ordering between them — an older snapshot could finish last and
            // win. Chaining here keeps the newest write on top.
            this._writeChain = Promise.resolve();
            // gameReady() is rejected by the lifecycle check unless
            // firstFrameReady() came first, so the ordering is enforced here
            // rather than trusted to every game that adopts the bridge.
            this._firstFrameSent = false;
        }

        get capabilities() { return CAPABILITIES; }

        /** Escape hatch for YouTube-only APIs (openYTContent, SDK_VERSION)
         *  that the bridge deliberately does not wrap. */
        getNativeSDK() { return this.yt; }

        // ---------------------------------------------------------------- init
        //
        // No script loading and no timeout: the vendor tag is parser-blocking
        // and sits above this file, so window.ytgame is already present by the
        // time this runs. If the global is missing the CDN failed, and resolving
        // false leaves the game booting without ads or saves — the "load your
        // game anyway" path from the docs.

        _boot() {
            this.yt = window.ytgame || null;
            if (!this.yt) {
                warn('ytgame SDK not present — is the <script src="https://www.youtube.com/game_api/v1"> ' +
                    'tag above sdk-core.js in index.html?');
                return false;
            }
            log('YouTube Playables initialized. environment =', this.getEnvironment());
            return true;
        }

        // ----------------------------------------------------------- lifecycle

        // No equivalent on this platform: YouTube has no "loading has begun"
        // signal, only the two below.
        loadingStart() { }

        // The first visual frame has rendered — a splash or loading screen
        // counts. MUST precede gameReady().
        firstFrameReady() {
            if (!this._ready || !this.yt.game) return;
            if (this._firstFrameSent) return;   // duplicate signals are an error
            try {
                this.yt.game.firstFrameReady();
                this._firstFrameSent = true;
            } catch (e) {
                warn('firstFrameReady failed:', e);
            }
        }

        // The game is fully loaded and genuinely interactive; dismisses
        // YouTube's loading UI.
        loadingStop() {
            if (!this._ready || !this.yt.game) return;
            // A game that never signalled its first frame would otherwise fail
            // certification on an ordering rule that is invisible at runtime —
            // the loading UI simply never clears. Emit the missing signal and
            // say so, rather than passing the failure through to review.
            if (!this._firstFrameSent) {
                warn('gameReady() called before firstFrameReady(); sending it first. ' +
                    'Call GameSDK.firstFrameReady() when the first frame paints.');
                this.firstFrameReady();
            }
            try {
                this.yt.game.gameReady();
                log('gameReady() called.');
            } catch (e) {
                warn('gameReady failed:', e);
            }
        }

        // --------------------------------------------------------------- audio

        isAudioEnabled() {
            if (!this._ready || !this.yt.system) return true;
            try {
                return this.yt.system.isAudioEnabled();
            } catch (e) {
                warn('isAudioEnabled failed:', e);
                return true;
            }
        }

        // Registers `cb` with one of the ytgame.system listener factories and
        // keeps the unsubscribe handle so cleanup() can release it.
        _listen(name, cb) {
            if (!this._ready || !this.yt.system || typeof this.yt.system[name] !== 'function') {
                return () => { };
            }
            try {
                const unsub = this.yt.system[name](cb);
                if (typeof unsub === 'function') {
                    this._unsubs.push(unsub);
                    return unsub;
                }
                return () => { };
            } catch (e) {
                warn(name + ' failed:', e);
                return () => { };
            }
        }

        onPause(cb) { return this._listen('onPause', cb); }
        onResume(cb) { return this._listen('onResume', cb); }
        onAudioEnabledChange(cb) { return this._listen('onAudioEnabledChange', cb); }

        cleanup() {
            super.cleanup();
        }

        // --------------------------------------------------------------- score
        //
        // sendScore returns a Promise that rejects with an SdkError, so it must
        // be awaited. The value must be a non-negative integer inside safe-integer
        // range or the call is rejected as INVALID_PARAMS.

        async setScore(score) {
            if (!this._ready || !this.yt.engagement ||
                typeof this.yt.engagement.sendScore !== 'function') {
                return false;
            }
            const value = this._normalizeScore(score);
            if (value === null) {
                warn('setScore skipped, invalid value:', score);
                return false;
            }
            try {
                await this.yt.engagement.sendScore({ value });
                return true;
            } catch (e) {
                warn('sendScore failed:', e);
                this.logWarning();
                return false;
            }
        }

        // ---------------------------------------------------------------- data
        //
        // DURABILITY: unlike CrazyGames these writes have a real completion
        // signal, so a saveData that RESOLVES means the platform reported
        // success. A rejection is caught and logged rather than propagated —
        // saveData resolves either way — so treat writes as best-effort and keep
        // the base class's durable-marker advice for anything that must survive
        // a reload.

        // opts.finalFlush marks a pause-time save, which has a much tighter
        // ceiling than a normal one.
        saveData(data, opts) {
            if (!this._ready || !this.yt.game) return Promise.resolve();

            // The platform stores a serialized STRING (up to 3 MiB of UTF-16).
            // A host that passes an object or number straight here — instead of
            // saveJSON — would ship a payload the platform rejects; refuse it
            // loudly rather than swallowing the later rejection.
            if (typeof data !== 'string') {
                warn('saveData skipped: expected a string (use saveJSON for objects), got ' +
                    (data === null ? 'null' : typeof data) + '.');
                this.logError();
                return Promise.resolve();
            }

            // A lone surrogate makes the payload invalid UTF-16 and the platform
            // rejects it. Catch it here rather than shipping a save that
            // silently never lands. isWellFormed is recent; skip where absent.
            if (typeof String.prototype.isWellFormed === 'function' &&
                !data.isWellFormed()) {
                warn('saveData skipped, payload is not well-formed UTF-16.');
                this.logError();
                return Promise.resolve();
            }

            // Over the ceiling the platform rejects the write with
            // SIZE_LIMIT_EXCEEDED. Refusing here makes the failure loud during
            // development instead of silent in production, where the symptom is
            // a player's progress quietly never persisting.
            const units = typeof data === 'string' ? data.length : 0;
            const limit = (opts && opts.finalFlush) ? FLUSH_LIMIT_UNITS : SAVE_LIMIT_UNITS;
            if (units > limit) {
                warn('saveData skipped: ' + units + ' UTF-16 units exceeds the ' +
                    ((opts && opts.finalFlush) ? '64 KiB final-flush' : '3 MiB save') +
                    ' limit. Trim the payload — the platform would reject it.');
                this.logError();
                return Promise.resolve();
            }

            const write = () => {
                try {
                    // Promise.resolve wraps it so an async rejection (e.g.
                    // SIZE_LIMIT_EXCEEDED) is handled here rather than surfacing
                    // as an unhandled rejection.
                    return Promise.resolve(this.yt.game.saveData(data)).then(
                        () => {
                            // Keep the memoized load in sync with the last
                            // accepted write, so a save→load round-trip returns
                            // the just-written value. The other adapters read
                            // their live store; without this YouTube would hand
                            // back the boot snapshot forever.
                            this._loadPromise = Promise.resolve(data);
                        },
                        (e) => {
                            warn('saveData failed:', e);
                            this.logError();
                        }
                    );
                } catch (e) {
                    warn('saveData failed:', e);
                    this.logError();
                    return Promise.resolve();
                }
            };

            // Never overtake the initial load: a save that wins that race is
            // rejected outright and the game carries on believing it saved.
            //
            // If nothing has loaded yet, issue the load here rather than writing
            // blind. Callers are not all load-then-save — a hard-reset boot skips
            // the fetch entirely and goes straight to writing a fresh slate — so
            // the ordering has to be guaranteed at this level to be guaranteed
            // at all.
            const gate = this._loadPromise || this.loadData();
            // Chain behind the previous write (not just the initial load) so
            // saves land in call order. `write` never rejects, so one failure
            // cannot strand the chain.
            this._writeChain = this._writeChain.then(() => gate).then(write, write);
            return this._writeChain;
        }

        loadData() {
            if (!this._ready || !this.yt.game) return Promise.resolve(null);
            if (this._loadPromise) return this._loadPromise;
            try {
                this._loadPromise = Promise.resolve(this.yt.game.loadData()).catch((e) => {
                    // API_UNAVAILABLE is transient; everything else is worth
                    // reporting. Either way the game starts from defaults rather
                    // than dying, and the save is rewritten on the next write.
                    const transient = this.yt.SdkError && e instanceof this.yt.SdkError &&
                        this.yt.SdkErrorType && e.errorType === this.yt.SdkErrorType.API_UNAVAILABLE;
                    warn('loadData failed:', e);
                    if (!transient) this.logError();
                    return null;
                });
            } catch (e) {
                warn('loadData failed:', e);
                this.logError();
                this._loadPromise = Promise.resolve(null);
            }
            return this._loadPromise;
        }

        // Wipes the cloud save by writing an empty string, which the bridge and
        // the game both read back as "no save". The reference documents no
        // dedicated delete call, so treat the clear as best-effort and confirm
        // it with the Playables Test Suite; a rejection is caught in saveData
        // and resolves anyway, so the old save is NOT guaranteed gone.
        async nukeAllData() {
            this._storage = {};
            await this.saveData('');
            // Drop the memoized load so the next read re-fetches from the
            // platform and confirms the wipe (an empty-string write reads back
            // as "no save") rather than trusting the in-memory value.
            this._loadPromise = null;
        }

        // -------------------------------------------------------------- locale
        //
        // ytgame.system.getLanguage() resolves asynchronously — the reason the
        // whole interface returns a Promise here. This is the ONLY permitted
        // locale source on the platform, so the failure path falls back to a
        // fixed default rather than reading the browser's preference.

        getLanguage() {
            if (!this._ready || !this.yt.system ||
                typeof this.yt.system.getLanguage !== 'function') {
                return Promise.resolve(DEFAULT_LANGUAGE);
            }
            try {
                return Promise.resolve(this.yt.system.getLanguage()).catch((e) => {
                    warn('getLanguage failed:', e);
                    return DEFAULT_LANGUAGE;
                });
            } catch (e) {
                warn('getLanguage failed:', e);
                return Promise.resolve(DEFAULT_LANGUAGE);
            }
        }

        getEnvironment() {
            if (!this.yt) return 'disabled';
            try {
                return this.yt.IN_PLAYABLES_ENV ? 'youtube' : 'local';
            } catch (e) {
                // A throw reading the flag means the SDK surface is unexpected —
                // treat it as not-in-Playables rather than claiming production.
                return 'local';
            }
        }

        // ----------------------------------------------------------------- ads
        //
        // Return shapes, per the current SDK reference:
        //   requestRewardedAd(rewardId) -> Promise<boolean>  (was it earned)
        //   requestInterstitialAd()     -> Promise<void>     (resolves = request
        //                                  completed; NOT proof an ad showed)
        //
        // There is no AdResult enum. The deprecated ytgame.ads.requestAd() had
        // one ({ UNKNOWN: 0, SHOWED: 1, ... }) and comparing this boolean
        // against it is a silent disaster: `true === 1` is false, so every ad
        // the player watched in full would read as declined and pay nothing.
        // Core tests the boolean strictly, so an unexpected future shape denies
        // the reward rather than granting it free.
        //
        // There is no "the ad has begun" callback here, so started() fires
        // immediately before the request: the game must already be paused by the
        // time YouTube renders the ad over it.

        _requestAd(type, hooks, rewardId) {
            const rewarded = type === 'rewarded';

            if (!this._ready || !this.yt.ads) {
                warn(type + ' — ytgame.ads unavailable.');
                // A rewarded ad that never played must not pay out. A midgame
                // break must still let the game continue.
                if (rewarded) hooks.failed('ad_unavailable');
                else hooks.finished(true);
                return;
            }

            hooks.started();

            if (rewarded) {
                Promise.resolve(this.yt.ads.requestRewardedAd(rewardId))
                    .then(
                        (earned) => hooks.finished(earned === true),
                        (e) => { this.logWarning(); hooks.failed(e); }
                    );
                return;
            }

            Promise.resolve(this.yt.ads.requestInterstitialAd())
                .then(
                    // Resolution carries no value, so there is nothing to report
                    // about whether an ad actually appeared. Gameplay resumes
                    // either way.
                    () => hooks.finished(true),
                    (e) => { this.logWarning(); hooks.failed(e); }
                );
        }

        // --------------------------------------------------- health/diagnostics
        //
        // Best-effort and rate-limited by YouTube. Both take no arguments — they
        // only signal that an error or warning occurred.

        logError() {
            if (!this._ready || !this.yt.health ||
                typeof this.yt.health.logError !== 'function') return;
            try { this.yt.health.logError(); } catch (e) { /* never let diagnostics throw */ }
        }

        logWarning() {
            if (!this._ready || !this.yt.health ||
                typeof this.yt.health.logWarning !== 'function') return;
            try { this.yt.health.logWarning(); } catch (e) { /* never let diagnostics throw */ }
        }
    }

    // ==========================================================================
    // YouTubeMock — local development stand-in.
    //
    // Saves are IN-MEMORY and die with the page. That is not an oversight: see
    // the certification note at the top of this file. Use ?lang=xx to test other
    // locales.
    // ==========================================================================

    class YouTubeMock extends BaseSDKAdapter {
        constructor() {
            super();
            this._audioEnabled = true;
            this._save = null;
        }

        get capabilities() { return CAPABILITIES; }

        _boot() {
            console.log('[MockSDK] Initialized (YouTube Playables mock, local dev).');
            return true;
        }

        firstFrameReady() { console.log('[MockSDK] firstFrameReady()'); }
        loadingStop() { console.log('[MockSDK] loadingStop() / gameReady()'); }

        // Deliberately unlogged — games poll this several times a second.
        isAudioEnabled() { return this._audioEnabled !== false; }

        onPause(cb) {
            console.log('[MockSDK] onPause() registered. (Trigger via window.__mockPause())');
            window.__mockPause = cb;
            return () => { window.__mockPause = null; };
        }
        onResume(cb) {
            console.log('[MockSDK] onResume() registered. (Trigger via window.__mockResume())');
            window.__mockResume = cb;
            return () => { window.__mockResume = null; };
        }
        onAudioEnabledChange(cb) {
            console.log('[MockSDK] onAudioEnabledChange() registered. ' +
                '(Trigger via window.__mockAudioEnabledChange(bool))');
            window.__mockAudioEnabledChange = (enabled) => {
                // Mirror the real host: the getter flips first, then the event.
                this._audioEnabled = enabled !== false;
                console.log('[MockSDK] audio enabled →', this._audioEnabled);
                cb(this._audioEnabled);
            };
            return () => { window.__mockAudioEnabledChange = null; };
        }

        setScore(score) {
            console.log('[MockSDK] setScore:', score);
            return Promise.resolve(true);
        }

        saveData(data) {
            console.log('[MockSDK] saveData() → in-memory (dies with the page, as on YouTube)');
            // Mirror the real platform, which stores only a string: refuse
            // non-strings loudly so a saveJSON omission surfaces in dev instead
            // of as a swallowed rejection on YouTube.
            if (typeof data !== 'string') {
                console.warn('[MockSDK] saveData expected a string (use saveJSON); got ' +
                    (data === null ? 'null' : typeof data) + '. Skipped.');
                return Promise.resolve();
            }
            this._save = data;
            return Promise.resolve();
        }
        loadData() {
            console.log('[MockSDK] loadData() →', this._save ? 'found' : 'no data');
            return Promise.resolve(this._save);
        }
        async nukeAllData() {
            console.log('[MockSDK] nukeAllData()');
            this._storage = {};
            this._save = null;
        }

        // Dev stand-in for ytgame.system.getLanguage(). Does NOT read the
        // browser's locale preference — that API is banned inside Playables and
        // the certification scan greps the bundle as text, so its mere presence
        // would flag the build.
        getLanguage() {
            const lang = core.queryParam('lang') || DEFAULT_LANGUAGE;
            console.log('[MockSDK] getLanguage() →', lang);
            return Promise.resolve(lang);
        }

        getEnvironment() { return 'local'; }

        _requestAd(type, hooks) {
            console.log('[MockSDK] ' + type + ' ad → simulated: started → finished');
            hooks.started();
            setTimeout(() => hooks.finished(true), 100);
        }

        logError() { console.warn('[MockSDK] logError()'); }
        logWarning() { console.warn('[MockSDK] logWarning()'); }
    }

    window.GameSDK._register({
        name: 'youtube',
        Adapter: YouTubePlayablesAdapter,
        Mock: YouTubeMock
    });
})();
