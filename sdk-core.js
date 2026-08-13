/*
 * GameSDK — portable portal bridge, core
 * ======================================
 *
 * Load this file FIRST, then exactly ONE platform adapter:
 *
 *   <script src="js/sdk-core.js"></script>
 *   <script src="js/platform-crazygames.js"></script>   <!-- or -youtube / -yandex -->
 *
 * Never ship two adapters in one build. Beyond the wasted bytes, YouTube
 * Playables certification greps the whole bundle AS TEXT, so the CrazyGames
 * adapter's browser-storage and browser-locale references would flag a
 * Playables build even though that code could never run there.
 *
 * THIS FILE SHIPS IN EVERY BUNDLE, INCLUDING YOUTUBE. It must therefore never
 * name a banned browser API — the persistent storage ones, the page visibility
 * ones, or the navigator locale properties — in code OR in a comment. The scan
 * reads text and cannot tell the two apart. See platform-youtube.js.
 *
 * WHAT LIVES HERE
 * ---------------
 * Everything that is identical on every portal: the interface, the capability
 * map, config, and the ad orchestration (dedupe, both watchdogs, settle-once,
 * gameplay bracketing). Adapters implement `_requestAd(type, hooks)` and the
 * platform calls — never the flow control. Portals fire duplicate callbacks and
 * drop callbacks entirely; that has to be handled in one audited place.
 *
 * WHAT THIS LAYER NEVER DOES
 * --------------------------
 * Touch the DOM, inject CSS, own a colour, or know a game. Ad transitions,
 * pausing and muting belong to the game — the bridge only says WHEN.
 *
 * CONTRACTS THAT HOLD ON EVERY PLATFORM
 * -------------------------------------
 *  - init() never rejects and never hangs. A dead portal still boots the game.
 *  - showAd() settles EXACTLY ONCE, always, even if the portal never answers.
 *  - A rewarded ad that did not genuinely play NEVER calls onFinished.
 *  - getLanguage() returns a Promise (YouTube's is async, so all of them are —
 *    otherwise the return type changes per platform and callers break only
 *    there, in the one environment that is hardest to debug).
 *  - Key-value storage is in-memory by default (YouTube Playables forbids every
 *    browser persistence mechanism); adapters override upward to cloud storage.
 *
 * USAGE
 * -----
 *   GameSDK.configure({ gameKey: 'mygame' });
 *   await GameSDK.init();
 *   GameSDK.loadingStart();
 *   ...load...
 *   GameSDK.firstFrameReady();
 *   GameSDK.loadingStop();
 *
 * Methods a platform doesn't support are safe no-ops, so game code never needs
 * to guard a call. `supports()` exists to hide UI that would be a dead button:
 *
 *   if (GameSDK.supports('leaderboard')) showLeaderboardButton();
 *
 * DEV
 * ---
 *   ?sdk=mock         force the mock adapter (alias: ?sdk=local)
 *   ?sdk=real         force the real adapter on localhost
 * Off localhost the real adapter is ALWAYS chosen. Falling back to a mock in
 * production would hand out every rewarded prize for free and write saves to
 * the wrong place.
 */
(function () {
    'use strict';

    const VERSION = '1.2.1';

    // ==========================================================================
    // Tuning
    // ==========================================================================

    // No response to an ad request within this window means it never launched
    // (blocked frame, hung SDK, no callback at all). Treat it as a failure
    // rather than leaving the game locked behind an ad that will never appear.
    const AD_REQUEST_TIMEOUT_MS = 10000;

    // The ad started but never reported an end. Generous on purpose: this is a
    // deadlock escape hatch, NOT an ad length limit. A real ad plus its end card
    // legitimately runs a while, and firing this early costs revenue and — on
    // rewarded — discards a reward the player actually earned.
    const AD_MAX_DURATION_MS = 180000;

    // Health diagnostics throttle: an error inside a 60fps render loop must not
    // hammer the portal (they rate-limit on their end too).
    const HEALTH_REPORT_THROTTLE_MS = 5000;

    // ==========================================================================
    // Config
    // ==========================================================================

    const config = {
        // Storage namespace for this game. MUST be set per game: it prefixes the
        // save blob and scopes nukeAllData, so a reset can't wipe another game's
        // keys on a shared origin.
        gameKey: 'game',
        // Overrides the derived "<gameKey>_save" blob key, for games that
        // already have saves under a different name.
        saveKey: null,
        // Stable, non-user-specific identifier sent with rewarded ad requests.
        // YouTube requires one; other platforms ignore it.
        rewardId: 'default-reward',
        // Which leaderboard setScore() submits to. Required by platforms whose
        // leaderboards are named (Yandex); ignored where the platform has a
        // single implicit board (YouTube). setScore() is a no-op without it
        // rather than guessing a name that does not exist in the console.
        leaderboardName: null,
        debug: false,
        // Dev-only ad bypass: every ad settles instantly as a success so reward
        // buttons are testable without a fill. IGNORED off localhost — a
        // previous bridge shipped with this left on, silently disabling
        // monetization in production, and that must not be possible here.
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

    // Runs a host callback without letting it take the bridge down: a throwing
    // onStarted must not strand the game paused with the ad flow half-finished.
    function safe(fn, label, arg) {
        if (typeof fn !== 'function') return;
        try { fn(arg); } catch (e) { warn('host callback "' + label + '" threw:', e); }
    }

    // The gameKey in force the first time storage was addressed. `saveKey` is a
    // lazy getter, so a late configure() still applies to every later call —
    // what cannot be fixed retroactively is data already written under a
    // different namespace. This tracks that, so the warning below fires on the
    // real hazard (an orphaned write) instead of on harmless call ordering.
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
    // Game code branches on CAPABILITY, never on platform identity. Writing
    // `if (getEnvironment() === 'youtube')` in a game is the one thing that
    // makes these builds stop being interchangeable.
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
    // BaseSDKAdapter — the union of every platform's interface.
    //
    // Unsupported methods are no-ops or documented defaults, so a host can call
    // anything unconditionally. Adapters override what they can genuinely do and
    // declare it in `capabilities`.
    // ==========================================================================

    class BaseSDKAdapter {
        constructor() {
            this._initPromise = null;
            this._ready = false;
            this._adActive = false;
            // Session-scoped scratch storage backing setItem/getItem/removeItem.
            // In-memory because YouTube Playables forbids every browser
            // persistence mechanism; adapters with real cloud storage override
            // these upward.
            this._storage = {};
        }

        // Platforms declare their own. Empty here: the base is a null portal.
        get capabilities() { return []; }

        supports(feature) {
            return this.capabilities.indexOf(feature) !== -1;
        }

        // Resolved fresh on every access, so configure() applies to every call
        // that follows it — including after init().
        get saveKey() {
            if (storageNamespace === null) storageNamespace = config.gameKey;

            // Forgetting configure() entirely is the dangerous case: every game
            // on a shared origin then reads and writes the same 'game_save',
            // and they silently overwrite each other's progress.
            if (!config.saveKey && config.gameKey === 'game' && !warnedDefaultNamespace) {
                warnedDefaultNamespace = true;
                warn('storage accessed without configure({ gameKey }) — using the ' +
                    'shared default namespace "game_save". Every game on this ' +
                    'origin would share it. Set gameKey before your first save/load.');
            }
            return config.saveKey || (config.gameKey + '_save');
        }

        // --- Lifecycle ---

        // Cap on the whole handshake. Every step of a portal handshake is a
        // promise the portal owns, and one that never settles would hold the
        // loading screen up forever. 0 disables the cap (for adapters whose
        // init is synchronous and cannot hang).
        get initTimeoutMs() { return 0; }

        // Resolves true when the platform SDK is genuinely usable, false when
        // the game should run in fallback mode. NEVER rejects, never hangs, and
        // is memoized — the several callers that each await it at boot share one
        // initialization.
        //
        // FINAL: adapters implement _boot() instead, so the memoization, the
        // timeout and the never-reject guarantee hold on every platform rather
        // than being re-derived (and forgotten) in each one.
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
                        // Preserve whatever _boot() has already achieved. A late
                        // arrival still populates state and can still flip
                        // _ready true — it just stops gating the boot.
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

        // Adapter hook: perform the platform handshake and resolve truthy when
        // the SDK is genuinely usable. May throw or reject — core catches.
        _boot() { return true; }

        // True only after init() resolved AND the SDK proved functional.
        get ready() { return this._ready; }

        // Asset loading has begun.
        loadingStart() { }
        // The first visible frame has rendered. On YouTube this is what stops
        // the platform treating the game as hung, and it MUST precede
        // loadingStop(). Harmless everywhere else.
        firstFrameReady() { }
        // Loading is done and the player can genuinely play. Only call it when
        // that is true — portals dismiss their own loading UI here.
        loadingStop() { }

        // Meaningful gameplay started/stopped (menus and ads are NOT gameplay).
        gameplayStart() { }
        gameplayStop() { }

        // A celebratory moment (win, streak). Portals use it for ad timing.
        happyTime() { }

        // Overall completion, 0..100. Adapters clamp.
        reportProgress(pct) { }

        // --- Audio ---
        //
        // The host POLLS isAudioEnabled() and/or subscribes. The bridge never
        // reaches into the game's audio system.

        isAudioEnabled() { return true; }
        // cb: (enabled: boolean) => void. Returns an unsubscribe function.
        onAudioEnabledChange(cb) { return () => { }; }

        // --- Host pause/resume ---
        //
        // Only some portals can ask the game to pause. Where a portal offers
        // these, they are the ONLY permitted lifecycle source — do not add a
        // browser-level backgrounding listener alongside them. Where a portal
        // does not (CrazyGames), it detects tab and focus changes itself, and
        // the game must not signal gameplay stop from its own page events.

        onPause(cb) { return () => { }; }
        onResume(cb) { return () => { }; }

        // --- User identity ---

        // Resolves { username, profilePictureUrl } or null.
        getUser() { return Promise.resolve(null); }
        isUserSignedIn() { return false; }
        // Interactive sign-in. Resolves true if the player is signed in after.
        signIn() { return Promise.resolve(false); }
        // Fires on sign-in/sign-out. Signing in makes cloud data sync in, so any
        // save cached in memory is stale from that moment — hosts should DROP
        // their cache here, never write it back over the cloud copy.
        onUserChange(cb) { return () => { }; }

        // --- Score ---

        // Submits a score to the platform leaderboard. Resolves whether it was
        // accepted. Value must be a non-negative safe integer.
        setScore(score) { return Promise.resolve(false); }

        // --- Data persistence (blob) ---
        //
        // DURABILITY: a resolved promise means "handed to the platform", NOT
        // "safely stored". Some portals (CrazyGames) expose no completion signal
        // at all, so awaiting this tells you nothing there — a reload can still
        // abort an in-flight sync. Anything that MUST survive a reload needs its
        // own durable marker written before unload. Adapters document which
        // guarantee they actually provide.

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

        // A corrupt save must never crash the game: resolves null and the caller
        // starts fresh.
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

        // Destroys every trace of this game's save — blob, key-value pairs, any
        // local mirror. Only a hard reset should call this.
        async nukeAllData() { this._storage = {}; }

        // --- Locale ---

        // Promise<string>, BCP-47. Async on every platform because YouTube's is
        // async; see the header.
        getLanguage() { return Promise.resolve('en-US'); }

        // --- Environment ---

        // 'local' | '<platform>' | 'disabled'
        getEnvironment() { return 'local'; }

        // Sitelock predicate for content that should only unlock on an
        // authorized host. `ready` is NOT an authorization signal — portal SDKs
        // generally initialize anywhere, so a rehosted copy passes it trivially.
        isAuthorizedHost() { return true; }

        // --- Ads ---
        //
        // showAd(type, callbacks, rewardId) is FINAL — adapters implement
        // _requestAd().
        //
        //   type: 'midgame' | 'rewarded'
        //   rewardId: identifies WHICH reward this is ('double-coins-v1').
        //     Required by YouTube and it must be stable and non-user-specific —
        //     never a player id, a session id or a timestamp. A game with two
        //     distinct rewards must pass two distinct ids, which is why this is
        //     per call and not a single configured value. Defaults to
        //     config.rewardId for games that only have one.
        //   callbacks: {
        //     onStarted:  ()      the ad is up (or about to be — see below).
        //                         Pause and mute here.
        //     onFinished: ()      it played. For 'rewarded' the reward is EARNED.
        //     onError:    (err)   resume and unmute, and grant NOTHING.
        //   }
        //   Resolves true only when the ad completed (reward earned, if
        //   rewarded). Always settles; never rejects.
        //
        // onStarted fires on the real signal where a platform has one
        // (CrazyGames adStarted, Yandex onOpen) and immediately before the
        // request where it doesn't (YouTube). Treat it as "may fire slightly
        // before the ad is visible" and be safe to pause early.

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
                // Never swallow the callback: progression often rides on it, and
                // dropping it strands the player on a dead button.
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

                // Runs exactly once on every exit path — completed, failed,
                // errored, or either watchdog. Portals are known to fire their
                // callbacks twice and to drop them entirely; both are absorbed
                // here so no caller waits on something that never arrives.
                const settle = (ok, err) => {
                    if (settled) return;
                    settled = true;
                    clearTimers();
                    this._adActive = false;
                    // Unconditional: gameplay was stopped from the moment the ad
                    // was requested, so every exit path must hand it back.
                    this._onAdActiveChange(false);

                    if (ok) safe(callbacks.onFinished, 'onFinished');
                    else safe(callbacks.onError, 'onError', err);
                    resolve(ok);
                };

                const hooks = {
                    // The ad is on screen. Swaps the request watchdog for the
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
                    // earned is only consulted for rewarded ads. A midgame break
                    // always continues the game, filled or not.
                    finished: (earned) => {
                        if (!rewarded) { settle(true); return; }
                        // Strict identity on purpose: an unexpected future return
                        // shape must DENY the reward, not grant it for free.
                        if (earned === true) settle(true);
                        else settle(false, 'ad_not_earned');
                    },
                    failed: (err) => {
                        log(kind + ' ad failed or was skipped:', err);
                        settle(false, err || 'error');
                    }
                };

                // Portals expect gameplay to be stopped when the ad is
                // REQUESTED, not once it starts playing.
                this._adActive = true;
                this._onAdActiveChange(true);

                // Watchdog 1: the request never launched at all. Cancelled by
                // hooks.started().
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

        // Adapter hook: issue the platform ad call and translate its result into
        // hooks.started() / hooks.finished(earned) / hooks.failed(err). Do NOT
        // implement flow control here — core owns dedupe, watchdogs and
        // settle-once. Any promise must be caught and routed to hooks.failed.
        _requestAd(type, hooks, rewardId) { hooks.failed('unsupported'); }

        // Adapter hook: an ad flow opened or closed. Adapters with gameplay
        // signals use this to force the portal to see gameplay stopped for the
        // duration, then restore whatever the game wanted.
        _onAdActiveChange(active) { }

        hasAdblock() { return Promise.resolve(false); }

        // --- Health / diagnostics ---
        //
        // Best-effort and payload-free: they only signal that something went
        // wrong. Must never throw — diagnostics that crash the game are worse
        // than no diagnostics.

        logError() { }
        logWarning() { }

        // --- Teardown ---

        // Releases every listener this adapter registered.
        cleanup() { }
    }

    // ==========================================================================
    // Registry
    //
    // Core is loaded first and exposes a stub. The platform adapter file calls
    // _register() at its bottom, which picks real-vs-mock and swaps the stub for
    // the live instance. init() is deliberately NOT auto-invoked: the host must
    // be able to configure({ gameKey }) first.
    // ==========================================================================

    function selectAdapter(reg) {
        const force = queryParam('sdk');

        if (force === 'mock' || force === 'local') return new reg.Mock();
        if (force === 'real' || force === reg.name) return new reg.Adapter();

        // Off localhost the real adapter always wins, even if the portal SDK
        // never loaded. Selecting on the presence of the SDK global alone would
        // silently drop an adblocked build onto the mock — whose showAd resolves
        // instantly, handing out every rewarded prize for free and writing saves
        // to the wrong place. Adapters degrade gracefully instead.
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

    // Safe to call at any point, including after init() — `saveKey` is resolved
    // per access, so a later gameKey applies to every subsequent storage call.
    // The one thing it cannot fix is data already written under another
    // namespace, which is what the warning below is for.
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

    // CrazyGames expects initialization to fire as this file parses, so the
    // handshake overlaps asset loading instead of waiting behind it. But
    // configure({ gameKey }) has to land first, or the first storage read uses
    // the wrong namespace. Deferring to a macrotask satisfies both: the host's
    // synchronous configure() call in index.html has already run by the time
    // this fires, and init() is memoized, so the host's own `await init()`
    // reuses this exact handshake rather than starting a second one.
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
            // Two adapters in one build. See the header for why this is not just
            // wasteful but actively breaks YouTube certification.
            warn('a second adapter (' + reg.name + ') registered over ' +
                window.GameSDK.platform + '. Ship exactly ONE adapter per build.');
        }
        const instance = install(selectAdapter(reg), reg);
        autoInit();
        return instance;
    }

    // Stub, live until an adapter registers. Every method is present so a host
    // that calls into it before the adapter file has parsed gets a no-op rather
    // than a TypeError.
    const stub = new BaseSDKAdapter();
    stub.getEnvironment = () => 'disabled';
    install(stub, { name: 'none', Adapter: BaseSDKAdapter, Mock: BaseSDKAdapter });

    // ==========================================================================
    // Uncaught error reporting
    //
    // Routes uncaught errors and unhandled rejections into whatever diagnostics
    // the platform offers. Nothing is swallowed — details still reach the
    // console as usual. Self-throttled; see HEALTH_REPORT_THROTTLE_MS.
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

    // Exposed for adapters (which are separate files, so they need the shared
    // helpers) and for the conformance harness.
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
