/*
 * GameSDK — CrazyGames adapter
 * ============================
 *
 * Requires sdk-core.js FIRST:
 *
 *   <script src="js/sdk-core.js"></script>
 *   <script src="js/platform-crazygames.js"></script>
 *
 * No vendor <script> tag is needed — this adapter loads the portal SDK itself
 * (and reuses an existing tag if index.html already has one).
 *
 * Docs: https://docs.crazygames.com/sdk/
 * SDK:  https://sdk.crazygames.com/crazygames-sdk-v3.js
 *
 * Module map (window.CrazyGames.SDK):
 *   .game        loadingStart, loadingStop, gameplayStart, gameplayStop,
 *                happytime, reportGameCompletedPercentage, settings,
 *                addSettingsChangeListener / removeSettingsChangeListener
 *   .ad          requestAd(type, {adStarted, adFinished, adError}), hasAdblock
 *   .user        getUser, isUserAccountAvailable, addAuthListener, systemInfo
 *   .data        getItem, setItem, removeItem, clear   (cloud-synced)
 *   .environment 'local' | 'crazygames' | 'disabled'
 *
 * Not available here: leaderboards, first-frame signal, host pause/resume
 * events (the game handles backgrounding itself via visibilitychange), and
 * platform diagnostics. Those are declared absent in `capabilities` rather than
 * faked.
 */
(function () {
    'use strict';

    const core = window.GameSDKCore;
    if (!core) {
        console.error('[GameSDK] platform-crazygames.js requires sdk-core.js to be loaded first.');
        return;
    }
    const { BaseSDKAdapter, log, warn, isLocalDev } = core;

    // Cap on the whole handshake — script load, SDK.init(), hasAdblock(),
    // getUser(). Every step is a promise the SDK owns, and one that never
    // settles would hold the loading screen up forever. Late arrivals still
    // populate state; they just stop gating the boot.
    const SDK_INIT_TIMEOUT_MS = 8000;

    // The SDK throttles gameplayStart/gameplayStop at 1s PER METHOD and silently
    // DISCARDS calls inside that window, so pacing has to happen on our side or
    // a quick menu toggle leaves CrazyGames believing gameplay is still running.
    const GAMEPLAY_CALL_THROTTLE_MS = 1100;

    const SDK_SCRIPT_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';

    const CAPABILITIES = [
        'interstitial', 'rewarded', 'adblockProbe',
        'cloudSave', 'keyValueStore',
        'signIn', 'userProfile',
        'loadingSignals', 'gameplaySignals',
        'progressReport', 'happyTime'
    ];

    // ==========================================================================
    // CrazyGamesAdapter
    // ==========================================================================

    class CrazyGamesAdapter extends BaseSDKAdapter {
        constructor() {
            super();
            this.cg = null;

            this._muted = false;
            this._audioCallbacks = [];
            this._boundSettingsListener = null;
            this._boundAuthListener = null;

            this._userSignedIn = false;
            this._locale = null;
            this._hasAdblock = false;

            // Loading events raised before init() resolved, replayed once it
            // does. They almost always fire while the SDK is still in flight.
            this._pendingLoading = [];
            this._loadingStarted = false;
            this._loadingFinished = false;

            // Gameplay signalling. `_gameplayWanted` is what the GAME wants;
            // `_sdkGameplayRunning` is what the SDK has actually been told. They
            // diverge during ads and while a throttled call waits to re-issue.
            this._gameplayWanted = false;
            this._sdkGameplayRunning = false;
            this._gameplaySyncTimer = null;
            this._lastGameplayCallAt = { start: 0, stop: 0 };
        }

        get capabilities() { return CAPABILITIES; }

        /** Escape hatch for CrazyGames-only APIs (user token, friends, account
         *  link prompt, setGameContext, room/multiplayer data) that the bridge
         *  deliberately does not wrap. */
        getNativeSDK() { return this.cg; }

        // ---------------------------------------------------------------- init
        //
        // Core owns memoization, the timeout and the never-reject guarantee; the
        // handshake itself is all that lives here.

        get initTimeoutMs() { return SDK_INIT_TIMEOUT_MS; }

        async _boot() {
            const sdk = await this._loadSdkScript();
            if (!sdk || typeof sdk.init !== 'function') {
                warn('CrazyGames SDK not usable; fallback mode.');
                return false;
            }

            // Guard a synchronous throw: if init() throws rather than returning
            // a rejected promise, the await below is never reached.
            let initResult;
            try {
                initResult = sdk.init();
            } catch (e) {
                warn('SDK.init() threw synchronously; fallback mode.', e);
                return false;
            }
            await initResult;

            // v3's init() resolves on EVERY host: on CrazyGames it builds the
            // real modules, but on a rehosted domain or in server-side "fail
            // mode" it resolves into a stub whose module getters THROW on
            // access. Probe before trusting it, or `ready` would be true while
            // every SDK call blows up during boot.
            if (!this._probeFunctional(sdk)) {
                warn('SDK loaded but not functional (stub/rehosted); fallback mode.');
                return false;
            }

            this.cg = sdk;
            this._ready = true;

            this._setupSettingsListener();
            this._setupAuthListener();
            this._readLocale();

            // Replay loading events issued while the SDK was still coming down
            // the wire, then reconcile any gameplay calls that no-oped.
            this._flushPendingLoading();
            this._syncGameplayState();

            // Resolved before boot completes so the first ad decision and the
            // first save read already know what they are dealing with.
            await this._probeAdblock();
            await this._probeUser();

            log('CrazyGames initialized. environment =', this.getEnvironment());
            return true;
        }

        // Resolves with window.CrazyGames.SDK, or null. Reuses an existing tag
        // when index.html already has one (waiting on it if it is async or
        // deferred) and injects one otherwise. The init timeout bounds this — a
        // CDN that never answers cannot hang the boot.
        _loadSdkScript() {
            return new Promise((resolve) => {
                const existing = () => (window.CrazyGames && window.CrazyGames.SDK) || null;
                if (existing()) { resolve(existing()); return; }

                let tag = null;
                try {
                    tag = document.querySelector('script[src*="crazygames-sdk"]');
                } catch (e) { }

                if (tag) {
                    // The tag is there but the global isn't yet, so it is still
                    // loading. Ride its events rather than injecting a duplicate.
                    tag.addEventListener('load', () => resolve(existing()));
                    tag.addEventListener('error', () => {
                        warn('existing CrazyGames SDK tag failed to load.');
                        resolve(null);
                    });
                    return;
                }

                const script = document.createElement('script');
                script.src = SDK_SCRIPT_URL;
                script.async = true;
                script.onload = () => resolve(existing());
                script.onerror = () => {
                    warn('CrazyGames SDK script failed to load (adblock?); fallback mode.');
                    resolve(null);
                };
                document.head.appendChild(script);
            });
        }

        // Module getters throw on a stubbed SDK, so this read is guarded.
        _probeFunctional(sdk) {
            try {
                const game = sdk.game;
                return !!(game &&
                    typeof game.gameplayStart === 'function' &&
                    typeof game.loadingStart === 'function');
            } catch (e) {
                return false;
            }
        }

        async _probeAdblock() {
            try {
                if (this.cg.ad && typeof this.cg.ad.hasAdblock === 'function') {
                    this._hasAdblock = !!(await this.cg.ad.hasAdblock());
                }
            } catch (e) {
                log('hasAdblock check failed:', e);
            }
        }

        async _probeUser() {
            try {
                const user = this.cg.user;
                if (!user || typeof user.getUser !== 'function') return;
                // Accounts can be unavailable on third-party embeds; treat that
                // as signed-out rather than probing getUser() blind.
                if (user.isUserAccountAvailable === false) {
                    this._userSignedIn = false;
                    return;
                }
                this._userSignedIn = !!(await user.getUser());
            } catch (e) {
                this._userSignedIn = false;
            }
        }

        // ----------------------------------------------------------- listeners

        _setupSettingsListener() {
            let game = null;
            try { game = this.cg.game; } catch (e) { return; }
            if (!game) return;

            try {
                this._muted = !!(game.settings && game.settings.muteAudio);
            } catch (e) { }

            if (typeof game.addSettingsChangeListener !== 'function') return;

            this._boundSettingsListener = (settings) => {
                const wasMuted = this._muted;
                this._muted = !!(settings && settings.muteAudio);
                if (wasMuted !== this._muted) {
                    for (const cb of this._audioCallbacks.slice()) {
                        core.safe(cb, 'onAudioEnabledChange', !this._muted);
                    }
                }
            };
            game.addSettingsChangeListener(this._boundSettingsListener);
        }

        _setupAuthListener() {
            try {
                const user = this.cg.user;
                if (!user || typeof user.addAuthListener !== 'function') return;
                this._boundAuthListener = (u) => {
                    this._userSignedIn = !!u;
                    this._notifyUserChange(u, u && u.__dangerousUserId);
                };
                user.addAuthListener(this._boundAuthListener);
            } catch (e) {
                log('auth listener setup failed:', e);
            }
        }

        // Read the platform locale so a first-time visitor gets a language
        // matching the portal they arrived from (crazygames.com.br → pt-BR).
        _readLocale() {
            try {
                const info = this.cg.user && this.cg.user.systemInfo;
                if (info && info.locale) this._locale = info.locale;
            } catch (e) { }
        }

        cleanup() {
            super.cleanup();
            try {
                const game = this.cg && this.cg.game;
                if (game && this._boundSettingsListener &&
                    typeof game.removeSettingsChangeListener === 'function') {
                    game.removeSettingsChangeListener(this._boundSettingsListener);
                }
            } catch (e) { }
            try {
                const user = this.cg && this.cg.user;
                if (user && this._boundAuthListener &&
                    typeof user.removeAuthListener === 'function') {
                    user.removeAuthListener(this._boundAuthListener);
                }
            } catch (e) { }

            if (this._gameplaySyncTimer) {
                clearTimeout(this._gameplaySyncTimer);
                this._gameplaySyncTimer = null;
            }
            this._boundSettingsListener = null;
            this._boundAuthListener = null;
            this._audioCallbacks = [];
        }

        // ----------------------------------------------------------- lifecycle

        // Safe module read: getters throw on a stubbed SDK. The functional probe
        // rules that out, but keeping every read guarded means a future module
        // change can't soft-lock the boot.
        _game() {
            try {
                return (this._ready && this.cg && this.cg.game) || null;
            } catch (e) {
                return null;
            }
        }

        _flushPendingLoading() {
            const queued = this._pendingLoading;
            this._pendingLoading = [];
            queued.forEach((name) => this[name]());
        }

        loadingStart() {
            if (!this._ready) {
                if (this._pendingLoading.indexOf('loadingStart') === -1) {
                    this._pendingLoading.push('loadingStart');
                }
                return;
            }
            const game = this._game();
            if (!game || typeof game.loadingStart !== 'function') return;
            if (this._loadingStarted) return;
            try {
                game.loadingStart();
                this._loadingStarted = true;
            } catch (e) {
                warn('loadingStart failed:', e);
            }
        }

        loadingStop() {
            if (!this._ready) {
                if (this._pendingLoading.indexOf('loadingStop') === -1) {
                    this._pendingLoading.push('loadingStop');
                }
                return;
            }
            const game = this._game();
            if (!game || typeof game.loadingStop !== 'function') return;
            // Never stop a loading phase that was never started — the SDK logs
            // that as an error, and the pairing matters for its metrics.
            if (!this._loadingStarted || this._loadingFinished) return;
            try {
                game.loadingStop();
                this._loadingFinished = true;
            } catch (e) {
                warn('loadingStop failed:', e);
            }
        }

        // No firstFrameReady() override: that signal is YouTube-only. CrazyGames
        // has just loadingStart()/loadingStop(), so the base class's no-op is
        // inherited and shared game code calling it unconditionally stays safe.

        happyTime() {
            const game = this._game();
            if (!game || typeof game.happytime !== 'function') return;
            try { game.happytime(); } catch (e) { warn('happytime failed:', e); }
        }

        reportProgress(pct) {
            const game = this._game();
            if (!game || typeof game.reportGameCompletedPercentage !== 'function') return;
            const value = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
            try {
                game.reportGameCompletedPercentage(value);
            } catch (e) {
                warn('reportGameCompletedPercentage failed:', e);
            }
        }

        // ------------------------------------------------------------ gameplay

        // Reconciles what the SDK has been told with what the game wants. Never
        // calls the SDK when it is already in the desired state (duplicates are
        // logged as errors and dropped), and reschedules itself when the 1s
        // per-method throttle would swallow the call.
        _syncGameplayState() {
            if (this._gameplaySyncTimer) {
                clearTimeout(this._gameplaySyncTimer);
                this._gameplaySyncTimer = null;
            }

            const game = this._game();
            if (!game) return;

            // During an ad the SDK must see gameplay stopped regardless of what
            // the game wants; the wanted state is restored when the ad settles.
            const desired = this._adActive ? false : this._gameplayWanted;
            if (desired === this._sdkGameplayRunning) return;

            const which = desired ? 'start' : 'stop';
            const fn = desired ? game.gameplayStart : game.gameplayStop;
            if (typeof fn !== 'function') return;

            const now = Date.now();
            const waited = now - this._lastGameplayCallAt[which];
            if (waited < GAMEPLAY_CALL_THROTTLE_MS) {
                this._gameplaySyncTimer = setTimeout(
                    () => this._syncGameplayState(),
                    GAMEPLAY_CALL_THROTTLE_MS - waited
                );
                return;
            }

            this._lastGameplayCallAt[which] = now;
            this._sdkGameplayRunning = desired;
            try {
                fn.call(game);
            } catch (e) {
                // Roll back so the next sync retries rather than believing a
                // call landed that never did.
                this._sdkGameplayRunning = !desired;
                warn('gameplay' + (desired ? 'Start' : 'Stop') + ' failed:', e);
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

        // Core opens and closes ad flows through here.
        _onAdActiveChange(active) {
            this._syncGameplayState();
        }

        // --------------------------------------------------------------- audio

        // Reads the live SDK setting, falling back to the cached value when the
        // SDK isn't ready. Deliberately PURE (never writes _muted): the settings
        // listener is the sole writer, so its edge detection stays reliable. A
        // getter that also wrote could pre-sync the value from a poll and make
        // the change event miss its edge.
        isAudioEnabled() {
            try {
                const settings = this.cg && this.cg.game && this.cg.game.settings;
                if (settings && typeof settings.muteAudio === 'boolean') {
                    return !settings.muteAudio;
                }
            } catch (e) { }
            return !this._muted;
        }

        onAudioEnabledChange(cb) {
            return this._subscribe(this._audioCallbacks, cb);
        }

        // ---------------------------------------------------------------- user

        async getUser() {
            if (!this._ready) return null;
            let user = null;
            try { user = this.cg.user; } catch (e) { return null; }
            if (!user) return null;
            try {
                // isUserAccountAvailable is a BOOLEAN PROPERTY, not a method:
                // false when the account system is unavailable (e.g. a
                // third-party embed), so a guest must resolve as null here.
                if (user.isUserAccountAvailable === false) {
                    return null;
                }
                const u = await user.getUser();
                if (!u) return null;
                return { username: u.username, profilePictureUrl: u.profilePictureUrl };
            } catch (e) {
                log('getUser failed:', e);
                return null;
            }
        }

        isUserSignedIn() { return this._userSignedIn; }

        async signIn() {
            if (!this._ready) return false;
            try {
                const user = this.cg.user;
                if (!user || typeof user.showAuthPrompt !== 'function') return this._userSignedIn;
                const u = await user.showAuthPrompt();
                this._userSignedIn = !!u;
                // Notify directly too: the auth listener usually fires on login,
                // but not relying on it alone matches the other adapters — and
                // _notifyUserChange dedupes when it also fires.
                this._notifyUserChange(u, u && u.__dangerousUserId);
                return this._userSignedIn;
            } catch (e) {
                // The player dismissing the prompt rejects; that is not an error.
                log('signIn dismissed or failed:', e);
                return this._userSignedIn;
            }
        }

        // ---------------------------------------------------------------- data
        //
        // Every read and write goes through cg.data and nowhere else. That one
        // call already covers both cases: cloud-synced for a signed-in player,
        // and for a guest the SDK ITSELF persists to browser storage below this
        // layer, then auto-syncs that data up to the account when the player
        // signs in. Guests therefore keep their progress without the bridge —
        // or the game — writing a single byte of its own.
        //
        // So do NOT add a local mirror on top, and do not write to browser
        // storage from game code either. Two writers, one of which the SDK does
        // not know about, is how a stale local copy ends up overwriting the
        // freshly synced cloud save at sign-in. The SDK owns the local tier; the
        // bridge owns only the cg.data calls.
        //
        // When the SDK is unavailable entirely (blocked script) writes are
        // DROPPED rather than redirected somewhere the SDK will never reconcile.
        // A save that silently loses to a cloud copy later is worse than a
        // player who plainly has no save this session.

        _data() {
            try {
                return (this._ready && this.cg && this.cg.data) || null;
            } catch (e) {
                return null;
            }
        }

        // DURABILITY: cg.data.setItem is a synchronous void call that schedules a
        // background cloud sync, so there is nothing to await and this resolves
        // long before the data is safe. Anything that must survive a reload
        // needs its own durable marker written before unload — this is the
        // platform where the base class's durability warning genuinely bites.
        saveData(data) {
            const d = this._data();
            if (!d) return Promise.resolve();
            try { d.setItem(this.saveKey, data); } catch (e) { warn('saveData failed:', e); }
            return Promise.resolve();
        }

        loadData() {
            const d = this._data();
            if (!d) return Promise.resolve(null);
            try {
                const val = d.getItem(this.saveKey);
                return Promise.resolve(val != null ? val : null);
            } catch (e) {
                warn('loadData failed:', e);
                return Promise.resolve(null);
            }
        }

        async setItem(key, value) {
            const d = this._data();
            if (!d) return;
            try { d.setItem(key, String(value)); } catch (e) { warn('setItem failed:', e); }
        }

        async getItem(key) {
            const d = this._data();
            if (!d) return null;
            try { return d.getItem(key); } catch (e) { return null; }
        }

        async removeItem(key) {
            const d = this._data();
            if (!d) return;
            try { d.removeItem(key); } catch (e) { }
        }

        // The blob and the key-value pairs share one cg.data namespace, so
        // clear() takes both — including any stored language, which is the point
        // of a brand-new slate. These writes are fire-and-forget, so a hard reset
        // must write its sentinel after this resolves, not alongside it.
        async nukeAllData() {
            this._storage = {};
            const d = this._data();
            if (d) { try { d.clear(); } catch (e) { } }
        }

        // --------------------------------------------------------- environment

        getLanguage() {
            return Promise.resolve(this._locale || navigator.language || 'en-US');
        }

        getEnvironment() {
            if (!this._ready || !this.cg) return 'disabled';
            try {
                return this.cg.environment || 'local';
            } catch (e) {
                return 'disabled';
            }
        }

        // Sitelock predicate for content that only unlocks on an authorized
        // host. `ready` is NOT an authorization signal — v3 initializes on any
        // host, so a rehosted copy passes it trivially. Hostname is the gate; it
        // also keeps real players unlocked when an adblocker stops the SDK
        // script from loading on the genuine site.
        //
        // Intentionally lenient: any hostname containing "crazy" passes. This is
        // a speed bump against casual re-hosting, not a security boundary — a
        // determined thief just registers a matching domain. Erring wide is the
        // deliberate trade, since a host we fail to recognise silently locks
        // legitimate players out, and this covers every regional domain.
        isAuthorizedHost() {
            if (isLocalDev()) return true;
            return (window.location.hostname || '').toLowerCase().includes('crazy');
        }

        // ----------------------------------------------------------------- ads

        hasAdblock() {
            // No ad module at all means the SDK script itself was blocked, which
            // is the strongest adblock signal available — stronger than the
            // SDK's own probe, which cannot run at that point.
            if (!this._ready) return Promise.resolve(true);
            let ad = null;
            try { ad = this.cg.ad; } catch (e) { }
            if (!ad) return Promise.resolve(true);
            if (typeof ad.hasAdblock !== 'function') return Promise.resolve(this._hasAdblock);
            return Promise.resolve(ad.hasAdblock()).then(
                (v) => { this._hasAdblock = !!v; return this._hasAdblock; },
                () => this._hasAdblock
            );
        }

        _requestAd(type, hooks) {
            let ad = null;
            try { ad = this._ready ? this.cg.ad : null; } catch (e) { }

            if (!ad) {
                // In practice an adblocker blocking sdk.crazygames.com. This MUST
                // report a failure: an ad that "completes" without playing hands
                // out the rewarded prize for free, and CrazyGames requires that a
                // failed ad never rewards.
                warn(type + ' — ad module unavailable, reporting adblock.');
                hooks.failed('adblock');
                return;
            }

            // Known-unfillable: don't make the player sit through a transition
            // waiting for an adError that is already certain.
            if (this._hasAdblock) {
                hooks.failed('adblock');
                return;
            }

            ad.requestAd(type, {
                // Genuinely on screen — CrazyGames is the one platform here that
                // reports this, so the host's pause/mute lands at the right time.
                adStarted: () => hooks.started(),
                // For 'rewarded' this fires only when the reward was earned.
                adFinished: () => hooks.finished(true),
                // Per CrazyGames: on adError the player is NOT rewarded, but the
                // game must continue normally.
                adError: (err) => hooks.failed(err || 'error')
            });
        }
    }

    // ==========================================================================
    // CrazyGamesMock — local development stand-in.
    //
    // Saves go to localStorage so a dev reload keeps its progress. That is a DEV
    // CONVENIENCE ONLY: on CrazyGames the save lives solely in cg.data.
    // ==========================================================================

    class CrazyGamesMock extends BaseSDKAdapter {
        constructor() {
            super();
            this._audioEnabled = true;
            this._audioCallbacks = [];
        }

        get capabilities() { return CAPABILITIES; }

        _boot() {
            console.log('[MockSDK] Initialized (CrazyGames mock, local dev).');
            return true;
        }

        loadingStart() { console.log('[MockSDK] loadingStart()'); }
        loadingStop() { console.log('[MockSDK] loadingStop()'); }
        gameplayStart() { console.log('[MockSDK] gameplayStart()'); }
        gameplayStop() { console.log('[MockSDK] gameplayStop()'); }
        happyTime() { console.log('[MockSDK] happyTime()'); }
        reportProgress(pct) { console.log('[MockSDK] reportProgress(' + pct + ')'); }

        // Stateful so the host-mute path is reproducible in dev. Deliberately
        // unlogged — games poll this several times a second.
        isAudioEnabled() { return this._audioEnabled !== false; }

        onAudioEnabledChange(cb) {
            console.log('[MockSDK] onAudioEnabledChange() registered. ' +
                'Trigger via window.__mockAudioEnabledChange(bool) in DevTools.');
            window.__mockAudioEnabledChange = (enabled) => {
                // Mirror the real host: the getter flips first, then the event.
                this._audioEnabled = enabled !== false;
                console.log('[MockSDK] audio enabled →', this._audioEnabled);
                for (const c of this._audioCallbacks.slice()) c(this._audioEnabled);
            };
            return this._subscribe(this._audioCallbacks, cb);
        }

        getUser() {
            return Promise.resolve({ username: 'Player', profilePictureUrl: null });
        }
        isUserSignedIn() { return true; }
        signIn() { return Promise.resolve(true); }

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

        getLanguage() {
            const lang = core.queryParam('lang') || navigator.language || 'en-US';
            console.log('[MockSDK] getLanguage() →', lang);
            return Promise.resolve(lang);
        }

        getEnvironment() { return 'local'; }

        _requestAd(type, hooks) {
            console.log('[MockSDK] ' + type + ' ad → simulated: started → finished');
            hooks.started();
            setTimeout(() => hooks.finished(true), 100);
        }

        hasAdblock() { return Promise.resolve(false); }
    }

    window.GameSDK._register({
        name: 'crazygames',
        Adapter: CrazyGamesAdapter,
        Mock: CrazyGamesMock
    });
})();
