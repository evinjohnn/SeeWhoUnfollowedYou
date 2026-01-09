
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
    snakes: [], // [NEW] Lost connections
    unfollowQueue: [],
    currentTabId: null
};

// Load initial state (snakes need to persist)
chrome.storage.local.get(['snakes', 'lastScanResults'], (data) => {
    if (data.snakes) masterState.snakes = data.snakes;
    if (data.lastScanResults) masterState.results = data.lastScanResults;
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

const startScanProcess = async (isAuto = false) => {
    if (masterState.status === 'scanning') return;

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

        // [NEW] History Logic
        // 1. Load Last Scan
        const storage = await chrome.storage.local.get(['lastScanResults']);
        const lastScan = storage.lastScanResults || []; // Array of users

        let newSnakes = [];

        if (lastScan.length > 0) {
            // 2. Identify Snakes:
            // Users who were in lastScan (I followed them) 
            // BUT are NOT in masterState.results (I don't follow them anymore)

            const currentIds = new Set(masterState.results.map(u => u.id));
            newSnakes = lastScan.filter(oldUser => !currentIds.has(oldUser.id));

            // [FIX] Clean up existing snakes: 
            // If a known snake is now in currentIds (followed back), remove them from snakes list
            masterState.snakes = masterState.snakes.filter(snake => !currentIds.has(snake.id));

            // Add new snakes to master list (avoid duplicates)
            const existingSnakeIds = new Set(masterState.snakes.map(s => s.id));
            newSnakes.forEach(snake => {
                if (!existingSnakeIds.has(snake.id)) {
                    // Mark detection date
                    snake.detected_at = Date.now();
                    masterState.snakes.push(snake);
                }
            });

            // Persist Snakes
            await chrome.storage.local.set({ snakes: masterState.snakes });
        }

        // 3. Save Current as Last + Timestamp for cooldown indicator
        // Also save to scan history for comparison
        const currentScanData = {
            timestamp: Date.now(),
            followingCount: masterState.results.length,
            followersCount: masterState.results.length, // Using result length as proxy for now if followers not separately tracked
            newSnakesCount: newSnakes.length
        };

        // Load existing scan history
        const historyStorage = await chrome.storage.local.get(['scanHistory']);
        const scanHistory = historyStorage.scanHistory || [];

        // Add current scan to history (keep last 10 scans)
        scanHistory.push(currentScanData);
        if (scanHistory.length > 10) {
            scanHistory.shift(); // Remove oldest
        }

        await chrome.storage.local.set({
            lastScanResults: masterState.results,
            lastScanTime: Date.now(),
            scanHistory: scanHistory
        });

        if (isAuto) {
            chrome.storage.local.set({ lastAutoScanTime: Date.now() });
        }

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
