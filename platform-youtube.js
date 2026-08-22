/*
 * GameSDK — YouTube Playables adapter
 * ===================================
 *
 * Requires sdk-core.js FIRST, and the vendor tag BEFORE both (parser-blocking,
 * as YouTube's docs specify):
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
 * any banned browser APIs — persistence mechanisms or the language property —
 * even in dead code, mock, or comments. Key-value storage is in-memory (core
 * default) and locale comes from ytgame.system.getLanguage() or ?lang=xx.
 * That is why this platform ships its own mock.
 *
 * Not available: gameplayStart/Stop, happy time, adblock probe, player
 * identity, sign-in. Declared absent in `capabilities`.
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

    // Save ceilings in UTF-16 code units (what the platform stores, not bytes).
    const SAVE_LIMIT_UNITS = 3 * 1024 * 1024;   // 3 MiB normal
    const FLUSH_LIMIT_UNITS = 64 * 1024;          // 64 KiB final flush

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
            // The first loadData(); updated on each accepted write so loadData()
            // stays fresh. Platform rejects saves before initial load completes.
            this._loadPromise = null;
            // Serializes saves in call order (platform doesn't promise ordering
            // between concurrent writes).
            this._writeChain = Promise.resolve();
            // gameReady() requires firstFrameReady() first; enforced here.
            this._firstFrameSent = false;
        }

        get capabilities() { return CAPABILITIES; }

        /** Escape hatch for YouTube-only APIs not wrapped by the bridge. */
        getNativeSDK() { return this.yt; }

        // ---------------------------------------------------------------- init

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

        loadingStart() { }

        // MUST precede gameReady(); splash/loading screen counts.
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

        // Dismisses YouTube's loading UI. gameReady() requires firstFrameReady first.
        loadingStop() {
            if (!this._ready || !this.yt.game) return;
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
        // DURABILITY: saveData RESOLVES means the platform reported success.
        // Rejections are caught and logged (saveData resolves either way).
        // Anything surviving a reload needs the base class's durable-marker advice.

        saveData(data, opts) {
            if (!this._ready || !this.yt.game) return Promise.resolve();

            // Platform stores only strings; refuse non-strings loudly.
            if (typeof data !== 'string') {
                warn('saveData skipped: expected a string (use saveJSON for objects), got ' +
                    (data === null ? 'null' : typeof data) + '.');
                this.logError();
                return Promise.resolve();
            }

            // Invalid UTF-16 (lone surrogates) rejected by platform.
            if (typeof String.prototype.isWellFormed === 'function' &&
                !data.isWellFormed()) {
                warn('saveData skipped, payload is not well-formed UTF-16.');
                this.logError();
                return Promise.resolve();
            }

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
                    return Promise.resolve(this.yt.game.saveData(data)).then(
                        () => {
                            // Keep memoized load in sync with last accepted write.
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

            // Never overtake the initial load: a save winning that race is
            // rejected and the game thinks it saved.
            const gate = this._loadPromise || this.loadData();
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

        // Writes empty string to clear cloud save; no dedicated delete call.
        // Best-effort; old save is NOT guaranteed gone.
        async nukeAllData() {
            this._storage = {};
            await this.saveData('');
            // Drop the memoized load so the next read re-fetches from the
            // platform and confirms the wipe (an empty-string write reads back
            // as "no save") rather than trusting the in-memory value.
            this._loadPromise = null;
        }

        // -------------------------------------------------------------- locale

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
                return 'local';
            }
        }

        // ----------------------------------------------------------------- ads
        //
        // requestRewardedAd(rewardId) -> Promise<boolean> (earned?)
        // requestInterstitialAd()     -> Promise<void>    (request completed,
        //                                   NOT proof an ad showed)
        //
        // No AdResult enum — the deprecated requestAd() had one. Comparing
        // boolean against it (`true === 1`) is false, so every watched ad would
        // read as declined. Core tests boolean strictly.
        //
        // No "ad began" callback — started() fires before the request so the
        // game must be paused by then.

        _requestAd(type, hooks, rewardId) {
            const rewarded = type === 'rewarded';

            if (!this._ready || !this.yt.ads) {
                warn(type + ' — ytgame.ads unavailable.');
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
                    () => hooks.finished(true),
                    (e) => { this.logWarning(); hooks.failed(e); }
                );
        }

        // --------------------------------------------------- health/diagnostics

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
    // YouTubeMock — local dev stand-in. Saves are in-memory (see certification note).
    // Use ?lang=xx to test other locales.
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
            console.log('[MockSDK] saveData() → in-memory (dies with page)');
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

        // Dev stand-in for getLanguage(). Does NOT read browser locale
        // (banned in Playables — certification greps the bundle as text).
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
