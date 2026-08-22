/*
 * GameSDK — CrazyGames adapter
 * ============================
 *
 * Requires sdk-core.js FIRST:
 *
 *   <script src="js/sdk-core.js"></script>
 *   <script src="js/platform-crazygames.js"></script>
 *
 * No vendor <script> tag needed — adapter loads the portal SDK itself.
 * Docs: https://docs.crazygames.com/sdk/
 *
 * Module map (window.CrazyGames.SDK):
 *   .game        loadingStart/Stop, gameplayStart/Stop, happytime,
 *                reportGameCompletedPercentage, settings, addSettingsChangeListener
 *   .ad          requestAd(type, {adStarted, adFinished, adError}), hasAdblock
 *   .user        getUser, isUserAccountAvailable, addAuthListener, systemInfo
 *   .data        getItem, setItem, removeItem, clear (cloud-synced)
 *   .environment 'local' | 'crazygames' | 'disabled'
 *
 * Not available: leaderboards, first-frame, host pause/resume (game handles
 * backgrounding via visibilitychange), diagnostics.
 */
(function () {
    'use strict';

    const core = window.GameSDKCore;
    if (!core) {
        console.error('[GameSDK] platform-crazygames.js requires sdk-core.js to be loaded first.');
        return;
    }
    const { BaseSDKAdapter, log, warn, isLocalDev } = core;

    // Handshake cap — SDK.init(), hasAdblock(), getUser(). Late arrivals
    // still populate state; they just stop gating the boot.
    const SDK_INIT_TIMEOUT_MS = 8000;

    // SDK throttles gameplayStart/Stop at 1s per method and discards calls
    // inside that window; pace on our side to avoid stale state.
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

            // Pending loading events, replayed after init resolves.
            this._pendingLoading = [];
            this._loadingStarted = false;
            this._loadingFinished = false;

            // Gameplay: _gameplayWanted = game's request, _sdkGameplayRunning =
            // what SDK was actually told (diverge during ads/throttle).
            this._gameplayWanted = false;
            this._sdkGameplayRunning = false;
            this._gameplaySyncTimer = null;
            this._lastGameplayCallAt = { start: 0, stop: 0 };
        }

        get capabilities() { return CAPABILITIES; }

        /** Escape hatch for CrazyGames-only APIs not wrapped by the bridge. */
        getNativeSDK() { return this.cg; }

        // ---------------------------------------------------------------- init

        get initTimeoutMs() { return SDK_INIT_TIMEOUT_MS; }

        async _boot() {
            const sdk = await this._loadSdkScript();
            if (!sdk || typeof sdk.init !== 'function') {
                warn('CrazyGames SDK not usable; fallback mode.');
                return false;
            }

        // Guard synchronous throw from init().
        let initResult;
        try {
            initResult = sdk.init();
        } catch (e) {
            warn('SDK.init() threw synchronously; fallback mode.', e);
            return false;
        }
        await initResult;

        // v3 init() resolves on every host, but rehosted/stub builds return
        // module getters that throw. Probe before trusting.
        if (!this._probeFunctional(sdk)) {
                warn('SDK loaded but not functional (stub/rehosted); fallback mode.');
                return false;
            }

            this.cg = sdk;
            this._ready = true;

            this._setupSettingsListener();
            this._setupAuthListener();
            this._readLocale();
            this._flushPendingLoading();
            this._syncGameplayState();
            await this._probeAdblock();
            await this._probeUser();

            log('CrazyGames initialized. environment =', this.getEnvironment());
            return true;
        }

        // Loads or reuses the SDK script. The init timeout bounds this.
        _loadSdkScript() {
            return new Promise((resolve) => {
                const existing = () => (window.CrazyGames && window.CrazyGames.SDK) || null;
                if (existing()) { resolve(existing()); return; }

                let tag = null;
                try {
                    tag = document.querySelector('script[src*="crazygames-sdk"]');
                } catch (e) { }

                if (tag) {
                    // Tag exists but global not ready; ride its events.
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

        // Read locale so visitors get a language matching their portal.
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
            // Don't stop a phase that was never started; SDK logs it as error.
            if (!this._loadingStarted || this._loadingFinished) return;
            try {
                game.loadingStop();
                this._loadingFinished = true;
            } catch (e) {
                warn('loadingStop failed:', e);
            }
        }

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

        // Syncs desired vs actual state; reschedules if the 1s throttle would
        // swallow the call.
        _syncGameplayState() {
            if (this._gameplaySyncTimer) {
                clearTimeout(this._gameplaySyncTimer);
                this._gameplaySyncTimer = null;
            }

            const game = this._game();
            if (!game) return;

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
                // Roll back so next sync retries.
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

        _onAdActiveChange(active) {
            this._syncGameplayState();
        }

        // --------------------------------------------------------------- audio

        // Pure getter (never writes _muted); the listener is the sole writer.
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
                // Notify directly too; the auth listener may not fire.
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
        // All reads/writes go through cg.data. The SDK auto-syncs guest data
        // to the account on sign-in; adding a local mirror risks stale writes
        // overwriting the cloud copy. When the SDK is unavailable, writes are
        // DROPPED rather than stored somewhere the SDK will never reconcile.

        _data() {
            try {
                return (this._ready && this.cg && this.cg.data) || null;
            } catch (e) {
                return null;
            }
        }

        // DURABILITY: cg.data.setItem is fire-and-forget with no completion
        // signal. Anything that must survive a reload needs its own marker.
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

        // clear() takes blob and key-value pairs alike. Fire-and-forget;
        // hard reset must write its sentinel after this resolves.
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

        // Speed bump, not a security boundary: any hostname containing
        // "crazy" passes. Erring wide avoids locking legitimate players out of
        // regional domains.
        isAuthorizedHost() {
            if (isLocalDev()) return true;
            return (window.location.hostname || '').toLowerCase().includes('crazy');
        }

        // ----------------------------------------------------------------- ads

        hasAdblock() {
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
                // SDK blocked — must report failure (adblock or unavailable).
                warn(type + ' — ad module unavailable, reporting adblock.');
                hooks.failed('adblock');
                return;
            }

            if (this._hasAdblock) {
                hooks.failed('adblock');
                return;
            }

            ad.requestAd(type, {
                adStarted: () => hooks.started(),
                adFinished: () => hooks.finished(true),
                adError: (err) => hooks.failed(err || 'error')
            });
        }
    }

    // ==========================================================================
    // CrazyGamesMock — local dev stand-in.
    // Saves go to localStorage (dev convenience; on CrazyGames, save lives in cg.data).
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

        isAudioEnabled() { return this._audioEnabled !== false; }

        onAudioEnabledChange(cb) {
            console.log('[MockSDK] onAudioEnabledChange() registered. ' +
                'Trigger via window.__mockAudioEnabledChange(bool) in DevTools.');
            window.__mockAudioEnabledChange = (enabled) => {
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
