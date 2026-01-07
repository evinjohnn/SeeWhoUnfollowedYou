
// -- Content Script for Overlay --

// Create & Inject Overlay
const ensureOverlay = () => {
    if (document.getElementById('iu-overlay')) return document.getElementById('iu-overlay');

    const div = document.createElement('div');
    div.id = 'iu-overlay';
    div.innerHTML = `
      <div class="iu-pill">
        <div class="iu-spinner"></div>
        <div class="iu-text">
            <span class="iu-title">Scanning...</span>
            <span class="iu-desc">0%</span>
        </div>
        <div class="iu-close" title="Hide Overlay">×</div>
      </div>
    `;

    // Close Handler
    div.querySelector('.iu-close').addEventListener('click', () => {
        div.style.display = 'none';
    });

    document.body.appendChild(div);
    return div;
};

const updateOverlay = (status, progress, count) => {
    const overlay = ensureOverlay();

    // Hide if idle for a long time or specifically hidden? 
    // Usually we show it if active.

    if (status === 'idle' && progress === 100) {
        // Complete state
        overlay.style.display = 'block';
        overlay.querySelector('.iu-spinner').style.display = 'none';
        overlay.querySelector('.iu-title').textContent = "Scan Complete";
        overlay.querySelector('.iu-desc').textContent = `Found ${count} users`;

        // Auto-hide after 5s
        setTimeout(() => {
            overlay.classList.add('fade-out');
            setTimeout(() => {
                overlay.style.display = 'none';
                overlay.classList.remove('fade-out');
            }, 500);
        }, 5000);

    } else if (status === 'scanning' || status === 'unfollowing') {
        overlay.style.display = 'block';
        overlay.querySelector('.iu-spinner').style.display = 'block';
        overlay.querySelector('.iu-title').textContent = status === 'scanning' ? "Scanning..." : "Unfollowing...";
        overlay.querySelector('.iu-desc').textContent = `${progress}%`;
    } else {
        // Error or Idle start
        if (status === 'idle') overlay.style.display = 'none';
    }
};

// Listen for messages from Background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'UPDATE_OVERLAY') {
        const { status, progress, count } = request.payload;
        updateOverlay(status, progress, count);
    }
});
