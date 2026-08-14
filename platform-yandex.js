/*
 * GameSDK — Yandex Games adapter
 * ==============================
 *
 * Requires sdk-core.js FIRST:
 *
 *   <script src="js/sdk-core.js"></script>
 *   <script src="js/platform-yandex.js"></script>
 *
 * No vendor tag needed — this adapter loads /sdk.js itself and reuses an
 * existing tag if index.html already has one.
 *
 * Docs: https://yandex.com/dev/games/doc/en/sdk/sdk-about
 * See ../YANDEX_SDK_REQUIREMENTS.md for the verified API surface; every
 * non-obvious decision below cites the section it comes from.
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
 *    the earned and the abandoned path. `wasShown === true` is NOT proof of a
 *    reward. This adapter latches `onRewarded` and settles on `onClose`.
 * 2. `onOpen` may never fire at all — a rate-limited or unfilled request goes
 *    straight to `onClose(false)` — and callbacks have been seen firing twice.
 *    Core absorbs both (settle-once + watchdogs); this file must not add its own
 *    flow control.
 * 3. Everything under `ysdk.features` needs optional chaining. A partially
 *    loaded SDK leaves entries undefined, and a bare call throws during boot.
 *
 * Not available here: an adblock probe, a first-frame signal, progress
 * reporting, a "happy time" signal, platform diagnostics, and any host audio
 * state. Declared absent in `capabilities` rather than faked — for audio, the
 * platform requirement that sound stops when the page is minimized (req. 1.3)
 * is met through onPause/onResume, which the host must honour by muting.
 *
 * Beyond this interface (payments, flags, stats, shortcut, GamesAPI, feedback,
 * fullscreen, clipboard) reach for getNativeSDK() rather than widening the
 * bridge — those have no counterpart on the other portals.
 */
(function () {
    'use strict';

    const core = window.GameSDKCore;
    if (!core) {
        console.error('[GameSDK] platform-yandex.js requires sdk-core.js to be loaded first.');
        return;
    }
    const { BaseSDKAdapter, log, warn, isLocalDev } = core;

    // Script load + YaGames.init() + the first getPlayer(). Generous because a
    // cold Yandex CDN is genuinely slow, but bounded: core boots the game in
    // fallback mode rather than holding the loading screen forever.
    const SDK_INIT_TIMEOUT_MS = 10000;

    // getPlayer() can hang on a flaky CDN; cap the wait so getUser()/loadData()
    // never strand on it (init() already escapes via the handshake timeout).
    const PLAYER_RESOLVE_TIMEOUT_MS = 5000;

    // Yandex caps setData at 100 writes / 5 min, so incidental key-value churn
    // is coalesced into a single queued write per burst instead of one per call.
    const KV_WRITE_DEBOUNCE_MS = 1000;

    // Leaderboard submissions faster than 1/sec are rejected by the platform.
    const SCORE_MIN_INTERVAL_MS = 1000;

    // Relative path: the archive is served from Yandex's own origin, so this
    // resolves to their loader. The absolute S3 URL exists for custom-domain
    // hosting, but absolute origins are discouraged by the platform rules (§11).
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

            // Whole-object mirror of the player's cloud data. See _data section.
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

            // Client-side processing. { signed: true } is only for server-side
            // purchase validation, which the bridge does not do — a game that
            // needs it should init through getNativeSDK's flow instead.
            this.ysdk = await YaGames.init();
            if (!this.ysdk) {
                warn('YaGames.init() resolved empty; fallback mode.');
                return false;
            }
            this._ready = true;

            this._readLocale();
            this._setupHostEvents();

            // Resolve identity before boot completes so the first save read
            // already knows whether it is dealing with a guest.
            await this._resolvePlayer();

            // Any gameplay call issued while the SDK was still loading was a
            // no-op; reconcile now.
            this._syncGameplayState();

            log('Yandex initialized. authorized =', this._authorized, 'lang =', this._lang);
            return true;
        }

        // Resolves with window.YaGames, or null. Reuses an existing tag when
        // index.html already has one, waiting on it if it is async/deferred, and
        // injects one otherwise. Core's init timeout bounds the whole thing.
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

        // ISO 639-1 — a bare two-letter code, never a region-qualified tag.
        // Deliberately returned as-is: a primary subtag is valid BCP-47, so the
        // interface contract holds. Host localization must match on the primary
        // subtag, or it will fall through to its default on every Yandex locale
        // while working fine on the other two portals.
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
            // Signing in or switching accounts makes the SDK resync cloud data,
            // so the cached player and every value read from it are stale from
            // that moment. Drop both and re-resolve rather than writing a stale
            // copy back over the account's real save.
            this._on(this.ysdk.EVENTS && this.ysdk.EVENTS.ACCOUNT_SELECTION_DIALOG_CLOSED, () => {
                this._player = null;
                this._playerPromise = null;
                this._cloud = null;
                this._cloudPromise = null;
                this._resolvePlayer().then(() => this._notifyUserChange());
            });
        }

        _notifyUserChange() {
            // The stable id dedups consecutive sign-in reports (see base); a
            // Yandex player exposes it through getUniqueID().
            const p = this._player;
            let id = null;
            try {
                id = (p && typeof p.getUniqueID === 'function') ? p.getUniqueID() : null;
            } catch (e) { }
            super._notifyUserChange(p, id);
        }

        // ysdk.on() returns an unsubscribe function; keep it for cleanup().
        _on(eventName, handler) {
            if (!eventName || !this.ysdk || typeof this.ysdk.on !== 'function') return () => { };
            try {
                const unsub = this.ysdk.on(eventName, handler);
                if (typeof unsub === 'function') {
                    this._unsubs.push(unsub);
                    return unsub;
                }
                // Older builds return nothing; fall back to off().
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

        // game_api_pause / game_api_resume are plain STRING event names — they
        // are not members of the EVENTS enum, and passing an enum member here
        // subscribes to nothing. They fire for ads, purchase modals, tab
        // switches and window minimize, which is also how the "sound stops when
        // minimized" platform requirement (req. 1.3) is met: the host mutes in
        // onPause. Do not add a page-visibility listener alongside them — it is
        // redundant here and fatal to a shared YouTube build.
        onPause(cb) { return this._on('game_api_pause', cb); }
        onResume(cb) { return this._on('game_api_resume', cb); }

        cleanup() {
            this._unsubscribeAll();
            this._userCallbacks = [];
            if (this._kvWriteTimer) {
                clearTimeout(this._kvWriteTimer);
                this._kvWriteTimer = null;
            }
        }

        // ----------------------------------------------------------- lifecycle

        // No equivalent: Yandex has no "loading has begun" signal.
        loadingStart() { }

        // LoadingAPI.ready() — call only when the game is genuinely interactive
        // and no loading screen remains. Guarded against a second call, which
        // would be meaningless and is not something the platform expects.
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
        // Tracks desired-vs-actual so a duplicate start/start or stop/stop never
        // reaches the platform, and so an ad forces a stop regardless of what
        // the game wants. No rate throttle: unlike CrazyGames, Yandex documents
        // no minimum interval between these calls.

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
                // Roll back so the next sync retries rather than believing a
                // call landed that never did.
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

                // A getPlayer() that never settles must not strand getUser() /
                // loadData() forever — init() already escaped via the handshake
                // timeout, so this only guards the calls that come after.
                timer = setTimeout(() => {
                    log('getPlayer() timed out; treating as guest.');
                    settle(null);
                }, PLAYER_RESOLVE_TIMEOUT_MS);

                Promise.resolve()
                    .then(() => this.ysdk.getPlayer())
                    .then(
                        (p) => settle(p),
                        (e) => {
                            // A guest, or the player API being unavailable, is a
                            // normal state — unauthenticated players must still
                            // be able to play.
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
                // `id` is a Yandex-only extension to the base contract's
                // { username, profilePictureUrl } — a stable unique id for this
                // player. Hosts reading only the two documented keys are
                // unaffected.
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

        // Must only ever be called from a deliberate player action — the
        // platform expects the prompt to be voluntary and explained.
        async signIn() {
            if (!this._ready || !this.ysdk.auth ||
                typeof this.ysdk.auth.openAuthDialog !== 'function') {
                return this._authorized;
            }
            try {
                await this.ysdk.auth.openAuthDialog();
                // The player object from before signing in is stale; so is any
                // data read through it.
                this._player = null;
                this._playerPromise = null;
                this._cloud = null;
                this._cloudPromise = null;
                await this._resolvePlayer();
                // Signing in resynced cloud data and changed the identity; tell
                // subscribers exactly like the account-selection path does.
                this._notifyUserChange();
            } catch (e) {
                // Dismissing the dialog rejects. That is a choice, not an error.
                log('auth dialog dismissed or failed:', e);
            }
            return this._authorized;
        }

        // ---------------------------------------------------------------- data
        //
        // Yandex stores an OBJECT of key-value pairs, not a blob, so the save
        // string lives under `saveKey` inside it and the key-value API shares the
        // same object.
        //
        // Every write sends the WHOLE object. That is deliberate: the docs do
        // not settle whether setData merges with or replaces existing data, and
        // the two behaviours differ only when it matters — a partial write that
        // silently drops the player's other keys. Writing the full mirror is
        // correct under either semantics. It also suits the rate limits (100
        // writes / 5 min) better than a write per key.
        //
        // DURABILITY: unlike CrazyGames, setData() has a real completion signal,
        // so a flush:true that RESOLVES reached the platform. A rejection is
        // caught and logged in _writeCloud rather than propagated — saveData()
        // resolves either way, matching the other adapters — so treat writes as
        // best-effort. `flush: false` queues, which suits incidental key-value
        // churn and is wrong for progress (progress always flushes).

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
            // An immediate flush supersedes any pending debounced one — both
            // send the whole mirror, so the pending write would be redundant.
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

        // Coalesce queued key-value writes into one setData() per burst so
        // incidental churn doesn't burn the 100-writes/5-min budget.
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
            // Progress: flush immediately rather than queueing.
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
            // Queued AND debounced: incidental writes must not burn the flush
            // budget, and bursts are coalesced into one write.
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

        // Wipes the whole stored object, blob and key-value pairs alike. This
        // write resolves, so a hard reset can await it and reload knowing the
        // old save is gone — no durable sentinel needed.
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

            // The platform rejects submissions faster than 1/sec; pace them
            // rather than dropping a score the game just asked to record.
            const wait = SCORE_MIN_INTERVAL_MS - (Date.now() - this._lastScoreAt);
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            this._lastScoreAt = Date.now();

            try {
                await lb.setScore(name, value);
                return true;
            } catch (e) {
                // Guests cannot be ranked; that is expected, not a failure worth
                // surfacing to the player.
                log('setScore failed (guest, or leaderboard "' + name + '" missing):', e);
                return false;
            }
        }

        // --------------------------------------------------------- environment

        getLanguage() {
            // `_lang` is a bare ISO 639-1 code when present ('tr', not 'tr-TR'),
            // and the fallback stays bare for the same reason the mock does: a
            // host that matches the full tag must fail here, not only in
            // production. See the README's locale note.
            return Promise.resolve(this._lang || 'en');
        }

        getEnvironment() {
            return this._ready ? 'yandex' : 'disabled';
        }

        // Sitelock speed bump, matching the other adapters: lenient hostname
        // match, not a security boundary. Yandex serves games from several
        // regional domains and from its S3 archive host.
        isAuthorizedHost() {
            if (isLocalDev()) return true;
            const h = (window.location.hostname || '').toLowerCase();
            return h.includes('yandex') || h.includes('ya.ru');
        }

        /** Tamper-proof clock, in ms. Sync. Use it for daily-reward timers. */
        serverTime() {
            try {
                if (this._ready && typeof this.ysdk.serverTime === 'function') {
                    return this.ysdk.serverTime();
                }
            } catch (e) { }
            return Date.now();
        }

        // ----------------------------------------------------------------- ads
        //
        // Both calls take an object with a nested `callbacks` key — that is what
        // every official sample uses, whatever the reference summary implies.

        _requestAd(type, hooks) {
            let adv = null;
            try { adv = this._ready ? this.ysdk.adv : null; } catch (e) { }

            if (!adv) {
                if (type === 'rewarded') hooks.failed('ad_unavailable');
                else hooks.finished(true);   // a break the game must survive
                return;
            }

            if (type === 'rewarded') {
                // onRewarded is the ONLY proof the reward was earned, and it
                // arrives BEFORE onClose. onClose(wasShown) fires on the
                // abandoned path too, so settling on `wasShown` would pay out
                // for a video the player skipped.
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
                    // May never fire: a throttled or unfilled request goes
                    // straight to onClose(false). Core's request watchdog is the
                    // backstop if neither ever arrives.
                    onOpen: () => hooks.started(),
                    // wasShown is deliberately ignored. A commercial break has
                    // to hand control back either way, and the platform paces
                    // these itself — an unshown ad is not a failure the game
                    // should react to.
                    onClose: () => hooks.finished(true),
                    onError: (err) => hooks.failed(err || 'error')
                }
            });
        }
    }

    // ==========================================================================
    // YandexMock — local development stand-in.
    //
    // /sdk.js only exists inside a Yandex-hosted archive, so the real adapter
    // cannot work on localhost at all. Saves go to browser storage, which this
    // platform permits — a dev convenience only; on Yandex the save lives in the
    // player object.
    // ==========================================================================

    class YandexMock extends BaseSDKAdapter {
        constructor() {
            super();
            this._authorized = true;
        }

        get capabilities() { return CAPABILITIES; }

        getNativeSDK() { return null; }

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

        // Mirrors the real platform: a bare ISO 639-1 code, so host code that
        // only works against full BCP-47 tags fails here in dev rather than in
        // production.
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
