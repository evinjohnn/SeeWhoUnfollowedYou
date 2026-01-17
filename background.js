
import {
    sleep,
    urlGenerator,
    followersUrlGenerator,
    unfollowUserUrlGenerator,
    getCookie,
    fetchUserProfile
} from './utils.js';

// -- State --
// We keep the state validation in memory.
// It resets when the service worker is killed, but that's okay for "active" scans.
// For "Auto-scan" we check persistent storage.
let masterState = {
    status: 'idle', // idle | scanning | unfollowing | error
    progress: 0,
    scannedCount: 0,
    unfollowedCount: 0, // Track unfollow progress
    totalToScan: 0,
    scanCursor: null,
    followingList: [],   // Renamed from 'results' for clarity
    fanList: [],         // Followers list for Snake detection
    snakes: [],          // Lost connections
    unfollowQueue: [],
    currentTabId: null,
    lastErrorReason: null // For diagnostics
};

// Auto-recover from error state after 3 seconds
const recoverFromError = () => {
    if (masterState.status === 'error') {
        masterState.status = 'idle';
        masterState.progress = 0;
        broadcastUpdate();
    }
};

// Load initial state (snakes need to persist)
chrome.storage.local.get(['snakes', 'lastScanResults'], (data) => {
    if (data.snakes) masterState.snakes = data.snakes;
    if (data.lastScanResults) masterState.followingList = data.lastScanResults;
});

// First install - do NOT auto-enable scan, let user go through tour first
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        // Don't set enableAutoScan on first install
        // User should manually do first scan after tour
        console.log('Extension installed. Auto-scan disabled until first manual scan.');
    }
});

// -- Listeners --

// 1. Message Handling
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.type) {
        case 'START_SCAN':
            startScanProcess();
            sendResponse({ success: true });
            break;
        case 'GET_STATE':
            sendResponse(masterState);
            break;
        case 'STOP_SCAN':
            masterState.status = 'idle';
            broadcastUpdate();
            sendResponse({ success: true });
            break;
        case 'START_UNFOLLOW':
            // Payload: { users: [...] }
            startUnfollowProcess(request.users);
            sendResponse({ success: true });
            break;
        case 'FETCH_IMAGE':
            // Proxy image requests to bypass CORS
            fetch(request.url, {
                credentials: 'omit',
                referrerPolicy: 'no-referrer'
            })
                .then(response => response.blob())
                .then(blob => {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        sendResponse({ success: true, dataUrl: reader.result });
                    };
                    reader.readAsDataURL(blob);
                })
                .catch(error => {
                    console.error('Image fetch failed:', error);
                    sendResponse({ success: false });
                });
            return true; // Keep channel open for async response
    }
    return true; // async response
});

// 2. Tab Updates (Auto-Scan Check & Overlay Injection)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && tab.url.includes('instagram.com')) {
        masterState.currentTabId = tabId;

        // Check Auto-Scan Logic
        // Only auto-scan if user has completed at least one manual scan
        const settings = await chrome.storage.local.get(['enableAutoScan', 'lastAutoScanTime', 'lastScanTime']);
        const hasCompletedFirstScan = settings.lastScanTime && settings.lastScanTime > 0;

        if (settings.enableAutoScan && hasCompletedFirstScan) {
            const lastTime = settings.lastAutoScanTime || 0;
            const ONE_DAY_MS = 24 * 60 * 60 * 1000;
            if (Date.now() - lastTime > ONE_DAY_MS) {
                console.log("Auto-starting daily scan...");
                startScanProcess(true); // isAuto = true
            }
        }
    }
});

// -- Logic --

const broadcastUpdate = () => {
    // Notify Popup
    chrome.runtime.sendMessage({ type: 'STATE_UPDATE', payload: masterState }).catch(() => { });

    // Notify Content Script (Overlay)
    if (masterState.currentTabId) {
        chrome.tabs.sendMessage(masterState.currentTabId, {
            type: 'UPDATE_OVERLAY',
            payload: {
                status: masterState.status,
                progress: masterState.progress,
                count: masterState.scannedCount
            }
        }).catch(() => {
            // Tab might be closed or not ready
        });
    }
};

// ===========================================
// ADAPTIVE PROGRESS MANAGER
// 4-Phase Monotonic Progress System
// FAST: 0-40% (timer-driven, immediate feedback)
// SLOW_BURN: 40-50% (conditional buffer, only if followers not done)
// FOLLOWING: 50-100% (data-driven, following scan completion)
// DONE: 100% (snap to completion)
// ===========================================
const ProgressManager = {
    // State
    progress: 0,
    phase: 'FAST', // FAST | SLOW_BURN | FOLLOWING | DONE
    followersDone: false,
    followingDone: false,
    totalFollowing: 0,
    scannedFollowing: 0,
    statusMessage: 'Starting scan...',

    // Timers
    fastTimer: null,
    slowBurnTimer: null,

    // Phase thresholds
    FAST_MAX: 40,
    SLOW_BURN_MAX: 50,
    FOLLOWING_BASE: 50,

    reset() {
        this.progress = 0;
        this.phase = 'FAST';
        this.followersDone = false;
        this.followingDone = false;
        this.totalFollowing = 0;
        this.scannedFollowing = 0;
        this.statusMessage = 'Starting scan...';
        this.stopTimers();
    },

    stopTimers() {
        if (this.fastTimer) clearInterval(this.fastTimer);
        if (this.slowBurnTimer) clearInterval(this.slowBurnTimer);
        this.fastTimer = null;
        this.slowBurnTimer = null;
    },

    // Start the fast phase timer (+3% every 4 seconds, caps at 40%)
    startFastPhase(broadcastFn) {
        this.phase = 'FAST';
        this.statusMessage = 'Scanning followers...';

        this.fastTimer = setInterval(() => {
            if (this.phase !== 'FAST') {
                clearInterval(this.fastTimer);
                return;
            }

            // Increment by 3%, cap at 40%
            this.progress = Math.min(this.FAST_MAX, this.progress + 3);

            // Vary status messages for engagement
            if (this.progress < 15) {
                this.statusMessage = 'Scanning followers...';
            } else if (this.progress < 30) {
                this.statusMessage = 'Analyzing connections...';
            } else {
                this.statusMessage = 'Verifying data...';
            }

            if (broadcastFn) broadcastFn();

            // Hit cap - check if we should skip slow burn
            if (this.progress >= this.FAST_MAX) {
                clearInterval(this.fastTimer);
                this.transitionFromFast(broadcastFn);
            }
        }, 4000); // Every 4 seconds

        // Immediate first tick
        this.progress = 3;
        if (broadcastFn) broadcastFn();
    },

    // Decision gate at 40%
    transitionFromFast(broadcastFn) {
        if (this.followersDone) {
            // Skip slow burn, jump to 50% immediately
            this.progress = this.SLOW_BURN_MAX;
            this.phase = 'FOLLOWING';
            this.statusMessage = 'Processing following list...';
            if (broadcastFn) broadcastFn();
        } else {
            // Enter slow burn mode
            this.startSlowBurn(broadcastFn);
        }
    },

    // Slow burn: +0.3-0.5% every 5-8 seconds, caps at 50%
    startSlowBurn(broadcastFn) {
        this.phase = 'SLOW_BURN';
        this.statusMessage = 'Verifying connections...';

        const tick = () => {
            if (this.phase !== 'SLOW_BURN') return;

            // Random increment between 0.3 and 0.5
            const increment = 0.3 + Math.random() * 0.2;
            this.progress = Math.min(this.SLOW_BURN_MAX, this.progress + increment);
            this.progress = Math.round(this.progress * 10) / 10; // Keep 1 decimal

            // Contextual status for slow burn phase
            const msgs = ['Verifying connections...', 'Checking relationships...', 'Preparing scan...'];
            this.statusMessage = msgs[Math.floor(Math.random() * msgs.length)];

            if (broadcastFn) broadcastFn();

            if (this.progress < this.SLOW_BURN_MAX && this.phase === 'SLOW_BURN') {
                // Schedule next tick with random delay (5-8 seconds)
                const delay = 5000 + Math.random() * 3000;
                this.slowBurnTimer = setTimeout(tick, delay);
            }
        };

        // First tick after 5 seconds
        this.slowBurnTimer = setTimeout(tick, 5000);
    },

    // Call when followers scan is complete
    setFollowersDone(broadcastFn) {
        this.followersDone = true;

        // If still in slow burn, immediately transition
        if (this.phase === 'SLOW_BURN') {
            this.stopTimers();
            this.progress = this.SLOW_BURN_MAX;
            this.phase = 'FOLLOWING';
            this.statusMessage = 'Scanning who you follow...';
            if (broadcastFn) broadcastFn();
        }
    },

    // Set total following count (for 50-100% calculation)
    setTotalFollowing(count) {
        this.totalFollowing = count || 1; // Avoid division by zero
        console.log('[PROGRESS] setTotalFollowing:', this.totalFollowing);
    },

    // Update following scan progress (drives 50-100%)
    updateFollowingProgress(scanned, broadcastFn) {
        this.scannedFollowing = scanned;

        // Only update if in FOLLOWING phase
        if (this.phase === 'FOLLOWING' && this.totalFollowing > 0) {
            // Formula: globalProgress = 50 + (oldFollowingPercent / 100) * 50
            const oldFollowingPercent = Math.min(100, Math.round((this.scannedFollowing / this.totalFollowing) * 100));
            const globalProgress = 50 + (oldFollowingPercent / 100) * 50;

            console.log('[PROGRESS] Following:', this.scannedFollowing, '/', this.totalFollowing,
                'oldPercent:', oldFollowingPercent, '-> global:', globalProgress);

            // Monotonic: never go backwards
            this.progress = Math.max(this.progress, Math.round(globalProgress));

            // Safety cap: never hit 100% until setFollowingDone is called explicitly
            this.progress = Math.min(99, this.progress);

            // Status updates
            if (this.progress < 70) {
                this.statusMessage = `Scanning following (${this.scannedFollowing.toLocaleString()})...`;
            } else if (this.progress < 90) {
                this.statusMessage = 'Detecting unfollowers...';
            } else {
                this.statusMessage = 'Finalizing results...';
            }

            if (broadcastFn) broadcastFn();
        }
    },

    // Call when following scan is complete
    setFollowingDone(broadcastFn) {
        this.followingDone = true;
        this.stopTimers();
        this.phase = 'DONE';
        this.progress = 100;
        this.statusMessage = 'Scan complete!';
        if (broadcastFn) broadcastFn();
    },

    // Force transition to FOLLOWING phase (call after fast phase if needed)
    forceFollowingPhase(broadcastFn) {
        if (this.phase === 'FAST' || this.phase === 'SLOW_BURN') {
            this.stopTimers();
            this.progress = Math.max(this.progress, this.SLOW_BURN_MAX);
            this.phase = 'FOLLOWING';
            this.statusMessage = 'Processing following list...';
            if (broadcastFn) broadcastFn();
        }
    },

    getProgress() {
        return Math.round(this.progress);
    },

    getMessage() {
        return this.statusMessage;
    },

    getPhase() {
        return this.phase;
    }
};


// -- Main Scan Process --
const startScanProcess = async (isAuto = false) => {
    if (masterState.status === 'scanning') return;
    masterState.status = 'scanning';
    masterState.followingList = [];
    masterState.fanList = [];
    masterState.scanCursor = null;
    masterState.progress = 0;
    masterState.scannedCount = 0;
    masterState.statusMessage = 'Starting scan...';

    // Initialize ProgressManager
    ProgressManager.reset();

    // Broadcast helper
    const updateUI = () => {
        masterState.progress = ProgressManager.getProgress();
        masterState.statusMessage = ProgressManager.getMessage();
        broadcastUpdate();
    };

    // Start fast phase timer (0% -> 40%)
    ProgressManager.startFastPhase(updateUI);
    broadcastUpdate();

    try {
        // 1. Fetch User Profile First (Get Baseline Counts)
        const profileData = await fetchUserProfile();
        const currentFollowerCount = profileData?.followerCount || 0;
        const currentFollowingCount = profileData?.followingCount || 0;

        masterState.totalToScan = currentFollowingCount + currentFollowerCount;
        ProgressManager.setTotalFollowing(currentFollowingCount);

        // ============================================
        // PHASE 1: FOLLOWERS SCAN (runs during FAST 0-40%)
        // This happens in background while fast timer runs
        // ============================================
        let hasNextPage = true;
        let consecutiveErrors = 0;

        while (hasNextPage && masterState.status === 'scanning') {
            const url = await followersUrlGenerator(masterState.scanCursor);
            if (!url) break;

            try {
                const response = await fetch(url);
                const json = await response.json();

                if (!json.data?.user) throw new Error("Invalid structure (followers)");

                const edgeFollowedBy = json.data.user.edge_followed_by;
                hasNextPage = edgeFollowedBy.page_info.has_next_page;
                masterState.scanCursor = edgeFollowedBy.page_info.end_cursor;

                const nodes = edgeFollowedBy.edges.map(e => e.node);
                masterState.fanList.push(...nodes);
                masterState.scannedCount = masterState.fanList.length;

                // Fast timer handles progress, we just update count for display
                updateUI();

                consecutiveErrors = 0;
                await sleep(1000 + Math.random() * 500);

            } catch (e) {
                console.warn("Fetch error (Followers)", e);
                consecutiveErrors++;
                if (consecutiveErrors > 3) break;
                await sleep(2000);
            }
        }

        // Followers done - signal ProgressManager
        ProgressManager.setFollowersDone(updateUI);

        // ============================================
        // PHASE 2: FOLLOWING SCAN (drives 50% -> 100%)
        // ============================================
        masterState.scanCursor = null;
        hasNextPage = true;
        consecutiveErrors = 0;

        // Force transition to FOLLOWING phase if still in FAST/SLOW_BURN
        ProgressManager.forceFollowingPhase(updateUI);

        while (hasNextPage && masterState.status === 'scanning') {
            const url = await urlGenerator(masterState.scanCursor);
            if (!url) throw new Error("Failed to generate URL");

            try {
                const response = await fetch(url);
                const json = await response.json();

                if (!json.data?.user) throw new Error("Invalid structure (following)");

                const edgeFollow = json.data.user.edge_follow;

                // Update total count if we get a better number from the API
                // This prevents progress jumping if initial profile fetch failed (returns 0)
                if (edgeFollow.count > masterState.totalToScan) {
                    masterState.totalToScan = edgeFollow.count + masterState.fanList.length;
                    ProgressManager.setTotalFollowing(edgeFollow.count);
                }

                hasNextPage = edgeFollow.page_info.has_next_page;
                masterState.scanCursor = edgeFollow.page_info.end_cursor;

                const nodes = edgeFollow.edges.map(e => e.node);
                masterState.followingList.push(...nodes);
                masterState.scannedCount = masterState.fanList.length + masterState.followingList.length;

                // Update progress (50% -> 100%)
                ProgressManager.updateFollowingProgress(masterState.followingList.length, updateUI);

                consecutiveErrors = 0;
                await sleep(1000 + Math.random() * 500);

            } catch (e) {
                console.warn("Fetch error (Following)", e);
                consecutiveErrors++;
                if (consecutiveErrors > 3) break;
                await sleep(2000);
            }
        }

        // Following done - snap to 100%
        ProgressManager.setFollowingDone(updateUI);
        await sleep(300); // Brief pause to show 100%
        masterState.status = 'idle';

        // 3. Post-Scan Analysis
        const storage = await chrome.storage.local.get(['lastScanResults', 'lastFanList', 'snakes', 'scanHistory']);
        // lastScanResults = Old Following List (Not used for Snakes anymore)
        const previousFanList = storage.lastFanList || []; // List of Followers from last scan
        let previousSnakes = storage.snakes || [];

        // Detect Snakes (Lost Followers)
        // Logic: Snake = Is in PreviousFanList AND NOT in CurrentFanList
        let newSnakes = [];
        if (previousFanList.length > 0) {
            const currentFanIds = new Set(masterState.fanList.map(u => u.id));

            newSnakes = previousFanList.filter(oldFan => {
                return !currentFanIds.has(oldFan.id);
            });

            // Merge Snakes
            const existingSnakeIds = new Set(previousSnakes.map(s => s.id));
            newSnakes.forEach(s => {
                if (!existingSnakeIds.has(s.id)) {
                    s.detected_at = Date.now();
                    previousSnakes.push(s);
                }
            });

            // Clean up: Remove snakes if they appear in CurrentFanList (Re-followed)
            previousSnakes = previousSnakes.filter(s => !currentFanIds.has(s.id));

            // Sort snakes by detected_at DESC (newest first)
            previousSnakes.sort((a, b) => (b.detected_at || 0) - (a.detected_at || 0));
        }

        // --- DEDUPLICATION STEP ---
        // Ensure accurate counts by removing any duplicates from the scan
        const uniqueFollowing = new Map();
        masterState.followingList.forEach(u => uniqueFollowing.set(u.id, u));
        masterState.followingList = Array.from(uniqueFollowing.values());

        const uniqueFans = new Map();
        masterState.fanList.forEach(u => uniqueFans.set(u.id, u));
        masterState.fanList = Array.from(uniqueFans.values());

        // 4. Update History (For Net Growth Graph)
        const scanHistory = storage.scanHistory || [];
        const historyEntry = {
            timestamp: Date.now(),
            followingCount: masterState.followingList.length,
            followerCount: masterState.fanList.length, // Accurate from scan
            newSnakesCount: newSnakes.length
        };

        scanHistory.push(historyEntry);
        if (scanHistory.length > 30) scanHistory.shift();

        // 5. Save State
        masterState.snakes = previousSnakes;
        await chrome.storage.local.set({
            lastScanResults: masterState.followingList, // Save Following List for Unfollower identification in UI
            lastFanList: masterState.fanList,     // Save Fan List for next Snake detection
            lastScanTime: Date.now(),
            snakes: masterState.snakes,
            scanHistory: scanHistory,
            lastAutoScanTime: isAuto ? Date.now() : (storage.lastAutoScanTime || 0)
        });

        broadcastUpdate();

    } catch (err) {
        console.error("Scan error", err);
        masterState.status = 'error';
        masterState.lastErrorReason = err.message || err.toString(); // Capture for diagnostics
        broadcastUpdate();
        setTimeout(recoverFromError, 3000);
    }
};


const startUnfollowProcess = async (usersToUnfollow) => {
    if (masterState.status === 'unfollowing') return;
    masterState.status = 'unfollowing';
    masterState.unfollowQueue = usersToUnfollow;
    masterState.progress = 0;
    broadcastUpdate();

    const csrf = await getCookie('csrftoken');
    if (!csrf) {
        masterState.status = 'error'; // Missing Token
        broadcastUpdate();
        setTimeout(recoverFromError, 3000); // Auto-recover after 3s
        return;
    }

    masterState.unfollowedCount = 0;
    for (const userId of usersToUnfollow) {
        if (masterState.status !== 'unfollowing') break; // User stopped it

        try {
            const url = unfollowUserUrlGenerator(userId);
            await fetch(url, {
                method: 'POST',
                headers: {
                    'x-csrftoken': csrf,
                    'content-type': 'application/x-www-form-urlencoded'
                },
                body: ''
            });

            // Update master results to reflect unfollowing
            masterState.followingList = masterState.followingList.filter(u => u.id !== userId);

        } catch (e) {
            console.error(`Failed to unfollow ${userId}`, e);
        }

        masterState.unfollowedCount++;
        masterState.progress = Math.round((masterState.unfollowedCount / usersToUnfollow.length) * 100);
        masterState.statusMessage = `Processing ${masterState.unfollowedCount} of ${usersToUnfollow.length} users...`;
        broadcastUpdate();

        // Safety Delay
        await sleep(4000 + Math.random() * 2000);
    }

    // Persist updated results to storage after unfollowing
    await chrome.storage.local.set({ lastScanResults: masterState.followingList });

    masterState.status = 'idle';
    broadcastUpdate();
};
