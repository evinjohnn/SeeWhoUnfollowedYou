
import {
    getUsersForDisplay,
    loadWhitelist,
    saveWhitelist,
    addToWhitelist,
    removeFromWhitelist
} from './utils.js';

// -- State (Client Side) --
let state = {
    // We synchronize this with Background
    status: 'initial',
    results: [],
    snakes: [], // [NEW] History source
    whitelisted: [],
    selectedUsers: new Set(),
    currentTab: 'strangers',
    searchTerm: '',
    progress: 0,
    scannedCount: 0,
    filters: {
        showVerified: true,
        showPrivate: true,
        showFollowers: false,
        showNonFollowers: true,
        showWithOutProfilePicture: true
    }
};

// -- UI Elements --
const views = {
    start: document.getElementById('view-start'),
    scanning: document.getElementById('view-scanning'),
    results: document.getElementById('view-results')
};

const ui = {
    btnScan: document.getElementById('btn-scan'),
    btnSettings: document.getElementById('btn-settings'),
    btnUnfollowSelected: document.getElementById('btn-unfollow-selected'),
    btnWhitelistSelected: document.getElementById('btn-whitelist-selected'),
    btnRemoveSelected: document.getElementById('btn-remove-whitelisted-selected'),
    scanProgress: document.getElementById('scan-progress'),
    scanPercentage: document.getElementById('scan-percentage'),
    scanningText: document.getElementById('scanning-text'),
    scanningSubtext: document.getElementById('scanning-subtext'),
    resultsList: document.getElementById('results-list'),
    searchInput: document.getElementById('search-input'),
    countStrangers: document.getElementById('count-strangers'),
    countSnakes: document.getElementById('count-snakes'),
    countWhitelisted: document.getElementById('count-whitelisted'),
    tabs: document.querySelectorAll('.tab-btn'),
    tabsContainer: document.querySelector('.tabs'),
    selectedCount: document.getElementById('selected-count'),
    modalSettings: document.getElementById('modal-settings'),
    btnSaveSettings: document.getElementById('btn-save-settings'),
    inputScanDelay: document.getElementById('setting-scan-delay'),
    inputUnfollowDelay: document.getElementById('setting-unfollow-delay'),
    toggleAutoScan: document.getElementById('setting-autoscan'),
    btnCloseModals: document.querySelectorAll('.btn-close-modal'),
    filterVerified: document.getElementById('filter-verified'),
    filterPrivate: document.getElementById('filter-private'),
    // Dashboard Elements
    firstRunState: document.getElementById('first-run-state'),
    returningUserState: document.getElementById('returning-user-state'),
    btnNavToggle: document.getElementById('btn-nav-toggle'),
    summarySentence: document.getElementById('summary-sentence'),
    // Banner Elements
    completionBanner: document.getElementById('scan-completion-banner'),
    bannerHeadline: document.getElementById('banner-headline'),
    bannerDetail: document.getElementById('banner-detail'),
    // Cooldown Elements
    lastScanTime: document.getElementById('last-scan-time'),
    cooldownWarning: document.getElementById('cooldown-warning'),
    // Timeline Elements
    timelineContainer: document.getElementById('timeline-container'),
    timelineList: document.getElementById('timeline-list'),
    // Rescan Button
    btnScanAgain: document.getElementById('btn-scan-again')
};

// -- Cooldown Constants --
const RECOMMENDED_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours in ms

// -- Format Relative Time --
const formatRelativeTime = (timestamp) => {
    if (!timestamp) return 'Never';

    const now = Date.now();
    const diff = now - timestamp;

    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d ago`;

    // For older scans, show date
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

// -- Generate Summary Text --
// Compares current scan with previous to generate a human-readable summary sentence
const generateSummaryText = (currentResults, snakes, lastScanTime, newSnakesCount) => {
    // Prefer explicit newSnakesCount from scan history if available
    const lossCount = typeof newSnakesCount === 'number' ? newSnakesCount : (snakes?.length || 0);
    const timeAgo = formatRelativeTime(lastScanTime);

    // Build summary parts
    const parts = [];

    if (lossCount > 0) {
        parts.push(`${lossCount} ${lossCount === 1 ? 'person' : 'people'} unfollowed you`);
    }

    if (parts.length === 0) {
        // No changes detected
        return `No follower changes since ${timeAgo.toLowerCase()}`;
    }

    // Join parts with relative time
    return `${parts.join(' and ')} since ${timeAgo.toLowerCase()}`;
};

// -- Show Completion Banner --
// Displays scan completion banner with comparison summary
const showCompletionBanner = async () => {
    const storage = await chrome.storage.local.get(['scanHistory', 'lastScanResults', 'snakes']);
    const scanHistory = storage.scanHistory || [];
    const currentResults = storage.lastScanResults || [];
    const snakes = storage.snakes || [];

    let detailText = '';

    if (scanHistory.length === 0) {
        // First scan
        detailText = 'First scan completed';
    } else {
        // Compare with previous scan
        const previousScan = scanHistory[scanHistory.length - 1];
        const currentCount = currentResults.length;
        const previousCount = previousScan.followingCount || 0;
        const snakesCount = snakes.length;

        const diff = currentCount - previousCount;
        const timeAgo = formatRelativeTime(previousScan.timestamp);

        if (snakesCount > 0 && diff !== 0) {
            // Both changes
            const diffText = diff > 0 ? `+${diff} followers` : `${diff} followers`;
            detailText = `${diffText} · ${snakesCount} unfollowed since ${timeAgo.toLowerCase()}`;
        } else if (snakesCount > 0) {
            // Only unfollows
            detailText = `${snakesCount} ${snakesCount === 1 ? 'person' : 'people'} unfollowed you since ${timeAgo.toLowerCase()}`;
        } else if (diff !== 0) {
            // Only follower count change
            const diffText = diff > 0 ? `+${diff} followers` : `${diff} followers`;
            detailText = `${diffText} since ${timeAgo.toLowerCase()}`;
        } else {
            // No changes
            detailText = `No follower changes since ${timeAgo.toLowerCase()}`;
        }
    }

    // Update banner content
    ui.bannerDetail.textContent = detailText;

    // Show banner
    ui.completionBanner.classList.remove('hidden', 'fade-out');

    // Auto-dismiss after 5 seconds
    setTimeout(() => {
        ui.completionBanner.classList.add('fade-out');
        setTimeout(() => {
            ui.completionBanner.classList.add('hidden');
        }, 300); // Match animation duration
    }, 5000);
};

// -- Update Cooldown Indicator --
// Updates the cooldown indicator with time since last scan
const updateCooldownIndicator = (lastScanTime) => {
    if (!lastScanTime) {
        ui.lastScanTime.textContent = 'Last scanned: Never';
        ui.cooldownWarning.classList.add('hidden');
        return;
    }

    const timeSince = Date.now() - lastScanTime;
    const timeAgo = formatRelativeTime(lastScanTime);

    ui.lastScanTime.textContent = `Last scanned: ${timeAgo}`;

    // Show warning if scanned within recommended cooldown period
    if (timeSince < RECOMMENDED_COOLDOWN_MS) {
        ui.cooldownWarning.classList.remove('hidden');
    } else {
        ui.cooldownWarning.classList.add('hidden');
    }
};

// -- Render Timeline View --
const renderTimeline = async () => {
    const storage = await chrome.storage.local.get(['scanHistory', 'snakes']);
    const history = storage.scanHistory || [];
    const snakes = storage.snakes || [];

    // Clear list
    ui.timelineList.innerHTML = '';

    if (history.length === 0 && snakes.length === 0) {
        ui.timelineContainer.classList.add('hidden');
        return;
    }

    ui.timelineContainer.classList.remove('hidden');

    // Grouping Buckets
    const groups = {
        today: { label: 'Today', unfollows: 0, startCount: null, endCount: null },
        yesterday: { label: 'Yesterday', unfollows: 0, startCount: null, endCount: null },
        thisWeek: { label: 'This Week', unfollows: 0, startCount: null, endCount: null }
    };

    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;

    // 1. Count Unfollows per bucket
    // For "Today": Use only the LATEST scan's newSnakesCount (not cumulative)
    // This ensures forced scans refresh the Today count rather than accumulating

    // Get the most recent scan for "Today"
    const sortedHistory = [...history].sort((a, b) => b.timestamp - a.timestamp);
    const latestScan = sortedHistory[0];

    if (latestScan && (now - latestScan.timestamp) < ONE_DAY) {
        // Latest scan is from today - use its snake count
        groups.today.unfollows = latestScan.newSnakesCount || 0;
    } else {
        // No scan today
        groups.today.unfollows = 0;
    }

    // For yesterday and this week, count snakes by detected_at
    // (these are historical and don't need the "refresh" behavior)
    snakes.forEach(snake => {
        if (!snake.detected_at) return;
        const diff = now - snake.detected_at;

        if (diff >= ONE_DAY && diff < 2 * ONE_DAY) {
            groups.yesterday.unfollows++;
        } else if (diff >= 2 * ONE_DAY && diff < 7 * ONE_DAY) {
            groups.thisWeek.unfollows++;
        }
    });

    // 2. Net Change (using history snapshots)
    // We need to associate history entries with buckets to find stats
    // Ideally we want: (Last scan in bucket) - (First scan in bucket/Last scan before bucket)

    // Assign counts to buckets (reusing sortedHistory from above)
    // We iterate history to find the 'latest' and 'earliest' for each bucket

    const updateBucketCounts = (bucket, entry) => {
        if (bucket.endCount === null) bucket.endCount = entry.followingCount; // First one we see is latest
        bucket.startCount = entry.followingCount; // Keep updating to find earliest
    };

    sortedHistory.forEach(entry => {
        const diff = now - entry.timestamp;
        if (diff < ONE_DAY) {
            updateBucketCounts(groups.today, entry);
        } else if (diff < 2 * ONE_DAY) {
            updateBucketCounts(groups.yesterday, entry);
        } else if (diff < 7 * ONE_DAY) {
            updateBucketCounts(groups.thisWeek, entry);
        }
    });

    // 3. Render Items
    const fragment = document.createDocumentFragment();
    const buckets = [groups.today]; // Only show Today

    let hasItems = false;

    buckets.forEach(group => {
        // Determine Net Change
        let netChange = 0;
        if (group.startCount !== null && group.endCount !== null) {
            // Net for this period
            // Actually, strictly speaking: End - Start. 
            // But if we only have 1 scan, net is 0?
            // Or compared to "previous bucket"?
            // Let's stick to unfollows count as primary signal if available.
            netChange = group.endCount - group.startCount;
        }

        // Decide what to show
        // Prioritize Unfollows if > 0
        // Else Net Change if !== 0
        // Else skip (unless Today and empty? Maybe show "No changes"?)
        // User said: "Today -> X unfollows"

        let labelHTML = '';
        let className = 'timeline-change';

        if (group.unfollows > 0) {
            // e.g. "2 Unfollows"
            labelHTML = `<span>-${group.unfollows} Unfollows</span>`;
            className += ' negative'; // or normal? User said muted.
        } else if (netChange !== 0) {
            const sign = netChange > 0 ? '+' : '';
            labelHTML = `<span>${sign}${netChange} Followers</span>`;
            className += netChange > 0 ? ' positive' : ' negative';
        } else {
            // No activity to show for this bucket
            return;
        }

        hasItems = true;

        const div = document.createElement('div');
        div.className = 'timeline-item';
        div.innerHTML = `
            <span class="timeline-date">${group.label}</span>
            <div class="${className}">
                ${labelHTML}
            </div>
        `;
        fragment.appendChild(div);
    });

    if (hasItems) {
        ui.timelineList.appendChild(fragment);
        ui.timelineContainer.classList.remove('hidden');
    } else {
        // Show +0 Followers to match the format when there are changes
        ui.timelineContainer.classList.remove('hidden');
        const div = document.createElement('div');
        div.className = 'timeline-item';
        div.innerHTML = `
            <span class="timeline-date">Today</span>
            <div class="timeline-change">
                <span>+0 Followers</span>
            </div>
        `;
        ui.timelineList.appendChild(div);
    }
};

ui.tabs.forEach(tab => {
    tab.addEventListener('click', (e) => switchTab(e.currentTarget.dataset.tab));
});

// ... (existing listeners) ...

// -- Clout Tracker Renderer --
const renderCloutTracker = (scanHistory) => {
    // DOM Elements for Clout Tracker
    const cloutTracker = document.querySelector('.clout-tracker');
    const growthSparkline = document.getElementById('growth-sparkline');
    const cloutChange = document.getElementById('clout-change');

    if (!scanHistory || scanHistory.length === 0) {
        if (cloutTracker) cloutTracker.classList.add('hidden');
        return;
    }

    if (cloutTracker) cloutTracker.classList.remove('hidden');

    // Use actual follower counts from scan history
    // Each scan now stores followerCount - the real follower count from profile API
    const recentHistory = scanHistory.slice(-7); // Last 7 scans
    const points = recentHistory.map(scan => scan.followerCount || scan.followingCount || 0);

    // Allow rendering with 1 point (show flat line)
    if (points.length === 0) return;

    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min || 1;

    // SVG Generation Constants
    const width = 200;
    const height = 40;
    const padding = 2;
    const step = width / (points.length - 1);

    // Calculate Y coordinates
    const getY = (val) => height - padding - ((val - min) / range * (height - padding * 2));

    let pathData = `M 0 ${getY(points[0])}`;

    if (points.length === 1) {
        // Draw flat line across width for single point
        pathData += ` L ${width} ${getY(points[0])}`;
    } else {
        for (let i = 1; i < points.length; i++) {
            const cp1x = (i - 1) * step + step / 2;
            const cp2x = i * step - step / 2;
            pathData += ` C ${cp1x} ${getY(points[i - 1])} ${cp2x} ${getY(points[i])} ${i * step} ${getY(points[i])}`;
        }
    }

    // Determine gradient color based on trend (up = green, down = red)
    const trendUp = points[points.length - 1] >= points[0];
    const gradientColor = trendUp ? 'var(--status-success)' : 'var(--status-error)';
    const strokeColor = trendUp ? 'var(--status-success)' : 'var(--status-error)';

    const svg = `
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
            <defs>
                <linearGradient id="cloutGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" style="stop-color:${gradientColor};stop-opacity:0.25" />
                    <stop offset="100%" style="stop-color:${gradientColor};stop-opacity:0" />
                </linearGradient>
            </defs>
            <path d="${pathData} L ${width} ${height} L 0 ${height} Z" fill="url(#cloutGradient)" style="opacity: 0.5;" />
            <path d="${pathData}" fill="none" stroke="${strokeColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
    `;

    if (growthSparkline) growthSparkline.innerHTML = svg;

    // Calculate 24h change
    // Find the reference point: the most recent scan from MORE than 24h ago
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;

    const latestScan = scanHistory[scanHistory.length - 1];

    // Find reference scan (most recent scan older than 24h)
    let referenceScan = null;
    for (let i = scanHistory.length - 2; i >= 0; i--) {
        if (now - scanHistory[i].timestamp >= ONE_DAY) {
            referenceScan = scanHistory[i];
            break;
        }
    }

    // If no scan older than 24h, use the oldest available scan
    if (!referenceScan) {
        referenceScan = scanHistory[0];
    }

    // Calculate follower growth/decline (use followerCount with fallback)
    const latestFollowers = latestScan.followerCount || latestScan.followingCount || 0;
    const referenceFollowers = referenceScan.followerCount || referenceScan.followingCount || 0;
    const netChange = latestFollowers - referenceFollowers;

    if (cloutChange) {
        if (netChange === 0) {
            cloutChange.textContent = '0';
            cloutChange.style.color = 'var(--text-secondary)';
        } else if (netChange > 0) {
            cloutChange.textContent = `+${netChange}`;
            cloutChange.style.color = 'var(--status-success)';
        } else {
            cloutChange.textContent = `${netChange}`;
            cloutChange.style.color = 'var(--status-error)';
        }
        cloutChange.style.background = 'transparent';
    }
};

const checkReturningUser = async () => {
    const storage = await chrome.storage.local.get(['lastScanResults', 'lastScanTime', 'snakes', 'scanHistory']);
    const hasPreviousScan = storage.lastScanResults && storage.lastScanResults.length > 0;

    if (hasPreviousScan) {
        // Populate global state immediately
        state.results = storage.lastScanResults;
        state.snakes = storage.snakes || [];

        // Show returning user view with summary
        ui.firstRunState.classList.add('hidden');
        ui.returningUserState.classList.remove('hidden');

        // Generate and display summary sentence
        const latestHistory = storage.scanHistory?.[storage.scanHistory.length - 1];
        const newSnakesCount = latestHistory?.newSnakesCount ?? 0;

        const summaryText = generateSummaryText(
            storage.lastScanResults,
            storage.snakes,
            storage.lastScanTime,
            newSnakesCount
        );
        ui.summarySentence.textContent = summaryText;

        // Update cooldown indicator
        updateCooldownIndicator(storage.lastScanTime);

        // Render Timeline
        renderTimeline();

        // Render Clout Tracker
        renderCloutTracker(storage.scanHistory);
    } else {
        // First run - show simple scan button only
        ui.firstRunState.classList.remove('hidden');
        ui.returningUserState.classList.add('hidden');
    }
};

// -- Init --
const init = async () => {
    state.whitelisted = await loadWhitelist();
    renderCounts();

    // Check if returning user and show appropriate view (before any other rendering)
    await checkReturningUser();

    // Start onboarding tour for first-time users (with small delay for DOM to settle)
    setTimeout(() => startTour(), 500);

    // Listeners
    ui.btnScan.addEventListener('click', startScan);
    if (ui.btnScanAgain) ui.btnScanAgain.addEventListener('click', startScan);
    ui.btnNavToggle.addEventListener('click', handleNavToggle);
    ui.btnSettings.addEventListener('click', () => toggleModal(ui.modalSettings, true));
    ui.btnCloseModals.forEach(btn => btn.addEventListener('click', () => toggleModal(ui.modalSettings, false)));


    ui.tabs.forEach(tab => {
        tab.addEventListener('click', (e) => switchTab(e.currentTarget.dataset.tab));
    });

    ui.searchInput.addEventListener('input', (e) => {
        state.searchTerm = e.target.value;
        renderResults();
    });



    // Profile Redirection (Only on avatar or username click)
    ui.resultsList.addEventListener('click', (e) => {
        // Only redirect if clicking on avatar image or username text
        const isAvatarClick = e.target.closest('.user-avatar');
        const isUsernameClick = e.target.closest('.user-name');

        if (!isAvatarClick && !isUsernameClick) return;

        // Ignore clicks on checkbox or any interactive buttons inside
        if (e.target.type === 'checkbox' || e.target.tagName === 'BUTTON') return;

        const item = e.target.closest('.user-item');
        if (!item) return;

        // Find the username element
        const usernameEl = item.querySelector('.user-name');
        if (usernameEl) {
            const usernameNode = usernameEl.childNodes[0];
            const username = usernameNode ? usernameNode.textContent.trim() : usernameEl.textContent.trim();
            if (username && !username.includes('<')) {
                chrome.tabs.create({ url: `https://www.instagram.com/${username}/` });
            }
        }
    });

    ui.btnUnfollowSelected.addEventListener('click', startUnfollowProcess);
    if (ui.btnWhitelistSelected) ui.btnWhitelistSelected.addEventListener('click', startWhitelistProcess);
    if (ui.btnRemoveSelected) ui.btnRemoveSelected.addEventListener('click', startRemoveFromWhitelistProcess);


    // Restart Tour Button
    const btnRestartTour = document.getElementById('btn-restart-tour');
    if (btnRestartTour) {
        btnRestartTour.addEventListener('click', async () => {
            console.log('Restarting tour...');
            // Reset flags
            await chrome.storage.local.set({
                tourPart1Complete: false,
                tourPart2Complete: false,
                onboardingComplete: false
            });

            // Close modal
            ui.modalSettings.classList.remove('active');

            // Start tour part 1
            setTimeout(() => {
                if (typeof startTourPart1 === 'function') {
                    startTourPart1();
                } else {
                    console.error('startTourPart1 function not found');
                }
            }, 300);
        });
    }

    // Save Settings
    if (ui.btnSaveSettings) {
        ui.btnSaveSettings.addEventListener('click', async () => {
            const scanDelay = parseInt(ui.inputScanDelay.value, 10);
            const unfollowDelay = parseInt(ui.inputUnfollowDelay.value, 10);
            const autoScan = ui.toggleAutoScan.checked;

            await chrome.storage.local.set({
                scanDelay,
                unfollowDelay,
                enableAutoScan: autoScan
            });

            // Update alarms
            chrome.runtime.sendMessage({
                type: 'UPDATE_ALARM',
                payload: { enableAutoScan: autoScan }
            });

            ui.modalSettings.classList.remove('active');
            // Assuming showToast is defined globally or we need to check
            if (typeof showToast === 'function') {
                showToast('Settings saved successfully!', 'success');
            }
        });
    }

    // Load Settings
    const settings = await chrome.storage.local.get(['enableAutoScan']);
    if (settings.enableAutoScan) {
        ui.toggleAutoScan.checked = true;
    }

    // Connect to Background
    syncWithBackground();

    // Listen for updates from Background
    chrome.runtime.onMessage.addListener((request) => {
        if (request.type === 'STATE_UPDATE') {
            updateFromBackground(request.payload);
        }
    });
};

// -- Show Previous Results --
const showPreviousResults = async () => {
    const storage = await chrome.storage.local.get(['lastScanResults', 'snakes']);

    if (storage.lastScanResults) {
        state.results = storage.lastScanResults;
        state.snakes = storage.snakes || [];
        state.status = 'results';

        switchView('results');
        renderCounts();
        renderResults();

        // Update nav button to "Details"
        ui.btnNavToggle.textContent = 'Details';

        // Start Tour Part 2 after scan results are shown
        setTimeout(() => startTourPart2(), 500);
    }
};

// -- Handle Navigation Toggle --
// Toggles between greeting page (start) and results page
const handleNavToggle = async () => {
    const isOnResults = document.getElementById('view-results').classList.contains('active');

    if (isOnResults) {
        // Go back to greeting page
        await checkReturningUser();
        switchView('start');
        ui.btnNavToggle.textContent = 'Results';
    } else {
        // Check if first scan has been done
        const storage = await chrome.storage.local.get(['lastScanResults']);
        if (!storage.lastScanResults || storage.lastScanResults.length === 0) {
            showToast('Run your first scan to see results', 'info');
            return;
        }
        // Go to results page
        await showPreviousResults();
    }
};

const syncWithBackground = async () => {
    try {
        const bgState = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
        if (bgState) updateFromBackground(bgState);
    } catch (e) {
        console.warn("Background service not ready?", e);
    }
};

const updateFromBackground = (bgState) => {
    // Merge state from background
    state.results = bgState.results || [];
    state.snakes = bgState.snakes || [];
    state.progress = bgState.progress || 0;
    state.scannedCount = bgState.scannedCount || 0;

    // Determine which view to show based on background status
    // When idle: show start view (which contains first-run OR returning user summary)
    // When scanning/unfollowing: show scanning view
    // Results view is only shown when user explicitly clicks "See details"

    if (bgState.status === 'scanning' || bgState.status === 'unfollowing') {
        // Active operation: show scanning progress
        state.status = bgState.status;
        switchView('scanning');
        ui.scanningText.textContent = bgState.status === 'scanning' ? "Scanning..." : "Unfollowing...";
        const count = bgState.status === 'scanning' ? state.scannedCount : (bgState.unfollowedCount || 0);
        const noun = bgState.status === 'scanning' ? 'users' : 'processed';
        ui.scanningSubtext.textContent = `${count} ${noun}...`;
        ui.scanProgress.style.width = `${state.progress}%`;
        ui.scanPercentage.textContent = `${state.progress}%`;
    } else if (bgState.status === 'idle') {
        // Idle: check if scan just completed
        const wasScanningBefore = state.status === 'scanning';
        state.status = state.results.length > 0 ? 'results' : 'initial';

        // If scan just completed, go to results page
        if (document.getElementById('view-scanning').classList.contains('active')) {
            if (wasScanningBefore && state.results.length > 0) {
                // Scan completed - go to results page
                showPreviousResults();
                showCompletionBanner();
            } else {
                // No results - stay on start
                checkReturningUser();
                switchView('start');
            }
        }
    }
};

const startScan = async () => {
    try {
        await chrome.runtime.sendMessage({ type: 'START_SCAN' });
        // The background script will send broadcast update to switch our view
    } catch (e) {
        showToast('Failed to start scan', 'error');
    }
};

const startUnfollowProcess = async () => {
    if (state.selectedUsers.size === 0) return;

    // Safety limit to prevent Instagram rate limiting/bans
    const MAX_UNFOLLOW_BATCH = 50;
    if (state.selectedUsers.size > MAX_UNFOLLOW_BATCH) {
        showToast(`Please select max ${MAX_UNFOLLOW_BATCH} users at a time to avoid rate limits`, 'error');
        return;
    }

    if (!confirm(`Unfollow ${state.selectedUsers.size} users?`)) return;

    const users = Array.from(state.selectedUsers);
    await chrome.runtime.sendMessage({ type: 'START_UNFOLLOW', users });
};

const startWhitelistProcess = async () => {
    if (state.selectedUsers.size === 0) return;

    const usersToWhitelist = Array.from(state.selectedUsers);

    // We need the full user objects, not just IDs
    const userObjects = usersToWhitelist.map(id => {
        const source = state.currentTab === 'snakes' ? state.snakes : state.results;
        return source.find(u => u.id === id);
    }).filter(Boolean);

    for (const user of userObjects) {
        state.whitelisted = await addToWhitelist(user);
    }

    state.selectedUsers.clear();
    updateSelectionUI();
    renderCounts();
    renderResults();

    showToast(`Added ${userObjects.length} users to whitelist`, 'success');
};

const startRemoveFromWhitelistProcess = async () => {
    if (state.selectedUsers.size === 0) return;

    const usersToRemove = Array.from(state.selectedUsers);

    for (const userId of usersToRemove) {
        state.whitelisted = await removeFromWhitelist(userId);
    }

    state.selectedUsers.clear();
    updateSelectionUI();
    renderCounts();
    renderResults();

    showToast(`Removed ${usersToRemove.length} users from whitelist`, 'success');
};

// -- UI Logic --
const switchView = (viewName) => {
    Object.values(views).forEach(el => el.classList.remove('active'));
    views[viewName].classList.add('active');
};

const updateSelectionUI = () => {
    const count = state.selectedUsers.size;

    // Update main counter (used in unfollow button)
    if (ui.selectedCount) ui.selectedCount.textContent = count > 0 ? count : 0;

    const hasSelection = count > 0;

    // Unfollow Button
    ui.btnUnfollowSelected.disabled = !hasSelection;

    // Whitelist Button
    if (ui.btnWhitelistSelected) {
        ui.btnWhitelistSelected.disabled = !hasSelection;
        const whitelistCounter = document.getElementById('whitelist-selected-count');
        if (whitelistCounter) whitelistCounter.textContent = count > 0 ? count : 0;
    }

    // Remove Button
    if (ui.btnRemoveSelected) {
        ui.btnRemoveSelected.disabled = !hasSelection;
        const removeCounter = document.getElementById('remove-whitelisted-count');
        if (removeCounter) removeCounter.textContent = count > 0 ? count : 0;
    }
};

const toggleModal = (modal, show) => {
    if (show) modal.classList.add('open');
    else modal.classList.remove('open');
};

const switchTab = (tabName) => {
    state.currentTab = tabName;

    // Tab name to index mapping
    const tabIndexMap = { strangers: 0, snakes: 1, whitelisted: 2 };
    const tabIndex = tabIndexMap[tabName] ?? 0;

    // Update sliding indicator position via data attribute
    ui.tabsContainer.setAttribute('data-active-tab', tabIndex);

    // Update active states
    ui.tabs.forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tabName);
    });

    // Show/Hide Footer based on tab
    // Strangers: Show (Whitelist/Unfollow)
    // Snakes: Hide (Read-only)
    // Whitelisted: Show (Remove)
    const footer = ui.btnUnfollowSelected.parentElement;
    if (tabName === 'snakes') {
        footer.classList.add('hidden');
    } else {
        footer.classList.remove('hidden');
    }

    // Toggle specific buttons based on tab
    const isWhitelistedTab = tabName === 'whitelisted';
    if (ui.btnWhitelistSelected) ui.btnWhitelistSelected.classList.toggle('hidden', isWhitelistedTab);
    if (ui.btnUnfollowSelected) ui.btnUnfollowSelected.classList.toggle('hidden', isWhitelistedTab);
    if (ui.btnRemoveSelected) ui.btnRemoveSelected.classList.toggle('hidden', !isWhitelistedTab);

    state.selectedUsers.clear();
    updateSelectionUI();
    renderResults();
};

const renderCounts = () => {
    const totalRaw = state.results.length;
    const whitelistedCount = state.whitelisted.length;
    ui.countWhitelisted.textContent = whitelistedCount;

    // Strangers: In results, NOT in whitelist AND NOT mutual (follows_viewer)
    const strangersCount = totalRaw > 0
        ? state.results.filter(u => !state.whitelisted.some(w => w.id === u.id) && !u.follows_viewer).length
        : 0;
    ui.countStrangers.textContent = strangersCount;

    // Snakes: From history list
    const snakesCount = state.snakes.length;
    ui.countSnakes.textContent = snakesCount;

    // Grey out zero counts, colorize non-zero
    ui.countStrangers.classList.toggle('count-zero', strangersCount === 0);
    ui.countSnakes.classList.toggle('count-zero', snakesCount === 0);
    ui.countWhitelisted.classList.toggle('count-zero', whitelistedCount === 0);
};





const renderResults = () => {
    ui.resultsList.innerHTML = '';

    // Determine source list based on tab
    let sourceList = [];
    if (state.currentTab === 'snakes') {
        sourceList = state.snakes;
    } else if (state.currentTab === 'whitelisted') {
        sourceList = state.whitelisted;
    } else {
        sourceList = state.results;
    }

    const users = getUsersForDisplay(sourceList, state.whitelisted, state.currentTab, state.searchTerm, state.filters);

    if (users.length === 0) {
        ui.resultsList.innerHTML = `<div style="text-align:center; padding: 40px; color: var(--text-secondary);"><p>No users found.</p></div>`;
        return;
    }

    const fragment = document.createDocumentFragment();
    users.forEach(user => {
        const el = document.createElement('div');
        el.className = 'user-item';
        const isSelected = state.selectedUsers.has(user.id);

        // Verified tick next to username
        const verifiedIcon = user.is_verified ? `<svg class="verified-tick" width="14" height="14" viewBox="0 0 24 24" fill="var(--text-accent)"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/><path d="M9 12l2 2 4-4" stroke="#fff" stroke-width="2" fill="none"/></svg>` : '';

        // Private pill tag
        const privateTag = user.is_private ? `<span class="tag-private">Private</span>` : '';

        // Initial letter for fallback avatar
        const initial = (user.username || 'U').charAt(0).toUpperCase();

        el.innerHTML = `
         <div class="avatar-wrapper">
           <img data-src="${user.profile_pic_url}" alt="${user.username}" class="user-avatar">
           <div class="avatar-fallback">${initial}</div>
         </div>
         <div class="user-info">
           <div class="user-name">${user.username}${verifiedIcon}</div>
           <div class="user-meta">
             <span class="user-handle">${user.full_name || ''}</span>
             ${privateTag}
           </div>
         </div>
         ${state.currentTab !== 'snakes' ? `<input type="checkbox" class="user-select-checkbox" ${isSelected ? 'checked' : ''}>` : ''}
       `;

        // Load image through background proxy
        const img = el.querySelector('.user-avatar');
        const fallback = el.querySelector('.avatar-fallback');

        if (user.profile_pic_url) {
            chrome.runtime.sendMessage({
                type: 'FETCH_IMAGE',
                url: user.profile_pic_url
            }, response => {
                if (response && response.success && response.dataUrl) {
                    img.src = response.dataUrl;
                    img.style.display = 'block';
                    fallback.style.display = 'none';
                } else {
                    // Show fallback
                    img.style.display = 'none';
                    fallback.style.display = 'flex';
                }
            });
        } else {
            img.style.display = 'none';
            fallback.style.display = 'flex';
        }

        // Only attach selection toggle if NOT snakes tab
        if (state.currentTab !== 'snakes') {
            el.addEventListener('click', (e) => {
                if (e.target.type !== 'checkbox') {
                    const cb = el.querySelector('.user-select-checkbox');
                    cb.checked = !cb.checked;
                    toggleUserSelection(user.id, cb.checked);
                } else {
                    toggleUserSelection(user.id, e.target.checked);
                }
            });
        }
        fragment.appendChild(el);
    });
    ui.resultsList.appendChild(fragment);
};

const toggleUserSelection = (userId, isSelected) => {
    if (isSelected) state.selectedUsers.add(userId);
    else state.selectedUsers.delete(userId);
    updateSelectionUI();
};

const saveSettings = async (e) => {
    e.preventDefault();
    await chrome.storage.local.set({
        enableAutoScan: ui.toggleAutoScan.checked
        // delays could also be stored/sent to bg
    });
    toggleModal(ui.modalSettings, false);
    showToast('Settings saved', 'success');
};

const showToast = (msg, type = 'info') => {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 3000);
};

// ================================
// NEW Onboarding Tour Controller
// ================================

const tourSteps = [
    // === GREETING PAGE ===
    {
        target: '#btn-scan, #btn-scan-again',
        message: 'Click here to scan your Instagram followers and find who doesn\'t follow you back',
        page: 'start'
    },
    {
        target: '#btn-nav-toggle',
        message: 'View detailed scan results and manage your followers here',
        page: 'start'
    },
    {
        target: '#btn-settings',
        message: 'Configure auto-scan intervals and preferences here',
        page: 'start'
    },
    // === RESULTS PAGE ===
    {
        target: '[data-tab="strangers"]',
        message: 'Unfollowers — People you follow who don\'t follow you back',
        page: 'results'
    },
    {
        target: '[data-tab="snakes"]',
        message: 'Snakes — Users who unfollowed you after you followed them 🐍',
        page: 'results'
    },
    {
        target: '[data-tab="whitelisted"]',
        message: 'Whitelisted — Users you\'ve excluded from unfollower lists. Switch here to manage them.',
        page: 'results'
    },
    {
        target: '.user-select-checkbox',
        message: 'Use checkboxes to select multiple users for bulk actions',
        page: 'results'
    },
    {
        target: '.user-item',
        message: 'Click on a user\'s avatar or name to visit their Instagram profile',
        page: 'results'
    },
    {
        target: '#btn-whitelist-selected',
        message: 'Add selected users to your whitelist — they won\'t appear in unfollower lists',
        page: 'results'
    },
    {
        target: '#btn-unfollow-selected',
        message: 'Unfollow selected users directly from here',
        page: 'results'
    },
    {
        target: '#btn-remove-selected',
        message: 'Remove selected users from your whitelist (when viewing Whitelisted tab)',
        page: 'results'
    }
];

// Find the index where Part 2 (results) starts
const PART_2_START_INDEX = tourSteps.findIndex(step => step.page === 'results');

let currentTourStep = 0;
let tourActive = false;
let tourPart = 1; // Track which part of the tour we're on

const tourUI = {
    overlay: document.getElementById('tour-overlay'),
    tooltip: document.getElementById('tour-tooltip'),
    message: document.getElementById('tour-message'),
    stepIndicator: document.getElementById('tour-step-indicator'),
    nextBtn: document.getElementById('tour-next'),
    skipBtn: document.getElementById('tour-skip')
};

// Part 1: Greeting page tour (runs on first load)
const startTourPart1 = async () => {
    // Safety check
    if (!tourUI.overlay || !tourUI.tooltip) return;

    // Check if tour already completed
    const storage = await chrome.storage.local.get(['tourPart1Complete']);
    if (storage.tourPart1Complete) return;

    tourActive = true;
    tourPart = 1;
    currentTourStep = 0;
    showTourStep(0);
};

// Part 2: Results page tour (runs after scan completion)
const startTourPart2 = async () => {
    // Safety check
    if (!tourUI.overlay || !tourUI.tooltip) return;

    // Check if tour Part 2 already completed
    const storage = await chrome.storage.local.get(['tourPart2Complete']);
    if (storage.tourPart2Complete) return;

    tourActive = true;
    tourPart = 2;
    currentTourStep = PART_2_START_INDEX;
    showTourStep(PART_2_START_INDEX);
};

// Legacy function for compatibility
const startTour = startTourPart1;

const showTourStep = (index) => {
    if (index >= tourSteps.length) {
        completeTour();
        return;
    }

    const step = tourSteps[index];

    // Check page context
    const activeView = document.querySelector('.view.active')?.id;
    const requiredPage = step.page === 'start' ? 'view-start' : 'view-results';

    if (activeView !== requiredPage) {
        if (step.page === 'results' && activeView === 'view-start') {
            handleNavToggle();
            setTimeout(() => showTourStep(index), 400);
            return;
        } else if (step.page === 'start' && activeView === 'view-results') {
            handleNavToggle();
            setTimeout(() => showTourStep(index), 400);
            return;
        }
    }

    // Clear previous blinks
    document.querySelectorAll('.tour-blink').forEach(el => el.classList.remove('tour-blink'));

    // Find target (handle multiple selectors)
    let target = null;
    const selectors = step.target.split(',').map(s => s.trim());
    for (const sel of selectors) {
        target = document.querySelector(sel);
        if (target && target.offsetWidth > 0) break;
    }

    if (!target || target.offsetWidth === 0) {
        // Skip if not found
        currentTourStep++;
        showTourStep(currentTourStep);
        return;
    }

    // Add blink
    target.classList.add('tour-blink');

    // Update tooltip content
    tourUI.message.textContent = step.message;
    tourUI.stepIndicator.textContent = `${index + 1} of ${tourSteps.length}`;

    // Position tooltip
    positionTooltip(target);

    // Show (remove hidden, add active)
    tourUI.overlay.classList.remove('hidden');
    tourUI.overlay.classList.add('active');
    tourUI.tooltip.classList.remove('hidden');
    tourUI.tooltip.classList.add('active');

    currentTourStep = index;
};

const positionTooltip = (target) => {
    const rect = target.getBoundingClientRect();
    const tooltip = tourUI.tooltip;
    const tooltipWidth = 240; // Compact size
    const tooltipHeight = 100; // Compact size
    const padding = 14;
    const margin = 8; // Margin from popup edges

    // Calculate horizontal center
    let left = rect.left + (rect.width / 2) - (tooltipWidth / 2);
    left = Math.max(margin, Math.min(left, window.innerWidth - tooltipWidth - margin));

    // Decide placement: below by default, above if near bottom
    let top;
    let arrowClass = 'arrow-up';

    if (rect.bottom + tooltipHeight + padding > window.innerHeight - margin) {
        // Place above
        top = rect.top - tooltipHeight - padding;
        arrowClass = 'arrow-down';
    } else {
        // Place below
        top = rect.bottom + padding;
    }

    // Clamp vertical position within popup bounds
    top = Math.max(margin, Math.min(top, window.innerHeight - tooltipHeight - margin));

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.classList.remove('arrow-up', 'arrow-down');
    tooltip.classList.add(arrowClass);

    // Calculate arrow position to point exactly at target center
    const targetCenterX = rect.left + (rect.width / 2);
    const arrowLeftPx = targetCenterX - left;
    // Clamp arrow within tooltip bounds (15px from edges)
    const clampedArrowLeft = Math.max(20, Math.min(arrowLeftPx, tooltipWidth - 20));
    tooltip.style.setProperty('--arrow-left', `${clampedArrowLeft}px`);
};

const nextTourStep = async () => {
    const nextIndex = currentTourStep + 1;

    // Part 1 ends when we reach results page steps
    if (tourPart === 1 && nextIndex >= PART_2_START_INDEX) {
        // End Part 1 - Part 2 will start after scan
        completeTour();
        return;
    }

    // Check if switching pages (for Part 2)
    if (nextIndex < tourSteps.length) {
        const currentStep = tourSteps[currentTourStep];
        const nextStep = tourSteps[nextIndex];

        if (currentStep.page === 'start' && nextStep.page === 'results') {
            handleNavToggle();
            setTimeout(() => {
                currentTourStep++;
                showTourStep(currentTourStep);
            }, 500);
            return;
        }
    }

    currentTourStep++;
    if (currentTourStep < tourSteps.length) {
        showTourStep(currentTourStep);
    } else {
        completeTour();
    }
};

const completeTour = async () => {
    tourActive = false;

    document.querySelectorAll('.tour-blink').forEach(el => el.classList.remove('tour-blink'));

    tourUI.overlay.classList.remove('active');
    tourUI.overlay.classList.add('hidden');
    tourUI.tooltip.classList.remove('active');
    tourUI.tooltip.classList.add('hidden');

    // Save part-specific completion
    if (tourPart === 1) {
        await chrome.storage.local.set({ tourPart1Complete: true });
    } else if (tourPart === 2) {
        await chrome.storage.local.set({ tourPart2Complete: true, onboardingComplete: true });
    }
};

// Event listeners
if (tourUI.nextBtn) {
    tourUI.nextBtn.addEventListener('click', nextTourStep);
}

if (tourUI.skipBtn) {
    tourUI.skipBtn.addEventListener('click', completeTour);
}

// Click on highlighted element advances tour
document.addEventListener('click', (e) => {
    if (!tourActive) return;

    const blinkingEl = document.querySelector('.tour-blink');
    if (blinkingEl && (blinkingEl === e.target || blinkingEl.contains(e.target))) {
        setTimeout(() => nextTourStep(), 150);
    }
});
init();
