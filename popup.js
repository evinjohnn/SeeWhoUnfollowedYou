
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
const generateSummaryText = (currentResults, snakes, lastScanTime) => {
    const snakesCount = snakes?.length || 0;
    const followingCount = currentResults?.length || 0;
    const timeAgo = formatRelativeTime(lastScanTime);

    // Build summary parts
    const parts = [];

    if (snakesCount > 0) {
        parts.push(`${snakesCount} ${snakesCount === 1 ? 'person' : 'people'} unfollowed you`);
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

    // 1. Count Unfollows (Snakes) per bucket
    snakes.forEach(snake => {
        if (!snake.detected_at) return;
        const diff = now - snake.detected_at;

        if (diff < ONE_DAY) {
            groups.today.unfollows++;
        } else if (diff < 2 * ONE_DAY) {
            groups.yesterday.unfollows++;
        } else if (diff < 7 * ONE_DAY) {
            groups.thisWeek.unfollows++;
        }
    });

    // 2. Net Change (using history snapshots)
    // We need to associate history entries with buckets to find stats
    // Ideally we want: (Last scan in bucket) - (First scan in bucket/Last scan before bucket)

    // Sort history newest first
    const sortedHistory = [...history].sort((a, b) => b.timestamp - a.timestamp);

    // Assign counts to buckets
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
    const buckets = [groups.today, groups.yesterday, groups.thisWeek];

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
    } else {
        ui.timelineContainer.classList.add('hidden');
    }
};

// -- Check if Returning User --
// Decides which state to show BEFORE rendering to avoid flash
const checkReturningUser = async () => {
    const storage = await chrome.storage.local.get(['lastScanResults', 'lastScanTime', 'snakes']);
    const hasPreviousScan = storage.lastScanResults && storage.lastScanResults.length > 0;

    if (hasPreviousScan) {
        // Show returning user view with summary
        ui.firstRunState.classList.add('hidden');
        ui.returningUserState.classList.remove('hidden');

        // Generate and display summary sentence
        const summaryText = generateSummaryText(
            storage.lastScanResults,
            storage.snakes,
            storage.lastScanTime
        );
        ui.summarySentence.textContent = summaryText;

        // Update cooldown indicator
        updateCooldownIndicator(storage.lastScanTime);

        // Render Timeline
        renderTimeline();
    } else {
        // First run - show simple scan button only
        ui.firstRunState.classList.remove('hidden');
        ui.returningUserState.classList.add('hidden');
    }
};

// -- Init --
const init = async () => {
    state.whitelisted = loadWhitelist();
    renderCounts();

    // Check if returning user and show appropriate view (before any other rendering)
    await checkReturningUser();

    // Listeners
    ui.btnScan.addEventListener('click', startScan);
    if (ui.btnScanAgain) ui.btnScanAgain.addEventListener('click', startScan);
    ui.btnNavToggle.addEventListener('click', handleNavToggle);
    ui.btnSettings.addEventListener('click', () => toggleModal(ui.modalSettings, true));
    ui.btnCloseModals.forEach(btn => btn.addEventListener('click', () => toggleModal(ui.modalSettings, false)));
    ui.btnSaveSettings.addEventListener('click', saveSettings);

    ui.tabs.forEach(tab => {
        tab.addEventListener('click', (e) => switchTab(e.currentTarget.dataset.tab));
    });

    ui.searchInput.addEventListener('input', (e) => {
        state.searchTerm = e.target.value;
        renderResults();
    });

    ui.filterVerified.addEventListener('change', (e) => {
        state.filters.showVerified = e.target.checked;
        renderResults();
    });
    ui.filterPrivate.addEventListener('change', (e) => {
        state.filters.showPrivate = e.target.checked;
        renderResults();
    });

    ui.btnUnfollowSelected.addEventListener('click', startUnfollowProcess);

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
        const noun = bgState.status === 'scanning' ? 'users' : 'processed';
        ui.scanningSubtext.textContent = `${state.scannedCount} ${noun}...`;
        ui.scanProgress.style.width = `${state.progress}%`;
        ui.scanPercentage.textContent = `${state.progress}%`;
    } else if (bgState.status === 'idle') {
        // Idle: stay on start view (checkReturningUser already set up the correct state)
        // Only switch to start if we're currently on scanning (scan just completed)
        const wasScanningBefore = state.status === 'scanning';
        state.status = state.results.length > 0 ? 'results' : 'initial';

        // If scan just completed, refresh the returning user view
        if (document.getElementById('view-scanning').classList.contains('active')) {
            checkReturningUser();
            switchView('start');

            // Show completion banner if scan just finished
            if (wasScanningBefore) {
                showCompletionBanner();
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
    if (!confirm(`Unfollow ${state.selectedUsers.size} users?`)) return;

    const users = Array.from(state.selectedUsers);
    await chrome.runtime.sendMessage({ type: 'START_UNFOLLOW', users });
};

// -- UI Logic --
const switchView = (viewName) => {
    Object.values(views).forEach(el => el.classList.remove('active'));
    views[viewName].classList.add('active');
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

    // Show/Hide Unfollow Button (Only for Strangers)
    // We target the footer container to hide the whole section
    const footer = ui.btnUnfollowSelected.parentElement;
    if (tabName === 'strangers') {
        footer.classList.remove('hidden');
    } else {
        footer.classList.add('hidden');
    }

    state.selectedUsers.clear();
    updateSelectionUI();
    renderResults();
};

const renderCounts = () => {
    const totalRaw = state.results.length;
    ui.countWhitelisted.textContent = state.whitelisted.length;

    // Strangers: In results, NOT in whitelist AND NOT mutual (follows_viewer)
    ui.countStrangers.textContent = totalRaw > 0
        ? state.results.filter(u => !state.whitelisted.some(w => w.id === u.id) && !u.follows_viewer).length
        : 0;

    // Snakes: From history list
    ui.countSnakes.textContent = state.snakes.length;
};





const renderResults = () => {
    ui.resultsList.innerHTML = '';

    // Determine source list based on tab
    let sourceList = [];
    if (state.currentTab === 'snakes') {
        sourceList = state.snakes;
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
         <input type="checkbox" class="user-select-checkbox" ${isSelected ? 'checked' : ''}>
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



        el.addEventListener('click', (e) => {
            if (e.target.type !== 'checkbox') {
                const cb = el.querySelector('.user-select-checkbox');
                cb.checked = !cb.checked;
                toggleUserSelection(user.id, cb.checked);
            } else {
                toggleUserSelection(user.id, e.target.checked);
            }
        });
        fragment.appendChild(el);
    });
    ui.resultsList.appendChild(fragment);
};

const toggleUserSelection = (userId, isSelected) => {
    if (isSelected) state.selectedUsers.add(userId);
    else state.selectedUsers.delete(userId);
    updateSelectionUI();
};

const updateSelectionUI = () => {
    const count = state.selectedUsers.size;
    ui.selectedCount.textContent = count;
    ui.btnUnfollowSelected.disabled = count === 0;
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

init();
