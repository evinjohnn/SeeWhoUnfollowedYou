
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
    scanHistory: [], // [NEW] v1.0
    lastDiff: null,  // [NEW] v1.0
    lastScanTime: 0, // [NEW] v1.0
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
// -- UI Elements --
const views = {
    intro: document.getElementById('view-intro'),
    dashboard: document.getElementById('view-dashboard'),
    scanning: document.getElementById('view-scanning'),
    results: document.getElementById('view-results')
};

const ui = {
    btnScanFirst: document.getElementById('btn-scan-first'),
    btnScanAgain: document.getElementById('btn-scan-again'),
    btnViewDetails: document.getElementById('btn-view-details'),
    btnBack: document.getElementById('btn-back'),

    summaryTitle: document.getElementById('summary-title'),
    summaryDesc: document.getElementById('summary-desc'),
    dashboardLastUpdated: document.getElementById('dashboard-last-updated'),

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
    selectedCount: document.getElementById('selected-count'),
    modalSettings: document.getElementById('modal-settings'),
    btnSaveSettings: document.getElementById('btn-save-settings'),
    inputScanDelay: document.getElementById('setting-scan-delay'),
    inputUnfollowDelay: document.getElementById('setting-unfollow-delay'),
    toggleAutoScan: document.getElementById('setting-autoscan'),
    btnCloseModals: document.querySelectorAll('.btn-close-modal'),
    filterVerified: document.getElementById('filter-verified'),
    filterPrivate: document.getElementById('filter-private'),
    profileCard: document.getElementById('profile-preview-card'),
    btnTimeline: document.getElementById('btn-timeline'),
    btnExport: document.getElementById('btn-export'),
    modalTimeline: document.getElementById('modal-timeline'),
    timelineList: document.getElementById('timeline-list'),
    toggleDarkerMode: document.getElementById('setting-darker-mode')
};

// -- Init --
const init = async () => {
    state.whitelisted = loadWhitelist();
    renderCounts();

    // 1. Load Local State & Settings immediately
    const storage = await chrome.storage.local.get([
        'enableAutoScan',
        'darkerMode',
        'scanHistory',
        'lastDiff',
        'lastScanTime',
        'lastScanResults' // Optional fallback
    ]);

    // Apply Settings
    if (storage.enableAutoScan) {
        ui.toggleAutoScan.checked = true;
    }
    if (storage.darkerMode) {
        document.body.classList.add('darker-mode');
        ui.toggleDarkerMode.checked = true;
    }

    // Hydrate State for immediate UI
    if (storage.scanHistory) state.scanHistory = storage.scanHistory;
    if (storage.lastDiff) state.lastDiff = storage.lastDiff;
    if (storage.lastScanTime) state.lastScanTime = storage.lastScanTime;
    if (storage.lastScanResults) state.results = storage.lastScanResults; // Hydrate results immediately

    // Reset UI State for fresh feel
    state.currentTab = 'strangers';
    state.searchTerm = '';
    state.selectedUsers = new Set();
    if (ui.searchInput) ui.searchInput.value = '';
    updateSelectionUI();

    // Determine Logic View
    if (state.scanHistory.length > 0) {
        renderDashboard();
        switchView('dashboard');
    } else {
        switchView('intro');
    }

    // Listeners
    if (ui.btnScanFirst) ui.btnScanFirst.addEventListener('click', startScan);
    if (ui.btnScanAgain) ui.btnScanAgain.addEventListener('click', startScan);

    if (ui.btnViewDetails) {
        ui.btnViewDetails.addEventListener('click', () => {
            renderCounts();
            renderResults();
            switchView('results');
            // Initialize highlight for active tab
            const activeTab = document.querySelector('.tab-btn.active');
            if (activeTab) moveTabHighlight(activeTab);
        });
    }

    if (ui.btnBack) {
        ui.btnBack.addEventListener('click', () => {
            switchView('dashboard');
        });
    }

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

    // Other Listeners
    ui.btnTimeline.addEventListener('click', renderTimeline);
    ui.btnExport.addEventListener('click', exportData);
    ui.toggleDarkerMode.addEventListener('change', toggleDarkerMode);

    // Listen for updates from Background
    chrome.runtime.onMessage.addListener((request) => {
        if (request.type === 'STATE_UPDATE') {
            updateFromBackground(request.payload);
        }
    });

    // 2. Sync with Background (Async)
    await syncWithBackground();
};

const timeAgo = (date) => {
    const seconds = Math.floor((new Date() - date) / 1000);
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + " years ago";
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + " months ago";
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + " days ago";
    if (interval >= 1) return "yesterday"; // Simplify 1 day
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + " hours ago";
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + " minutes ago";
    return "just now";
};

const renderDashboard = () => {
    // Determine history state
    if (!state.scanHistory || state.scanHistory.length === 0) {
        return;
    }

    // History is unshifted, so [0] is newest
    const lastScan = state.scanHistory[0];
    const diff = state.lastDiff || lastScan.diff;
    const previousScanTime = state.scanHistory[1] ? state.scanHistory[1].date : null;
    const timeLabel = previousScanTime ? timeAgo(new Date(previousScanTime)).replace(' ago', '') : 'last scan';

    let title = "Scan complete";
    let desc = "No changes detected.";

    if (diff) {
        const { gained, lost } = diff;

        if (gained > 0 && lost > 0) {
            title = `+${gained} followers · -${lost} unfollows`;
            desc = `Changes since ${timeLabel}`;
        } else if (lost > 0) {
            title = `${lost} people unfollowed you`;
            desc = `Since ${timeLabel}`;
        } else if (gained > 0) {
            title = `${gained} new followers`;
            desc = `Since ${timeLabel}`;
        } else {
            title = "No follower changes";
            desc = `Since ${timeLabel}`;
        }
    } else {
        // Fallback or First Scan
        title = "First scan completed";
        desc = `Found ${state.results.length} connections.`;
    }

    ui.summaryTitle.textContent = title;
    ui.summaryDesc.textContent = desc;

    // Time
    if (state.lastScanTime) {
        const date = new Date(state.lastScanTime);
        ui.dashboardLastUpdated.textContent = `Last updated: ${timeAgo(date)}`;
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
    // Merge state
    const prevStatus = state.status;
    state.status = bgState.status === 'idle' && state.results.length === 0 ? 'initial' : bgState.status;
    if (bgState.status === 'idle' && bgState.results.length > 0) state.status = 'results';

    state.results = bgState.results || [];
    state.snakes = bgState.snakes || [];
    state.scanHistory = bgState.scanHistory || [];
    state.lastDiff = bgState.lastDiff || null;
    state.lastScanTime = bgState.lastScanTime || 0;
    state.progress = bgState.progress || 0;
    state.scannedCount = bgState.scannedCount || 0;

    // View Switching Logic
    const currentView = Object.keys(views).find(k => views[k].classList.contains('active'));

    // If actively scanning/unfollowing, force view
    if (state.status === 'scanning' || state.status === 'unfollowing') {
        if (currentView !== 'scanning') switchView('scanning');
        ui.scanningText.textContent = state.status === 'scanning' ? "Scanning..." : "Unfollowing...";
        const noun = state.status === 'scanning' ? 'users' : 'processed';
        ui.scanningSubtext.textContent = `${state.scannedCount} ${noun}...`;
        ui.scanProgress.style.width = `${state.progress}%`;
        ui.scanPercentage.textContent = `${state.progress}%`;
        return;
    }

    // If finished scanning (transition from scanning/unfollowing to results)
    if ((prevStatus === 'scanning' || prevStatus === 'unfollowing') && state.status === 'results') {
        renderDashboard();
        switchView('dashboard');
        return;
    }

    // If we are sitting in intro but background says we have history (e.g. from another sync)
    // Switch to dashboard
    if (currentView === 'intro' && state.scanHistory.length > 0) {
        renderDashboard();
        switchView('dashboard');
    }

    // Update dashboard metadata if visible
    if (currentView === 'dashboard') {
        renderDashboard();
    }
};

const startScan = async () => {
    // Cooldown warning
    if (state.lastScanTime) {
        const diffHours = (Date.now() - state.lastScanTime) / (1000 * 60 * 60);
        if (diffHours < 1) {
            if (!confirm("Scanning too frequently can lead to Instagram rate limits. Are you sure?")) return;
        }
    }

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
    ui.tabs.forEach(t => {
        const isActive = t.dataset.tab === tabName;
        t.classList.toggle('active', isActive);
        if (isActive) moveTabHighlight(t);
    });
    state.selectedUsers.clear();
    updateSelectionUI();
    renderResults();
};

const moveTabHighlight = (targetBtn) => {
    const highlight = document.querySelector('.tab-highlight');
    if (!highlight || !targetBtn) return;

    // Calculate position relative to parent
    const parent = targetBtn.parentElement;
    const parentRect = parent.getBoundingClientRect();
    const btnRect = targetBtn.getBoundingClientRect();

    const left = btnRect.left - parentRect.left;
    const width = btnRect.width;

    highlight.style.left = `${left}px`;
    highlight.style.width = `${width}px`;
};

const renderCounts = () => {
    const totalRaw = state.results.length;
    ui.countWhitelisted.textContent = state.whitelisted.length;

    // Strangers: In results, NOT in whitelist
    ui.countStrangers.textContent = totalRaw > 0
        ? state.results.filter(u => !state.whitelisted.some(w => w.id === u.id)).length
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

        let badgesHtml = '';
        if (user.is_verified) badgesHtml += `<span class="icon-verified" title="Verified">✔</span>`;
        if (user.is_private) badgesHtml += `<span class="badge-private" title="Private">Private</span>`;

        // Handle image error (referrer)
        el.innerHTML = `
          <img src="${user.profile_pic_url}" alt="${user.username}" class="user-avatar" loading="lazy" referrerpolicy="no-referrer" onerror="this.src='icons/icon48.png'; this.style.opacity='0.5';">
          <div class="user-info">
            <div class="user-name">
                ${user.username} 
                ${badgesHtml}
            </div>
            <div class="user-handle">${user.full_name || ''}</div>
          </div>
          <input type="checkbox" class="user-select-checkbox" ${isSelected ? 'checked' : ''}>
        `;

        // Hover Preview Logic
        el.querySelector('.user-avatar').addEventListener('mouseenter', (e) => showProfileCard(e, user));
        el.querySelector('.user-avatar').addEventListener('mouseleave', hideProfileCard);
        // ... also name hover if desired

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

// --- New Feature Functions ---

const showProfileCard = (e, user) => {
    const card = ui.profileCard;
    const rect = e.target.getBoundingClientRect();

    // Populate
    document.getElementById('card-avatar').src = user.profile_pic_url;
    document.getElementById('card-username').firstChild.textContent = user.username + ' ';
    document.getElementById('card-fullname').textContent = user.full_name || '';

    // Badge
    const badge = document.getElementById('card-verified');
    if (badge) {
        if (user.is_verified) badge.style.display = 'inline-block';
        else badge.style.display = 'none';
    }

    // Check for stats
    const followerEl = document.getElementById('card-followers');
    const followingEl = document.getElementById('card-following');
    const statsContainer = card.querySelector('.card-stats'); // Corrected class name from popup.html

    // Instagram list nodes usually DON'T have this data, so check carefully
    if (user.edge_followed_by && user.edge_follow) {
        followerEl.textContent = user.edge_followed_by.count || 0;
        followingEl.textContent = user.edge_follow.count || 0;
        if (statsContainer) statsContainer.style.display = 'flex';
    } else {
        // Data missing -> hide the stats row 
        if (statsContainer) statsContainer.style.display = 'none';
    }

    // Position (Floating next to cursor/element)
    let top = rect.top + 20;
    let left = rect.left + 50;

    // Simple bounds check
    if (left + 240 > window.innerWidth) left = rect.left - 250;
    if (top + 150 > window.innerHeight) top = rect.top - 150;

    card.style.top = `${top}px`;
    card.style.left = `${left}px`;

    // Animation
    card.style.display = 'block';
    requestAnimationFrame(() => {
        card.classList.add('visible');
    });
};

const hideProfileCard = () => {
    ui.profileCard.classList.remove('visible');
    setTimeout(() => {
        if (!ui.profileCard.classList.contains('visible')) {
            ui.profileCard.style.display = 'none';
        }
    }, 200);
};

const renderTimeline = () => {
    ui.timelineList.innerHTML = '';
    const history = state.scanHistory || [];

    if (history.length === 0) {
        ui.timelineList.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-secondary)">No scan history yet.</div>';
    } else {
        history.forEach(entry => {
            const item = document.createElement('div');
            item.className = 'timeline-item';

            const dateStr = new Date(entry.date).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

            // Build summary string from diff
            let summary = "Scan completed";
            if (entry.diff) {
                const { gained, lost } = entry.diff;
                if (gained === 0 && lost === 0) summary = "No changes";
                else {
                    let parts = [];
                    if (gained > 0) parts.push(`+${gained} New`);
                    if (lost > 0) parts.push(`-${lost} Lost`);
                    summary = parts.join(", ");
                }
            }

            item.innerHTML = `
                <div class="timeline-date">${dateStr}</div>
                <div class="timeline-summary">${summary}</div>
            `;
            ui.timelineList.appendChild(item);
        });
    }
    toggleModal(ui.modalTimeline, true);
    // Close on click outside or close button, reused toggleModal logic
    // We need to attach close listener for this specific modal
    // (Already handled by generic btn-close-modal in init?)
    // Yes: ui.btnCloseModals selector covers all buttons with that class.
};

const exportData = () => {
    // CSV Generation
    const headers = "Username,Full Name,Profile URL,Status,Detected At\n";

    // 1. Unfollowers
    const strangersRows = state.results
        .filter(u => !state.whitelisted.some(w => w.id === u.id))
        .map(u => `${u.username},"${u.full_name || ''}",https://instagram.com/${u.username},Unfollower,${new Date().toISOString()}`)
        .join("\n");

    // 2. Snakes
    const snakeRows = state.snakes
        .map(u => `${u.username},"${u.full_name || ''}",https://instagram.com/${u.username},Snake/Lost,${new Date(u.detected_at || Date.now()).toISOString()}`)
        .join("\n");

    const csvContent = headers + strangersRows + "\n" + snakeRows;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `followers_export_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

const toggleDarkerMode = async (e) => {
    const isDarker = e.target.checked;
    document.body.classList.toggle('darker-mode', isDarker);
    await chrome.storage.local.set({ darkerMode: isDarker });
};

init();
