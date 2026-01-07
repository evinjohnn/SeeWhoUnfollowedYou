
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
    selectedCount: document.getElementById('selected-count'),
    modalSettings: document.getElementById('modal-settings'),
    btnSaveSettings: document.getElementById('btn-save-settings'),
    inputScanDelay: document.getElementById('setting-scan-delay'),
    inputUnfollowDelay: document.getElementById('setting-unfollow-delay'),
    toggleAutoScan: document.getElementById('setting-autoscan'),
    btnCloseModals: document.querySelectorAll('.btn-close-modal'),
    filterVerified: document.getElementById('filter-verified'),
    filterPrivate: document.getElementById('filter-private')
};

// -- Init --
const init = async () => {
    state.whitelisted = loadWhitelist();
    renderCounts();

    // Listeners
    ui.btnScan.addEventListener('click', startScan);
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
    state.status = bgState.status === 'idle' && state.results.length === 0 ? 'initial' : bgState.status;
    if (bgState.status === 'idle' && bgState.results.length > 0) state.status = 'results';

    state.results = bgState.results || [];
    state.snakes = bgState.snakes || []; // [NEW]
    state.progress = bgState.progress || 0;
    state.scannedCount = bgState.scannedCount || 0;

    // View Switching
    if (state.status === 'initial') switchView('start');
    else if (state.status === 'scanning' || state.status === 'unfollowing') {
        switchView('scanning');
        ui.scanningText.textContent = state.status === 'scanning' ? "Scanning..." : "Unfollowing...";
        const noun = state.status === 'scanning' ? 'users' : 'processed';
        ui.scanningSubtext.textContent = `${state.scannedCount} ${noun}...`; // approximation
        ui.scanProgress.style.width = `${state.progress}%`;
        ui.scanPercentage.textContent = `${state.progress}%`;
    }
    else if (state.status === 'results') {
        switchView('results');
        renderCounts();
        renderResults();
    }
    else if (state.status === 'error') {
        // Handle error view
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
    ui.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    state.selectedUsers.clear();
    updateSelectionUI();
    renderResults();
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
        if (user.is_verified) badgesHtml += `<span class="icon-verified">✔</span>`;
        if (user.is_private) badgesHtml += `<span class="icon-private">🔒</span>`;

        // Handle image error (referrer)
        el.innerHTML = `
         <img src="${user.profile_pic_url}" alt="${user.username}" class="user-avatar" loading="lazy" referrerpolicy="no-referrer" onerror="this.src='icons/icon48.png'; this.style.opacity='0.5';">
         <div class="user-info">
           <div class="user-name">${user.username} ${badgesHtml}</div>
           <div class="user-handle">${user.full_name || ''}</div>
         </div>
         <input type="checkbox" class="user-select-checkbox" ${isSelected ? 'checked' : ''}>
       `;

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
