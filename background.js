
import {
    sleep,
    urlGenerator,
    unfollowUserUrlGenerator,
    getCookie
} from './utils.js';

// -- State --
// We keep the state validation in memory.
// It resets when the service worker is killed, but that's okay for "active" scans.
// For "Auto-scan" we check persistent storage.
let masterState = {
    status: 'idle', // idle | scanning | unfolllowing
    progress: 0,
    scannedCount: 0,
    totalToScan: 0,
    scanCursor: null,
    results: [],
    snakes: [],
    scanHistory: [], // [NEW] v1.0 History
    lastDiff: null,  // [NEW] Most recent change summary
    unfollowQueue: [],
    currentTabId: null,
    lastScanTime: 0
};

// Load initial state
chrome.storage.local.get(['snakes', 'lastScanResults', 'scanHistory', 'lastScanTime'], (data) => {
    if (data.snakes) masterState.snakes = data.snakes;
    if (data.lastScanResults) masterState.results = data.lastScanResults;
    if (data.scanHistory) masterState.scanHistory = data.scanHistory;
    if (data.lastScanTime) masterState.lastScanTime = data.lastScanTime;
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

const startScanProcess = async (isAuto = false) => {
    if (masterState.status === 'scanning') return;

    // Ensure we have a target tab for the overlay
    if (!masterState.currentTabId) {
        const tabs = await chrome.tabs.query({ url: "*://www.instagram.com/*" });
        if (tabs && tabs.length > 0) {
            masterState.currentTabId = tabs[0].id; // Pick first main one
        }
    }

    masterState.status = 'scanning';
    masterState.results = []; // Reset results on new scan
    masterState.scannedCount = 0;
    masterState.scanCursor = null;
    masterState.totalToScan = -1;
    masterState.progress = 0;
    broadcastUpdate();

    // Logic similar to original popup.js but robust for background
    try {
        let hasNextPage = true;
        let consecutiveErrors = 0;

        while (hasNextPage && masterState.status === 'scanning') {
            const url = await urlGenerator(masterState.scanCursor);
            if (!url) {
                console.error("Failed to generate URL (missing cookies?)");
                masterState.status = 'error';
                broadcastUpdate();
                return;
            }

            try {
                const response = await fetch(url);
                const json = await response.json();

                if (!json.data || !json.data.user) {
                    throw new Error("Invalid structure");
                }

                const edgeFollow = json.data.user.edge_follow;
                if (masterState.totalToScan === -1) {
                    masterState.totalToScan = edgeFollow.count;
                }

                hasNextPage = edgeFollow.page_info.has_next_page;
                masterState.scanCursor = edgeFollow.page_info.end_cursor;

                const nodes = edgeFollow.edges.map(e => e.node);
                masterState.results.push(...nodes);
                masterState.scannedCount += nodes.length;

                // Update Progress
                const p = Math.min(100, Math.round((masterState.scannedCount / masterState.totalToScan) * 100));
                masterState.progress = p;
                broadcastUpdate();

                consecutiveErrors = 0;
                // Delay
                await sleep(1000 + Math.random() * 500);

            } catch (e) {
                console.warn("Fetch error", e);
                consecutiveErrors++;
                if (consecutiveErrors > 3) break;
                await sleep(2000);
            }
        }

        // Done
        masterState.status = 'idle';
        masterState.progress = 100;

        // [NEW] History Logic & Diffs
        // 1. Load Last Scan
        const storage = await chrome.storage.local.get(['lastScanResults']);
        const lastScan = storage.lastScanResults || [];
        let currentDiff = null;

        // If we have history, calculate diff
        if (lastScan.length > 0) {
            const currentIds = new Set(masterState.results.map(u => u.id));
            const lastIds = new Set(lastScan.map(u => u.id));

            // Snakes (Lost)
            const newSnakes = lastScan.filter(oldUser => !currentIds.has(oldUser.id));
            // New Followers (Gained)
            const gainedDetails = masterState.results.filter(newUser => !lastIds.has(newUser.id));

            // Update Snakes List
            const existingSnakeIds = new Set(masterState.snakes.map(s => s.id));
            newSnakes.forEach(snake => {
                if (!existingSnakeIds.has(snake.id)) {
                    snake.detected_at = Date.now();
                    masterState.snakes.push(snake);
                }
            });
            await chrome.storage.local.set({ snakes: masterState.snakes });

            // Create Diff Object
            currentDiff = {
                date: Date.now(),
                lost: newSnakes.length,
                gained: gainedDetails.length,
                net: gainedDetails.length - newSnakes.length
            };
            masterState.lastDiff = currentDiff;

            // Update History
            masterState.scanHistory.unshift({
                date: Date.now(),
                stats: {
                    followers: masterState.results.length,
                    snakes: masterState.snakes.length
                },
                diff: currentDiff
            });

            // Trim history to last 50 entries to save space
            if (masterState.scanHistory.length > 50) masterState.scanHistory = masterState.scanHistory.slice(0, 50);

            await chrome.storage.local.set({
                scanHistory: masterState.scanHistory,
                lastScanTime: Date.now()
            });
        } else {
            // First run ever
            await chrome.storage.local.set({ lastScanTime: Date.now() });
        }

        // 3. Save Current as Last
        await chrome.storage.local.set({ lastScanResults: masterState.results });

        if (isAuto) {
            chrome.storage.local.set({ lastAutoScanTime: Date.now() });
        }

        masterState.lastScanTime = Date.now();
        broadcastUpdate();

    } catch (err) {
        console.error("Scan fatal error", err);
        masterState.status = 'error';
        broadcastUpdate();
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
        return;
    }

    let processed = 0;
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

        processed++;
        masterState.progress = Math.round((processed / usersToUnfollow.length) * 100);
        broadcastUpdate();

        // Safety Delay
        await sleep(4000 + Math.random() * 2000);
    }

    masterState.status = 'idle';
    broadcastUpdate();
};
