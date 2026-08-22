/*
 * GameSDK — Yandex Games adapter
 * ==============================
 *
 * Requires sdk-core.js FIRST:
 *
 *   <script src="js/sdk-core.js"></script>
 *   <script src="js/platform-yandex.js"></script>
 *
 * No vendor tag needed — adapter loads /sdk.js itself.
 * Docs: https://yandex.com/dev/games/doc/en/sdk/sdk-about
 * See ../YANDEX_SDK_REQUIREMENTS.md for verified API surface.
 *
 * Object map:
 *   YaGames.init({signed})            -> ysdk
 *   ysdk.features.LoadingAPI?.ready()
 *   ysdk.features.GameplayAPI?.start() / .stop()
 *   ysdk.on('game_api_pause'|'game_api_resume', cb) -> unsubscribe fn
 *   ysdk.adv.showFullscreenAdv({callbacks:{onOpen,onClose,onError}})
 *   ysdk.adv.showRewardedVideo({callbacks:{onOpen,onRewarded,onClose,onError}})
 *   ysdk.getPlayer({signed})          -> player
 *   ysdk.auth.openAuthDialog()
 *   ysdk.leaderboards.setScore(name, score, extraData?)
 *   ysdk.environment.i18n.lang        -> ISO 639-1 ("tr", not "tr-TR")
 *   ysdk.serverTime()                 -> ms, sync, tamper-proof
 *
 * THE THREE THINGS THAT BITE ON THIS PLATFORM
 * -------------------------------------------
 * 1. `onRewarded` fires BEFORE `onClose`, and `onClose(wasShown)` fires on both
 *    earned and abandoned paths. `wasShown === true` is NOT proof of reward.
 *    This adapter latches `onRewarded` and settles on `onClose`.
 * 2. `onOpen` may never fire — rate-limited/unfilled requests go straight to
 *    `onClose(false)` — and callbacks have been seen firing twice. Core absorbs
 *    both (settle-once + watchdogs); this file must not add flow control.
 * 3. Everything under `ysdk.features` needs optional chaining — partially
 *    loaded SDK leaves entries undefined.
 *
 * Not available: adblock probe, first-frame, progress report, happy time,
 * diagnostics, host audio state. For audio, req. 1.3 (sound stops when
 * minimized) is met via onPause/onResume; host must mute in those callbacks.
 *
 * Beyond this interface (payments, flags, stats, shortcut, GamesAPI, etc.)
 * reach for getNativeSDK() — those have no counterpart on other portals.
 */
(function () {
    'use strict';

    const core = window.GameSDKCore;
    if (!core) {
        console.error('[GameSDK] platform-yandex.js requires sdk-core.js to be loaded first.');
        return;
    }
    const { BaseSDKAdapter, log, warn, isLocalDev } = core;

    // Script load + YaGames.init() + getPlayer(). Generous: cold Yandex CDN
    // is genuinely slow. Core boots fallback rather than holding loading forever.
    const SDK_INIT_TIMEOUT_MS = 10000;

    // getPlayer() can hang on a flaky CDN; cap to avoid stranding getUser/loadData.
    const PLAYER_RESOLVE_TIMEOUT_MS = 5000;

    // Yandex caps setData at 100 writes/5min; coalesce KV churn.
    const KV_WRITE_DEBOUNCE_MS = 1000;

    // Platform rejects leaderboard submissions faster than 1/sec.
    const SCORE_MIN_INTERVAL_MS = 1000;

    // Relative path resolves on Yandex origin; absolute URLs discouraged (§11).
    const SDK_SCRIPT_URL = '/sdk.js';

    const CAPABILITIES = [
        'interstitial', 'rewarded',
        'cloudSave', 'keyValueStore',
        'leaderboard',
        'signIn', 'userProfile',
        'loadingSignals', 'gameplaySignals',
        'hostPause'
    ];

    // ==========================================================================
    // YandexAdapter
    // ==========================================================================

    class YandexAdapter extends BaseSDKAdapter {
        constructor() {
            super();
            this.ysdk = null;
            this._player = null;
            this._playerPromise = null;
            this._authorized = false;
            this._lang = null;
            this._cloud = null;
            this._cloudPromise = null;
            this._loadingReady = false;
            this._gameplayWanted = false;
            this._sdkGameplayRunning = false;
            this._kvWriteTimer = null;
            this._lastScoreAt = 0;
        }

        get capabilities() { return CAPABILITIES; }
        get initTimeoutMs() { return SDK_INIT_TIMEOUT_MS; }

        /** Escape hatch for Yandex-only APIs (payments, flags, stats, ...). */
        getNativeSDK() { return this.ysdk; }

        // ---------------------------------------------------------------- init

        async _boot() {
            const YaGames = await this._loadSdkScript();
            if (!YaGames || typeof YaGames.init !== 'function') {
                warn('Yandex SDK not usable; fallback mode.');
                return false;
            }

            // Client-side processing; { signed: true } is for server-side purchase
            // validation only.
            this.ysdk = await YaGames.init();
            if (!this.ysdk) {
                warn('YaGames.init() resolved empty; fallback mode.');
                return false;
            }
            this._ready = true;
            this._readLocale();
            this._setupHostEvents();
            await this._resolvePlayer();
            this._syncGameplayState();

            log('Yandex initialized. authorized =', this._authorized, 'lang =', this._lang);
            return true;
        }

        // Loads or reuses the SDK script. Core's init timeout bounds this.
        _loadSdkScript() {
            return new Promise((resolve) => {
                const existing = () => window.YaGames || null;
                if (existing()) { resolve(existing()); return; }

                let tag = null;
                try {
                    tag = document.querySelector('script[src$="/sdk.js"], script[src*="sdk.games.s3.yandex.net"]');
                } catch (e) { }

                if (tag) {
                    tag.addEventListener('load', () => resolve(existing()));
                    tag.addEventListener('error', () => {
                        warn('existing Yandex SDK tag failed to load.');
                        resolve(null);
                    });
                    return;
                }

                const script = document.createElement('script');
                script.src = SDK_SCRIPT_URL;
                script.async = true;
                script.onload = () => resolve(existing());
                script.onerror = () => {
                    warn('Yandex SDK script failed to load; fallback mode. ' +
                        'Outside a Yandex-hosted archive /sdk.js will 404 — that is expected.');
                    resolve(null);
                };
                document.head.appendChild(script);
            });
        }

        // ISO 639-1 bare code (not region-qualified). Valid BCP-47 as-is.
        // Hosts must match on the primary subtag or fall through on every locale.
        _readLocale() {
            try {
                const env = this.ysdk.environment;
                if (env && env.i18n && env.i18n.lang) this._lang = env.i18n.lang;
            } catch (e) {
                log('locale read failed:', e);
            }
        }

        // ----------------------------------------------------------- listeners

        _setupHostEvents() {
            // Account switch resyncs cloud data; drop stale cache and re-resolve.
            this._on(this.ysdk.EVENTS && this.ysdk.EVENTS.ACCOUNT_SELECTION_DIALOG_CLOSED, () => {
                this._player = null;
                this._playerPromise = null;
                this._cloud = null;
                this._cloudPromise = null;
                this._resolvePlayer().then(() => this._notifyUserChange());
            });
        }

        _notifyUserChange() {
            const p = this._player;
            let id = null;
            try {
                id = (p && typeof p.getUniqueID === 'function') ? p.getUniqueID() : null;
            } catch (e) { }
            super._notifyUserChange(p, id);
        }

        _on(eventName, handler) {
            if (!eventName || !this.ysdk || typeof this.ysdk.on !== 'function') return () => { };
            try {
                const unsub = this.ysdk.on(eventName, handler);
                if (typeof unsub === 'function') {
                    this._unsubs.push(unsub);
                    return unsub;
                }
                const manual = () => {
                    try { this.ysdk.off(eventName, handler); } catch (e) { }
                };
                this._unsubs.push(manual);
                return manual;
            } catch (e) {
                warn('subscribing to "' + eventName + '" failed:', e);
                return () => { };
            }
        }

        // game_api_pause / game_api_resume are STRING event names, not EVENTS
        // enum members. They fire for ads, purchase modals, tab/minimize.
        // Do not add a page-visibility listener — redundant here and fatal to
        // a shared YouTube build.
        onPause(cb) { return this._on('game_api_pause', cb); }
        onResume(cb) { return this._on('game_api_resume', cb); }

        cleanup() {
            super.cleanup();
            if (this._kvWriteTimer) {
                clearTimeout(this._kvWriteTimer);
                this._kvWriteTimer = null;
            }
        }

        // ----------------------------------------------------------- lifecycle

        loadingStart() { }

        // LoadingAPI.ready(); guarded against duplicate calls.
        loadingStop() {
            if (!this._ready || this._loadingReady) return;
            try {
                const api = this.ysdk.features && this.ysdk.features.LoadingAPI;
                if (!api || typeof api.ready !== 'function') return;
                api.ready();
                this._loadingReady = true;
            } catch (e) {
                warn('LoadingAPI.ready() failed:', e);
            }
        }

        // ------------------------------------------------------------ gameplay
        //
        // Desired-vs-actual tracking; ad forces stop. Unlike CrazyGames, no
        // rate throttle documented.

        _gameplayApi() {
            try {
                return (this._ready && this.ysdk.features && this.ysdk.features.GameplayAPI) || null;
            } catch (e) {
                return null;
            }
        }

        _syncGameplayState() {
            const api = this._gameplayApi();
            if (!api) return;

            const desired = this._adActive ? false : this._gameplayWanted;
            if (desired === this._sdkGameplayRunning) return;

            const fn = desired ? api.start : api.stop;
            if (typeof fn !== 'function') return;

            this._sdkGameplayRunning = desired;
            try {
                fn.call(api);
            } catch (e) {
                this._sdkGameplayRunning = !desired;
                warn('GameplayAPI.' + (desired ? 'start' : 'stop') + '() failed:', e);
            }
        }

        gameplayStart() {
            this._gameplayWanted = true;
            this._syncGameplayState();
        }

        gameplayStop() {
            this._gameplayWanted = false;
            this._syncGameplayState();
        }

        _onAdActiveChange(active) {
            this._syncGameplayState();
        }

        // ---------------------------------------------------------------- user

        _resolvePlayer() {
            if (this._playerPromise) return this._playerPromise;
            this._playerPromise = new Promise((resolve) => {
                let settled = false;
                let timer = null;

                const settle = (p) => {
                    if (settled) return;
                    settled = true;
                    if (timer) { clearTimeout(timer); timer = null; }
                    this._player = p || null;
                    try {
                        this._authorized = !!(p && typeof p.isAuthorized === 'function' && p.isAuthorized());
                    } catch (e) {
                        this._authorized = false;
                    }
                    resolve(this._player);
                };

                timer = setTimeout(() => {
                    log('getPlayer() timed out; treating as guest.');
                    settle(null);
                }, PLAYER_RESOLVE_TIMEOUT_MS);

                Promise.resolve()
                    .then(() => this.ysdk.getPlayer())
                    .then(
                        (p) => settle(p),
                        (e) => {
                            log('getPlayer() unavailable:', e);
                            settle(null);
                        }
                    );
            });
            return this._playerPromise;
        }

        async getUser() {
            if (!this._ready) return null;
            const p = await this._resolvePlayer();
            if (!p || !this._authorized) return null;
            try {
                return {
                    username: typeof p.getName === 'function' ? p.getName() : '',
                    profilePictureUrl: typeof p.getPhoto === 'function' ? p.getPhoto('medium') : null,
                    id: typeof p.getUniqueID === 'function' ? p.getUniqueID() : null
                };
            } catch (e) {
                log('reading profile failed:', e);
                return null;
            }
        }

        isUserSignedIn() { return this._authorized; }

        // Must only ever be called from a deliberate player action.
        async signIn() {
            if (!this._ready || !this.ysdk.auth ||
                typeof this.ysdk.auth.openAuthDialog !== 'function') {
                return this._authorized;
            }
            try {
                await this.ysdk.auth.openAuthDialog();
                // Player object and cloud data are stale after sign-in.
                this._player = null;
                this._playerPromise = null;
                this._cloud = null;
                this._cloudPromise = null;
                await this._resolvePlayer();
                this._notifyUserChange();
            } catch (e) {
                log('auth dialog dismissed or failed:', e);
            }
            return this._authorized;
        }

        // ---------------------------------------------------------------- data
        //
        // Yandex stores an OBJECT of key-value pairs (not a blob). The save
        // string lives under `saveKey` inside it; KV API shares the same object.
        //
        // Every write sends the WHOLE object: the docs don't settle whether
        // setData merges or replaces, and the behaviours differ when they
        // matter — a partial write could silently drop other keys.
        //
        // DURABILITY: setData() has a real completion signal; a flush:true that
        // RESOLVES reached the platform. Rejections are caught and logged.
        // `flush: false` queues (suits KV churn, wrong for progress).

        _canStore() { return !!(this._ready && this._player &&
            typeof this._player.setData === 'function'); }

        _loadCloud() {
            if (this._cloudPromise) return this._cloudPromise;
            this._cloudPromise = Promise.resolve()
                .then(() => {
                    if (!this._canStore() || typeof this._player.getData !== 'function') return {};
                    return this._player.getData();
                })
                .then((data) => {
                    this._cloud = (data && typeof data === 'object') ? data : {};
                    return this._cloud;
                })
                .catch((e) => {
                    warn('getData() failed; starting from an empty save:', e);
                    this._cloud = {};
                    return this._cloud;
                });
            return this._cloudPromise;
        }

        async _writeCloud(flush) {
            if (!this._canStore()) return;
            if (flush && this._kvWriteTimer) {
                clearTimeout(this._kvWriteTimer);
                this._kvWriteTimer = null;
            }
            try {
                await this._player.setData(this._cloud, flush !== false);
            } catch (e) {
                warn('setData() failed:', e);
            }
        }

        // Coalesce KV writes into one setData() per burst.
        _queueCloudWrite() {
            if (this._kvWriteTimer) return;
            this._kvWriteTimer = setTimeout(() => {
                this._kvWriteTimer = null;
                this._writeCloud(false);
            }, KV_WRITE_DEBOUNCE_MS);
        }

        async saveData(data) {
            if (!this._canStore()) return;
            await this._loadCloud();
            this._cloud[this.saveKey] = data;
            await this._writeCloud(true);
        }

        async loadData() {
            if (!this._canStore()) return null;
            const cloud = await this._loadCloud();
            const val = cloud[this.saveKey];
            return val != null ? val : null;
        }

        async setItem(key, value) {
            if (!this._canStore()) return;
            await this._loadCloud();
            this._cloud[key] = String(value);
            this._queueCloudWrite();
        }

        async getItem(key) {
            if (!this._canStore()) return null;
            const cloud = await this._loadCloud();
            const val = cloud[key];
            return val != null ? val : null;
        }

        async removeItem(key) {
            if (!this._canStore()) return;
            await this._loadCloud();
            delete this._cloud[key];
            this._queueCloudWrite();
        }

        // Wipes whole stored object (blob + KV). Resolves; no sentinel needed.
        async nukeAllData() {
            this._storage = {};
            if (!this._canStore()) return;
            this._cloud = {};
            this._cloudPromise = Promise.resolve(this._cloud);
            await this._writeCloud(true);
        }

        // --------------------------------------------------------------- score

        async setScore(score) {
            const name = core.config.leaderboardName;
            if (!this._ready || !name) {
                if (!name) log('setScore skipped: configure({ leaderboardName }) first.');
                return false;
            }
            const lb = this.ysdk.leaderboards;
            if (!lb || typeof lb.setScore !== 'function') return false;

            const value = this._normalizeScore(score);
            if (value === null) {
                warn('setScore skipped, invalid value:', score);
                return false;
            }

            const wait = SCORE_MIN_INTERVAL_MS - (Date.now() - this._lastScoreAt);
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            this._lastScoreAt = Date.now();

            try {
                await lb.setScore(name, value);
                return true;
            } catch (e) {
                log('setScore failed (guest, or leaderboard "' + name + '" missing):', e);
                return false;
            }
        }

        // --------------------------------------------------------- environment

        getLanguage() {
            return Promise.resolve(this._lang || 'en');
        }

        getEnvironment() {
            return this._ready ? 'yandex' : 'disabled';
        }

        // Speed bump, not security boundary; lenient hostname match.
        isAuthorizedHost() {
            if (isLocalDev()) return true;
            const h = (window.location.hostname || '').toLowerCase();
            return h.includes('yandex') || h.includes('ya.ru');
        }

        /** Tamper-proof clock, in ms. Use for daily-reward timers. */
        serverTime() {
            try {
                if (this._ready && typeof this.ysdk.serverTime === 'function') {
                    return this.ysdk.serverTime();
                }
            } catch (e) { }
            return Date.now();
        }

        // ----------------------------------------------------------------- ads

        _requestAd(type, hooks) {
            let adv = null;
            try { adv = this._ready ? this.ysdk.adv : null; } catch (e) { }

            if (!adv) {
                if (type === 'rewarded') hooks.failed('ad_unavailable');
                else hooks.finished(true);   // a break the game must survive
                return;
            }

            if (type === 'rewarded') {
                // onRewarded is the ONLY proof of reward; it fires BEFORE
                // onClose (which fires on both earned and abandoned paths).
                let earned = false;
                adv.showRewardedVideo({
                    callbacks: {
                        onOpen: () => hooks.started(),
                        onRewarded: () => { earned = true; },
                        onClose: () => hooks.finished(earned),
                        onError: (err) => hooks.failed(err || 'error')
                    }
                });
                return;
            }

            adv.showFullscreenAdv({
                callbacks: {
                    onOpen: () => hooks.started(),
                    onClose: () => hooks.finished(true),
                    onError: (err) => hooks.failed(err || 'error')
                }
            });
        }
    }

    // ==========================================================================
    // YandexMock — local dev stand-in. /sdk.js only exists in Yandex archives,
    // so the real adapter can't work on localhost. Saves go to browser storage
    // (dev convenience; on Yandex the save lives in the player object).
    // ==========================================================================

    class YandexMock extends BaseSDKAdapter {
        constructor() {
            super();
            this._authorized = true;
        }

        get capabilities() { return CAPABILITIES; }

        _boot() {
            console.log('[MockSDK] Initialized (Yandex mock, local dev).');
            return true;
        }

        loadingStop() { console.log('[MockSDK] LoadingAPI.ready()'); }
        gameplayStart() { console.log('[MockSDK] GameplayAPI.start()'); }
        gameplayStop() { console.log('[MockSDK] GameplayAPI.stop()'); }

        onPause(cb) {
            console.log('[MockSDK] game_api_pause registered. (Trigger via window.__mockPause())');
            window.__mockPause = cb;
            return () => { window.__mockPause = null; };
        }
        onResume(cb) {
            console.log('[MockSDK] game_api_resume registered. (Trigger via window.__mockResume())');
            window.__mockResume = cb;
            return () => { window.__mockResume = null; };
        }

        getUser() {
            return Promise.resolve({ username: 'Player', profilePictureUrl: null, id: 'mock-id' });
        }
        isUserSignedIn() { return this._authorized; }
        signIn() {
            this._authorized = true;
            this._notifyUserChange({ username: 'Player', profilePictureUrl: null, id: 'mock-id' }, 'mock-id');
            return Promise.resolve(true);
        }
        setScore(score) {
            const name = core.config.leaderboardName;
            if (!name) {
                console.log('[MockSDK] setScore skipped: no leaderboardName configured.');
                return Promise.resolve(false);
            }
            console.log('[MockSDK] setScore(' + name + '):', score);
            return Promise.resolve(true);
        }

        saveData(data) {
            console.log('[MockSDK] saveData() → localStorage');
            try { localStorage.setItem(this.saveKey, data); } catch (e) { }
            return Promise.resolve();
        }
        loadData() {
            let data = null;
            try { data = localStorage.getItem(this.saveKey); } catch (e) { }
            console.log('[MockSDK] loadData() →', data ? 'found' : 'no data');
            return Promise.resolve(data);
        }
        async setItem(key, value) {
            try { localStorage.setItem('mock_' + key, String(value)); } catch (e) { }
        }
        async getItem(key) {
            try { return localStorage.getItem('mock_' + key); } catch (e) { return null; }
        }
        async removeItem(key) {
            try { localStorage.removeItem('mock_' + key); } catch (e) { }
        }
        async nukeAllData() {
            console.log('[MockSDK] nukeAllData()');
            this._storage = {};
            try {
                localStorage.removeItem(this.saveKey);
                const doomed = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && k.indexOf('mock_') === 0) doomed.push(k);
                }
                doomed.forEach((k) => localStorage.removeItem(k));
            } catch (e) { }
        }

        // Mirrors real platform: bare ISO 639-1 code (not BCP-47).
        getLanguage() {
            const lang = core.queryParam('lang') || 'en';
            console.log('[MockSDK] getLanguage() →', lang);
            return Promise.resolve(lang);
        }

        getEnvironment() { return 'local'; }

        serverTime() { return Date.now(); }

        _requestAd(type, hooks) {
            console.log('[MockSDK] ' + type + ' ad → simulated: onOpen → onRewarded → onClose');
            hooks.started();
            setTimeout(() => hooks.finished(true), 100);
        }
    }

    window.GameSDK._register({
        name: 'yandex',
        Adapter: YandexAdapter,
        Mock: YandexMock
    });
})();
