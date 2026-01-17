
import {
    sleep,
    urlGenerator,
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
    results: [],
    snakes: [], // [NEW] Lost connections
    unfollowQueue: [],
    currentTabId: null
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
    if (data.lastScanResults) masterState.results = data.lastScanResults;
});

// Enable autoscan by default on first install
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.storage.local.set({ enableAutoScan: true });
        console.log('Auto-scan enabled by default on first install');
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
        const settings = await chrome.storage.local.get(['enableAutoScan', 'lastAutoScanTime']);
        if (settings.enableAutoScan) {
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

// -- Main Scan Process --
const startScanProcess = async (isAuto = false) => {
    if (masterState.status === 'scanning') return;
    masterState.status = 'scanning';
    masterState.results = []; // Following List (For Unfollowers)
    masterState.fanList = []; // Followers List (For Snakes)
    masterState.scanCursor = null;
    masterState.totalToScan = -1;
    masterState.progress = 0;
    broadcastUpdate();

    try {
        // 1. Fetch User Profile First (Get Baseline Counts)
        const profileData = await fetchUserProfile();
        const currentFollowerCount = profileData?.followerCount || 0;
        const currentFollowingCount = profileData?.followingCount || 0;

        // PHASE 1: Scan "Following" List (To find Unfollowers)
        // Unfollowers = People I follow who don't follow me back
        masterState.totalToScan = currentFollowingCount;
        let hasNextPage = true;
        let consecutiveErrors = 0;

        while (hasNextPage && masterState.status === 'scanning') {
            const url = await urlGenerator(masterState.scanCursor);
            if (!url) throw new Error("Failed to generate URL");

            try {
                const response = await fetch(url);
                const json = await response.json();

                if (!json.data?.user) throw new Error("Invalid structure");

                const edgeFollow = json.data.user.edge_follow;
                // Update total if needed, though we set it from profile
                if (masterState.totalToScan === -1) masterState.totalToScan = edgeFollow.count;

                hasNextPage = edgeFollow.page_info.has_next_page;
                masterState.scanCursor = edgeFollow.page_info.end_cursor;

                const nodes = edgeFollow.edges.map(e => e.node);
                masterState.results.push(...nodes);
                masterState.scannedCount += nodes.length;

                // Progress (0-50% for Phase 1)
                const phase1Progress = (masterState.results.length / masterState.totalToScan) * 50;
                masterState.progress = Math.min(50, Math.round(phase1Progress));
                broadcastUpdate();

                consecutiveErrors = 0;
                await sleep(1000 + Math.random() * 500);

            } catch (e) {
                console.warn("Fetch error (Following)", e);
                consecutiveErrors++;
                if (consecutiveErrors > 3) break;
                await sleep(2000);
            }
        }

        // PHASE 2: Scan "Followers" List (To find Snakes)
        // Snakes = People who were in Last Fan List but are NOT in Current Fan List
        masterState.scanCursor = null; // Reset for Phase 2
        hasNextPage = true;
        consecutiveErrors = 0;
        const totalFollowers = currentFollowerCount;

        while (hasNextPage && masterState.status === 'scanning') {
            const url = await followersUrlGenerator(masterState.scanCursor);
            if (!url) break; // Should fail if no generator or cookie

            try {
                const response = await fetch(url);
                const json = await response.json();

                if (!json.data?.user) throw new Error("Invalid structure phase 2");

                const edgeFollowedBy = json.data.user.edge_followed_by;
                hasNextPage = edgeFollowedBy.page_info.has_next_page;
                masterState.scanCursor = edgeFollowedBy.page_info.end_cursor;

                const nodes = edgeFollowedBy.edges.map(e => e.node);
                masterState.fanList.push(...nodes);

                // Progress (50-100% for Phase 2)
                const phase2Progress = (masterState.fanList.length / totalFollowers) * 50;
                masterState.progress = Math.min(100, Math.round(50 + phase2Progress));
                broadcastUpdate();

                consecutiveErrors = 0;
                await sleep(1000 + Math.random() * 500);

            } catch (e) {
                console.warn("Fetch error (Followers)", e);
                consecutiveErrors++;
                if (consecutiveErrors > 3) break;
                await sleep(2000);
            }
        }

        masterState.status = 'idle';
        masterState.progress = 100;

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
        }

        // 4. Update History (For Net Growth Graph)
        const scanHistory = storage.scanHistory || [];
        const historyEntry = {
            timestamp: Date.now(),
            followingCount: masterState.results.length,
            followerCount: masterState.fanList.length, // Accurate from scan
            newSnakesCount: newSnakes.length
        };

        scanHistory.push(historyEntry);
        if (scanHistory.length > 30) scanHistory.shift();

        // 5. Save State
        masterState.snakes = previousSnakes;
        await chrome.storage.local.set({
            lastScanResults: masterState.results, // Save Following List for Unfollower identification in UI
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
            masterState.results = masterState.results.filter(u => u.id !== userId);

        } catch (e) {
            console.error(`Failed to unfollow ${userId}`, e);
        }

        masterState.unfollowedCount++;
        masterState.progress = Math.round((masterState.unfollowedCount / usersToUnfollow.length) * 100);
        broadcastUpdate();

        // Safety Delay
        await sleep(4000 + Math.random() * 2000);
    }

    // Persist updated results to storage after unfollowing
    await chrome.storage.local.set({ lastScanResults: masterState.results });

    masterState.status = 'idle';
    broadcastUpdate();
};
