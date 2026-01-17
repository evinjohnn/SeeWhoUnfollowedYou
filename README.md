<p align="center">
  <img src="icons/icon128.png" alt="See Who Unfollowed You Logo" width="120">
</p>

<h1 align="center">See Who Unfollowed You</h1>

<p align="center">
  <strong>Instagram Follower Tracker & Analytics</strong>
</p>

<p align="center">
  A privacy-first Chrome extension that helps you track unfollowers, detect "snakes", and analyze your account growth with a sleek, dark-mode UI.
</p>

<p align="center">
  <img src="https://img.shields.io/github/license/evinjohnn/SeeWhoUnfollowedYou?style=flat&logo=opensourceinitiative&logoColor=white&color=E1306C" alt="license">
  <img src="https://img.shields.io/github/last-commit/evinjohnn/SeeWhoUnfollowedYou?style=flat&logo=git&logoColor=white&color=E1306C" alt="last-commit">
  <img src="https://img.shields.io/github/languages/top/evinjohnn/SeeWhoUnfollowedYou?style=flat&color=E1306C" alt="repo-top-language">
  <img src="https://img.shields.io/github/languages/count/evinjohnn/SeeWhoUnfollowedYou?style=flat&color=E1306C" alt="repo-language-count">
</p>

---

## 📋 Table of Contents

- [Overview](#overview)
- [Demo](#demo)
- [Features](#features)
- [Availability](#availability)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Usage](#usage)
- [Technical Details](#technical-details)
- [Contributing](#contributing)
- [License](#license)
- [Support](#support)

---

## 🎯 Overview

**See Who Unfollowed You** is a powerful, privacy-first browser extension designed to give you deep insights into your Instagram connections. Unlike other tools that require your password or execute risky cloud actions, this extension runs entirely locally on your device using your active browser session.

It provides a comprehensive dashboard to track who unfollowed you, identify "snakes" (people you follow who don't follow you back), monitor your net growth with the "Clout Tracker", and manage a secure whitelist. All wrapped in a premium, dark-mode aesthetic.

---

## 🎥 Demo

![See Who Unfollowed You Demo](demo.gif)

*Demo showcasing the dashboard, Clout Tracker graph, and scanning process.*

---

## ✨ Features

- **🛡️ Privacy First** — Runs locally. No passwords required. No data sent to external servers.
- **🔍 Adaptive Smart Scanning** — New 4-phase scanning engine (Fast Start → Slow Burn → Following Scan → Done) ensures honest, resilient progress without stalling.
- **🐍 Snake Detection** — Automatically identify users who don't follow you back or recently unfollowed you.
- **📊 Advanced Data Export** — Download comprehensive CSVs containing Followers, Non-Followers, Snakes, and your full Following list.
- **⚙️ Configurable Settings** — Customize scan delays, unfollow safety limits, and toggle auto-scanning via the new Settings menu.
- **📈 Clout Tracker** — Visual sparkline graph showing your true net follower growth (deltas) over time.
- **⚪ Whitelist System** — Protect specific users from being flagged or unfollowed.
- **🌘 Premium UI** — Beautiful dark-mode interface with glassmorphism and smooth animations.

---

## 🌐 Availability

| Browser | Status | Link |
|---------|--------|------|
| Google Chrome | ✅ Available | [Chrome Web Store](#) |
| Microsoft Edge | ✅ Compatible | [Edge Add-ons](#) |
| Opera | ✅ Compatible | [Opera Addons](#) |

*Compatible with all major Chromium-based browsers*

---

## 🛠️ Tech Stack

| Technology | Description |
|------------|-------------|
| **JavaScript (ES Modules)** | Core logic for scanning, data processing, and UI interactions |
| **HTML5 / CSS3** | Structure and styling for the premium glassmorphic dark-mode UI |
| **Manifest V3** | Latest Chrome Extension architecture using Service Workers |
| **Chrome Storage API** | Secure, persistent local storage for history and whitelists |
| **Instagram GraphQL** | Direct integration with Instagram's internal APIs for data fetching |

---

## 📁 Project Structure

```
SeeWhoUnfollowedYou/
├── background.js              # Service worker (scan logic, alarms, state management)
├── content.js                 # Content script for on-page overlays (optional)
├── content.css                # Styles for injected content
├── manifest.json              # Extension configuration and permissions
├── popup.html                 # Main extension dashboard UI
├── popup.js                   # UI logic, graph rendering, and user interaction
├── popup.css                  # Styling for the dashboard
├── utils.js                   # Helper functions (API calls, storage, formatting)
└── icons/                     # Application icons
```

### Key Files

| File | Purpose |
|------|---------|
| `background.js` | The "brain" of the extension. Handles long-running scans, alarms, and state persistence. |
| `popup.js` | The "face" of the extension. Renders the Clout Tracker, handles button clicks, and updates the UI. |
| `utils.js` | Contains shared utilities like `fetchUserProfile` and URL generators for the Instagram API. |
| `manifest.json` | Defines the extension's capabilities, permissions (cookies, storage), and entry points. |

---

## 🚀 Getting Started

### Prerequisites

- Modern Chromium-based browser (Chrome, Edge, Brave, Opera)
- Active Instagram session (logged in on instagram.com)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/evinjohnn/SeeWhoUnfollowedYou
   cd SeeWhoUnfollowedYou
   ```

2. **Open your browser's extension page**
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`

3. **Enable Developer Mode**
   - Toggle the "Developer mode" switch in the top-right corner.

4. **Load the extension**
   - Click "Load unpacked".
   - Select the directory where you cloned the repository.

5. **Done!** The extension is now active. Pin it to your toolbar for easy access.

---

## 💡 Usage

1. **Login to Instagram**
   - Ensure you are logged into `instagram.com` in your browser.

2. **Start a Scan**
   - Open the extension and click **"Scan Followers"**.
   - The extension will fetch your followers and following lists.

3. **Analyze Results**
   - **Unfollowers**: See who isn't following you back.
   - **Snakes**: See people who recently unfollowed you.
   - **Growth**: Check the "Clout Tracker" graph for daily trends.

4. **Manage Connections**
   - Select users to whitelist (keep safe) or unfollow (bulk actions available).

5. **Configure Settings**
   - Click the gear icon to adjust scan delays, toggle daily auto-scans, or export your full data as CSV.

---

## 🔧 Technical Details

| Component | Description |
|-----------|-------------|
| **Manifest V3** | Uses a non-persistent background service worker (`background.js`) to adhere to modern Chrome standards. |
| **Safe Fetching** | Implements intelligent delays and rate-limit handling when querying Instagram's API to prevent blocks. |
| **Data Persistence** | All scan history and whitelists are stored in `chrome.storage.local`. No cloud database is used. |
| **Graph Logic** | The Clout Tracker calculates daily deltas (`Today - Yesterday`) to visualize true net growth. |

---

## 🤝 Contributing

We welcome contributions! Here's how you can help:

- 🐛 **Report Issues** — Submit bugs or feature requests via [GitHub Issues](https://github.com/evinjohnn/SeeWhoUnfollowedYou/issues)
- 💡 **Pull Requests** — Review open PRs or submit your own optimizations.

### Contribution Guidelines

1. **Fork the repository**
2. **Create a feature branch** (`git checkout -b feature/amazing-feature`)
3. **Commit your changes** (`git commit -m 'Add some amazing feature'`)
4. **Push to the branch**
5. **Open a Pull Request**

---

## 📄 License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.

---

## ☕ Support the Project

If you find this tool helpful, consider supporting its development!

<p align="center">
  <a href="https://ko-fi.com/evinjohnn" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="180">
  </a>
</p>

---

<p align="center">
  Made with ❤️ for the community
</p>
