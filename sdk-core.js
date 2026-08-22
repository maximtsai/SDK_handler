/*
 * GameSDK — portable portal bridge, core
 * ======================================
 *
 * Load FIRST, then exactly ONE platform adapter:
 *
 *   <script src="js/sdk-core.js"></script>
 *   <script src="js/platform-crazygames.js"></script>   <!-- or -youtube / -yandex -->
 *
 * Never ship two adapters. YouTube Playables certification greps the bundle AS
 * TEXT, so another adapter's browser-storage/locale references flag the build
 * even though that code could never run there.
 *
 * THIS FILE SHIPS IN EVERY BUNDLE, INCLUDING YOUTUBE. It must never name a
 * banned browser API — persistent storage, page visibility, navigator locale —
 * in code OR in a comment; the scan reads text and cannot tell them apart.
 *
 * WHAT LIVES HERE: the interface, capability map, config, and ad orchestration
 * (dedupe, watchdogs, settle-once, gameplay bracketing). Adapters implement
 * `_requestAd(type, hooks)` and the platform calls — never flow control.
 * Portals fire duplicate callbacks and drop them entirely; that is handled
 * here, in one audited place.
 *
 * WHAT THIS LAYER NEVER DOES: touch the DOM, inject CSS, own a colour, or know
 * a game. Ad transitions, pausing and muting belong to the game — the bridge
 * only says WHEN.
 *
 * CONTRACTS (hold on every platform):
 *  - init() never rejects and never hangs; a dead portal still boots the game.
 *  - showAd() settles EXACTLY ONCE, even if the portal never answers.
 *  - A rewarded ad that did not genuinely play NEVER calls onFinished.
 *  - getLanguage() returns a Promise — YouTube's is async, so all of them are.
 *  - Key-value storage is in-memory by default; adapters override it with cloud storage.
 *
 * USAGE
 *   GameSDK.configure({ gameKey: 'mygame' });
 *   await GameSDK.init();
 *   GameSDK.loadingStart(); ... GameSDK.firstFrameReady(); GameSDK.loadingStop();
 *
 * Unsupported methods are safe no-ops, so game code never guards a call;
 * `supports()` exists to hide UI that would be a dead button.
 *
 * DEV: ?sdk=mock (alias ?sdk=local) forces the mock, ?sdk=real forces the real
 * adapter on localhost. Off localhost the real adapter is ALWAYS chosen —
 * falling back to a mock in production would hand out rewards and misplace saves.
 */
(function () {
    'use strict';

    const VERSION = '1.2.1';

    // ==========================================================================
    // Tuning
    // ==========================================================================

    // No response within this window means the ad never launched (blocked frame,
    // hung SDK) — fail rather than lock the game behind a phantom ad.
    const AD_REQUEST_TIMEOUT_MS = 10000;

    // Ad started but never reported an end. An escape hatch, NOT an ad length
    // limit — firing early costs revenue and discards earned rewards.
    const AD_MAX_DURATION_MS = 180000;

    // Throttle health diagnostics so a failing render loop can't hammer the portal.
    const HEALTH_REPORT_THROTTLE_MS = 5000;

    // ==========================================================================
    // Config
    // ==========================================================================

    const config = {
        // Namespace prefixing the save blob and scoping nukeAllData, so a reset
        // can't wipe another game's keys on a shared origin. Must be set per game.
        gameKey: 'game',
        // Overrides the derived "<gameKey>_save" blob key for pre-existing saves.
        saveKey: null,
        // Stable, non-user-specific id sent with rewarded requests; YouTube requires it,
        // other platforms may ignore it.
        rewardId: 'default-reward',
        // Leaderboard name for setScore() (required by named boards such as Yandex;
        // ignored by platforms with one implicit board). A no-op without it rather
        // than guessing a name that doesn't exist.
        leaderboardName: null,
        debug: false,
        // Dev-only: every ad settles instantly so rewards are testable without a
        // fill. Ignored off localhost — a previous bridge shipped with this on,
        // silently disabling monetization in production.
        skipAdsInDev: false
    };

    function log(msg, ...rest) {
        if (config.debug) console.log('[GameSDK] ' + msg, ...rest);
    }
    function warn(msg, ...rest) {
        console.warn('[GameSDK] ' + msg, ...rest);
    }

    function isLocalDev() {
        const h = (window.location.hostname || '').toLowerCase();
        return h === 'localhost' || h === '127.0.0.1' || h === '';
    }

    // Runs a host callback without letting it take the bridge down (a throwing
    // onStarted must not strand the game paused mid-ad-flow).
    function safe(fn, label, arg) {
        if (typeof fn !== 'function') return;
        try { fn(arg); } catch (e) { warn('host callback "' + label + '" threw:', e); }
    }

    // Records the gameKey used on first storage access, so a late configure()
    // still applies to later calls and the warning fires on the real
    // hazard (an orphaned write) rather than harmless call ordering.
    let storageNamespace = null;
    let warnedDefaultNamespace = false;

    function queryParam(name) {
        try {
            return new URLSearchParams(window.location.search).get(name);
        } catch (e) {
            return null;
        }
    }

    // ==========================================================================
    // Capabilities
    //
    // Game code branches on CAPABILITY, never platform identity — an
    // `if (getEnvironment() === 'youtube')` in a game breaks interchangeability.
    // ==========================================================================

    const ALL_CAPABILITIES = [
        'interstitial',      // non-rewarded ad break
        'rewarded',          // rewarded video
        'adblockProbe',      // can detect an adblocker before requesting
        'cloudSave',         // saveData/loadData reach real cloud storage
        'keyValueStore',     // setItem/getItem persist beyond the session
        'leaderboard',       // setScore goes somewhere
        'signIn',            // an interactive sign-in flow exists
        'userProfile',       // getUser can return a name/avatar
        'loadingSignals',    // loadingStart/loadingStop are meaningful
        'firstFrame',        // firstFrameReady is meaningful
        'gameplaySignals',   // gameplayStart/gameplayStop are meaningful
        'progressReport',    // reportProgress is meaningful
        'happyTime',         // a "celebrate" signal exists
        'hostPause',         // the host can ask the game to pause/resume
        'diagnostics'        // logError/logWarning reach the platform
    ];

    // ==========================================================================
    // BaseSDKAdapter — the union of every platform's interface. Unsupported
    // methods are no-ops/defaults so a host can call anything unconditionally;
    // adapters override what they can genuinely do and declare it in capabilities.
    // ==========================================================================

    class BaseSDKAdapter {
        constructor() {
            this._initPromise = null;
            this._ready = false;
            this._adActive = false;
            // Session-scoped scratch storage for setItem/getItem/removeItem.
            // In-memory because YouTube Playables forbids browser persistence;
            // adapters with real cloud storage override these.
            this._storage = {};
            // Unsubscribe handles and onUserChange subscribers; the base owns
            // the notify/cleanup plumbing.
            this._unsubs = [];
            this._userCallbacks = [];
            // Last user id delivered to onUserChange, so a login reported twice
            // (signIn resolution + portal auth listener) fires once.
            this._lastNotifiedUser = null;
        }

        get capabilities() { return []; }

        supports(feature) {
            return this.capabilities.indexOf(feature) !== -1;
        }

        _subscribe(list, cb) {
            list.push(cb);
            return () => {
                const i = list.indexOf(cb);
                if (i !== -1) list.splice(i, 1);
            };
        }

        // Resolved per access, so configure() applies to every call after it.
        get saveKey() {
            if (storageNamespace === null) storageNamespace = config.gameKey;

            // Forgetting configure() entirely is the dangerous case: every game
            // on a shared origin would share 'game_save' and overwrite each other.
            if (!config.saveKey && config.gameKey === 'game' && !warnedDefaultNamespace) {
                warnedDefaultNamespace = true;
                warn('storage accessed without configure({ gameKey }) — using the ' +
                    'shared default namespace "game_save". Every game on this ' +
                    'origin would share it. Set gameKey before your first save/load.');
            }
            return config.saveKey || (config.gameKey + '_save');
        }

        // --- Lifecycle ---

        // Cap on the whole handshake — a portal promise that never settles would
        // hold the loading screen forever. 0 disables the cap.
        get initTimeoutMs() { return 0; }

        // Resolves true when the SDK is genuinely usable, false for fallback
        // mode. NEVER rejects, never hangs, memoized — all boot-time callers
        // share one initialization. FINAL: adapters implement _boot() instead so
        // these guarantees hold on every platform.
        init() {
            if (this._initPromise) return this._initPromise;

            this._initPromise = new Promise((resolve) => {
                let done = false;
                let timer = null;

                const finish = (ok) => {
                    if (done) return;
                    done = true;
                    if (timer) { clearTimeout(timer); timer = null; }
                    this._ready = ok;
                    resolve(ok);
                };

                if (this.initTimeoutMs > 0) {
                    timer = setTimeout(() => {
                        warn('handshake exceeded ' + this.initTimeoutMs +
                            'ms; booting without waiting for it.');
                        // Keep whatever _boot() achieved; late adapter state may
                        // still populate, but it no longer gates the boot.
                        finish(this._ready === true);
                    }, this.initTimeoutMs);
                }

                Promise.resolve()
                    .then(() => this._boot())
                    .then(
                        (ok) => finish(ok !== false),
                        (e) => {
                            warn('init failed; continuing without the SDK:', e);
                            finish(false);
                        }
                    );
            });

            return this._initPromise;
        }

        // Adapter hook: perform the platform handshake; may throw/reject (core catches).
        _boot() { return true; }

        get ready() { return this._ready; }

        loadingStart() { }
        // On YouTube this stops the platform treating the game as hung, and it
        // MUST precede loadingStop(). Harmless elsewhere.
        firstFrameReady() { }
        // Loading is done and the player can genuinely play — portals dismiss
        // their loading UI here.
        loadingStop() { }

        // Meaningful gameplay started/stopped (menus and ads are NOT gameplay).
        gameplayStart() { }
        gameplayStop() { }

        // A celebratory moment (win, streak); portals use it for ad timing.
        happyTime() { }

        // Overall completion, 0..100 (adapters clamp).
        reportProgress(pct) { }

        // --- Audio ---
        //
        // The host POLLS isAudioEnabled() and/or subscribes; the bridge never
        // reaches into the game's audio system.

        isAudioEnabled() { return true; }
        // cb: (enabled: boolean) => void. Returns an unsubscribe function.
        onAudioEnabledChange(cb) { return () => { }; }

        // --- Host pause/resume ---
        //
        // Where a portal offers these they are the ONLY permitted lifecycle
        // source — don't add page-event listeners alongside them. Where it
        // doesn't (CrazyGames), the portal detects tab/focus changes itself;
        // the game must not emit gameplay signals from its own page events.

        onPause(cb) { return () => { }; }
        onResume(cb) { return () => { }; }

        // --- User identity ---

        // Resolves { username, profilePictureUrl } or null.
        getUser() { return Promise.resolve(null); }
        isUserSignedIn() { return false; }
        // Resolves true if the player is signed in after.
        signIn() { return Promise.resolve(false); }
        // Fires on sign-in/sign-out. Signing in makes cloud data sync in, so any
        // cached save is stale from that moment — hosts should DROP their cache
        // here, never write it back over the cloud copy.
        onUserChange(cb) {
            return this._subscribe(this._userCallbacks, cb);
        }

        // Delivers u to every subscriber; same-id reports are deduped (a login
        // can be signalled twice: by signIn()'s resolution and the portal auth listener).
        _notifyUserChange(u, id) {
            if (id != null && id === this._lastNotifiedUser) return;
            this._lastNotifiedUser = (id == null) ? null : id;
            for (const cb of this._userCallbacks.slice()) {
                safe(cb, 'onUserChange', u || null);
            }
        }

        // --- Score ---

        // Resolves whether the score was accepted; must be a non-negative safe integer.
        setScore(score) { return Promise.resolve(false); }

        // Coerces a score to a non-negative safe integer, or null when invalid.
        _normalizeScore(score) {
            const value = Math.floor(Number(score));
            if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
                return null;
            }
            return value;
        }

        // --- Data persistence (blob) ---
        //
        // DURABILITY: a resolved promise means "handed to the platform", NOT
        // "safely stored" — CrazyGames exposes no completion signal, so a reload
        // can abort an in-flight sync. Anything that MUST survive a reload needs
        // its own durable marker written before unload.

        saveData(data) { return Promise.resolve(); }
        loadData() { return Promise.resolve(null); }

        saveJSON(obj) {
            try {
                return this.saveData(JSON.stringify(obj));
            } catch (e) {
                console.error('[GameSDK] Failed to stringify JSON for save:', e);
                return Promise.resolve();
            }
        }

        // A corrupt save must never crash the game: resolves null, caller starts fresh.
        async loadJSON() {
            try {
                const str = await this.loadData();
                return str ? JSON.parse(str) : null;
            } catch (e) {
                console.error('[GameSDK] Failed to parse JSON from load:', e);
                this.logError();
                return null;
            }
        }

        // --- Data persistence (key-value) ---

        async setItem(key, value) { this._storage[key] = String(value); }
        async getItem(key) {
            const v = this._storage[key];
            return v !== undefined ? v : null;
        }
        async removeItem(key) { delete this._storage[key]; }

        // Override to destroy all save data for this game; only a hard reset
        // should call this.
        async nukeAllData() { this._storage = {}; }

        // --- Locale ---

        // Promise<string>, BCP-47. Async on every platform because YouTube's is.
        getLanguage() { return Promise.resolve('en-US'); }

        // --- Environment ---

        // Escape hatch for platform-only APIs the bridge doesn't wrap; adapters
        // return their raw vendor object (ysdk, CrazyGames.SDK, ytgame).
        getNativeSDK() { return null; }

        // 'local' | '<platform>' | 'disabled'
        getEnvironment() { return 'local'; }

        // Sitelock predicate for content that should only unlock on an
        // authorized host. `ready` is NOT authorization — portal SDKs initialize
        // anywhere, so a rehosted copy passes it trivially.
        isAuthorizedHost() { return true; }

        // --- Time ---

        // Wall-clock ms; platforms with a tamper-proof server clock (Yandex)
        // override. Kept on the base so every build can call it unconditionally.
        serverTime() { return Date.now(); }

        // --- Ads ---
        //
        // showAd(type, callbacks, rewardId) is FINAL — adapters implement _requestAd().
        //   type: 'midgame' | 'rewarded'
        //   rewardId: which reward this is ('double-coins-v1'). Required by
        //     YouTube and must be stable and non-user-specific — never a player
        //     id, session id or timestamp. Pass distinct ids per reward; defaults
        //     to config.rewardId for games with one.
        //   callbacks: {
        //     onStarted:  ()      the ad is up (or about to be). Pause and mute here.
        //     onFinished: ()      it played; for 'rewarded' the reward is EARNED.
        //     onError:    (err)   resume and unmute; grant NOTHING.
        //   }
        // Resolves true only when the ad completed. Always settles, never rejects.
        //
        // onStarted fires on the real signal where one exists (CrazyGames
        // adStarted, Yandex onOpen) and right before the request where it
        // doesn't (YouTube) — pause/mute safely; it may fire slightly early.

        showAd(type = 'midgame', callbacks = {}, rewardId) {
            const rewarded = type === 'rewarded';
            const kind = rewarded ? 'rewarded' : 'midgame';
            const reward = rewardId || config.rewardId;

            if (!this.supports(rewarded ? 'rewarded' : 'interstitial')) {
                log('showAd(' + kind + ') — unsupported on ' + this.getEnvironment());
                safe(callbacks.onError, 'onError', 'unsupported');
                return Promise.resolve(false);
            }

            if (this._adActive) {
                // Never swallow the callback — progression often rides on it,
                // and dropping it strands the player on a dead button.
                warn('ad already in progress; ignoring duplicate ' + kind + ' request.');
                safe(callbacks.onError, 'onError', 'busy');
                return Promise.resolve(false);
            }

            // Dev bypass, hard-gated to localhost so it cannot ship live.
            if (config.skipAdsInDev && isLocalDev()) {
                log('skipAdsInDev — ' + kind + ' resolved instantly as success.');
                safe(callbacks.onStarted, 'onStarted');
                safe(callbacks.onFinished, 'onFinished');
                return Promise.resolve(true);
            }

            return new Promise((resolve) => {
                let settled = false;
                let started = false;
                let requestTimer = null;
                let durationTimer = null;

                const clearTimers = () => {
                    if (requestTimer) { clearTimeout(requestTimer); requestTimer = null; }
                    if (durationTimer) { clearTimeout(durationTimer); durationTimer = null; }
                };

                // Runs exactly once on every exit path. Portals fire callbacks
                // twice and drop them entirely; both are absorbed here.
                const settle = (ok, err) => {
                    if (settled) return;
                    settled = true;
                    clearTimers();
                    this._adActive = false;
                    // Gameplay was stopped at request time, so every exit path hands it back.
                    this._onAdActiveChange(false);

                    if (ok) safe(callbacks.onFinished, 'onFinished');
                    else safe(callbacks.onError, 'onError', err);
                    resolve(ok);
                };

                const hooks = {
                    // The ad is on screen: swap the request watchdog for the
                    // much longer duration one.
                    started: () => {
                        if (started || settled) return;
                        started = true;
                        if (requestTimer) { clearTimeout(requestTimer); requestTimer = null; }
                        durationTimer = setTimeout(() => {
                            warn(kind + ' ad exceeded max duration with no end event; resuming.');
                            settle(false, 'timeout');
                        }, AD_MAX_DURATION_MS);
                        safe(callbacks.onStarted, 'onStarted');
                    },
                    // earned is only consulted for rewarded ads; a midgame break
                    // always continues the game, filled or not.
                    finished: (earned) => {
                        if (!rewarded) { settle(true); return; }
                        // Strict identity on purpose: an unexpected return shape
                        // must DENY the reward, not grant it for free.
                        if (earned === true) settle(true);
                        else settle(false, 'ad_not_earned');
                    },
                    failed: (err) => {
                        log(kind + ' ad failed or was skipped:', err);
                        settle(false, err || 'error');
                    }
                };

                // Portals expect gameplay stopped when the ad is REQUESTED, not
                // once it starts playing.
                this._adActive = true;
                this._onAdActiveChange(true);

                // Request watchdog; canceled by hooks.started().
                requestTimer = setTimeout(() => {
                    warn(kind + ' ad request timed out with no response; continuing.');
                    settle(false, 'timeout');
                }, AD_REQUEST_TIMEOUT_MS);

                try {
                    this._requestAd(kind, hooks, reward);
                } catch (e) {
                    warn('_requestAd threw synchronously:', e);
                    settle(false, e);
                }
            });
        }

        // Adapter hook: issue the platform ad call, translate the result into
        // hooks.started()/finished(earned)/failed(err). Core owns dedupe,
        // watchdogs and settle-once; catch any promise into hooks.failed.
        _requestAd(type, hooks, rewardId) { hooks.failed('unsupported'); }

        // Adapter hook: an ad flow opened or closed. Adapters with gameplay
        // signals use this to keep the portal seeing gameplay stopped throughout.
        _onAdActiveChange(active) { }

        hasAdblock() { return Promise.resolve(false); }

        // --- Health / diagnostics ---
        //
        // Best-effort and payload-free; must never throw — diagnostics that
        // crash the game are worse than no diagnostics.

        logError() { }
        logWarning() { }

        // --- Teardown ---

        _unsubscribeAll() {
            for (const unsub of this._unsubs) {
                try { unsub(); } catch (e) { warn('cleanup unsub failed:', e); }
            }
            this._unsubs = [];
        }

        // Releases everything the base owns; adapters with their own listeners
        // call super.cleanup() then tear down platform-specific ones.
        cleanup() {
            this._unsubscribeAll();
            this._userCallbacks = [];
            this._lastNotifiedUser = null;
        }
    }

    // ==========================================================================
    // Registry
    //
    // Core is loaded first and exposes a stub; the adapter file calls _register()
    // at its bottom, which picks real-vs-mock and swaps in the live instance.
    // init() is deliberately NOT auto-invoked — the host must configure() first.
    // ==========================================================================

    function selectAdapter(reg) {
        const force = queryParam('sdk');

        if (force === 'mock' || force === 'local') return new reg.Mock();
        if (force === 'real' || force === reg.name) return new reg.Adapter();

        // Off localhost the real adapter always wins, even if the portal SDK
        // never loaded — picking on the SDK global alone would drop an adblocked
        // build onto the mock, whose showAd resolves instantly and hands out
        // every reward for free. Adapters degrade gracefully instead.
        if (!isLocalDev()) return new reg.Adapter();

        return new reg.Mock();
    }

    function install(instance, reg) {
        instance.VERSION = VERSION;
        instance.platform = reg.name;
        instance.configure = configure;
        instance._register = register;
        instance._config = config;
        window.GameSDK = instance;

        log('v' + VERSION + ' — ' + reg.name + ' (' +
            (instance instanceof reg.Adapter ? 'live' : 'mock') + ')');
        return instance;
    }

    // Safe at any point, including after init() — saveKey resolves per access,
    // so a later gameKey applies to subsequent storage calls; it just can't fix
    // data already written under another namespace (the warning below).
    function configure(opts) {
        if (!opts) return window.GameSDK;
        Object.keys(opts).forEach((k) => {
            if (k in config) config[k] = opts[k];
            else warn('configure(): unknown option "' + k + '" ignored.');
        });

        if (storageNamespace !== null && config.gameKey !== storageNamespace) {
            warn('gameKey changed to "' + config.gameKey + '" after storage was ' +
                'already accessed under "' + storageNamespace + '". Later calls use ' +
                'the new namespace; anything written under the old one is orphaned. ' +
                'Call configure({ gameKey }) before your first save or load.');
        }
        return window.GameSDK;
    }

    // CrazyGames expects init to fire as this file parses, so the handshake
    // overlaps asset loading — but configure({ gameKey }) must land first. A
    // macrotask satisfies both: the host's synchronous configure() in index.html
    // has already run, and memoized init() reuses this handshake rather than
    // starting a second one.
    function autoInit() {
        setTimeout(function () {
            try { window.GameSDK.init(); } catch (e) { warn('auto-init failed:', e); }
        }, 0);
    }

    function register(reg) {
        if (!reg || typeof reg.Adapter !== 'function') {
            warn('_register() needs { name, Adapter, Mock }.');
            return window.GameSDK;
        }
        if (!reg.Mock) reg.Mock = reg.Adapter;
        if (window.GameSDK && window.GameSDK.ready !== undefined && window.GameSDK.platform !== 'none') {
            // Two adapters in one build — not just wasteful but breaks YouTube certification.
            warn('a second adapter (' + reg.name + ') registered over ' +
                window.GameSDK.platform + '. Ship exactly ONE adapter per build.');
        }
        const instance = install(selectAdapter(reg), reg);
        autoInit();
        return instance;
    }

    // Stub, live until an adapter registers. Every method present so a host
    // calling in before the adapter file parses gets a no-op, not a TypeError.
    const stub = new BaseSDKAdapter();
    stub.getEnvironment = () => 'disabled';
    install(stub, { name: 'none', Adapter: BaseSDKAdapter, Mock: BaseSDKAdapter });

    // ==========================================================================
    // Uncaught error reporting
    //
    // Routes uncaught errors and unhandled rejections into whatever diagnostics
    // the platform offers; nothing is swallowed, details still reach the console.
    // Self-throttled; see HEALTH_REPORT_THROTTLE_MS.
    // ==========================================================================

    let lastHealthReport = 0;
    const reportError = () => {
        const now = Date.now();
        if (now - lastHealthReport < HEALTH_REPORT_THROTTLE_MS) return;
        lastHealthReport = now;
        try { window.GameSDK.logError(); } catch (e) { }
    };
    window.addEventListener('error', reportError);
    window.addEventListener('unhandledrejection', reportError);

    // Exposed for adapters (separate files, so they need the shared helpers)
    // and for the conformance harness.
    window.GameSDKCore = {
        VERSION,
        BaseSDKAdapter,
        ALL_CAPABILITIES,
        config,
        log,
        warn,
        safe,
        isLocalDev,
        queryParam
    };
})();
