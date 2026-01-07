export const INSTAGRAM_HOSTNAME = "www.instagram.com";
export const WHITELISTED_RESULTS_STORAGE_KEY = "iu_whitelisted-results";
export const WITHOUT_PROFILE_PICTURE_URL_IDS = [
    "44884218_345707102882519_2446069589734326272_n",
    "464760996_1254146839119862_3605321457742435801_n"
];

// Helper to delay execution
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Get cookie by name (Async for Chrome Extension)
export const getCookie = async (name) => {
    if (typeof chrome !== 'undefined' && chrome.cookies) {
        return new Promise((resolve) => {
            chrome.cookies.get({ url: "https://www.instagram.com", name: name }, (cookie) => {
                resolve(cookie ? cookie.value : null);
            });
        });
    }
    // Fallback for dev/mock
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
};

// URL Generators
export const urlGenerator = async (cursor) => {
    const userId = await getCookie("ds_user_id");
    if (!userId) {
        console.error("Could not find ds_user_id cookie");
        return null;
    }
    const queryHash = "3dec7e2c57367ef3da3d987d89f9dbc8";
    const variables = {
        id: userId,
        include_reel: true,
        fetch_mutual: false,
        first: 24
    };
    if (cursor) {
        variables.after = cursor;
    }
    return `https://www.instagram.com/graphql/query/?query_hash=${queryHash}&variables=${encodeURIComponent(JSON.stringify(variables))}`;
};

export const unfollowUserUrlGenerator = (id) => {
    return `https://www.instagram.com/web/friendships/${id}/unfollow/`;
};

// Filtering Logic
export const getUsersForDisplay = (results, whitelistedResults, currentTab, searchTerm, filter) => {
    const filtered = [];
    const term = searchTerm.toLowerCase();

    for (const user of results) {
        const isWhitelisted = whitelistedResults.some(u => u.id === user.id);

        // Tab filtering
        if (currentTab === "snakes" && isWhitelisted) continue;
        if (currentTab === "whitelisted" && !isWhitelisted) continue;

        // Attribute filtering
        if (!filter.showPrivate && user.is_private) continue;
        if (!filter.showVerified && user.is_verified) continue;
        // Note: 'follows_viewer' means they follow you. 
        // We typically want to see who DOES NOT follow us (strangers).
        // If showFollowers is false, we verify they assume 'not following me'
        // If showNonFollowers is true, we want people who don't follow back.
        // In the original code: 
        // if (!filter.showFollowers && user.follows_viewer) continue; -> Skip followers
        // if (!filter.showNonFollowers && !user.follows_viewer) continue; -> Skip non-followers

        if (!filter.showFollowers && user.follows_viewer) continue;
        if (!filter.showNonFollowers && !user.follows_viewer) continue;

        if (!filter.showWithOutProfilePicture && WITHOUT_PROFILE_PICTURE_URL_IDS.some(id => user.profile_pic_url.includes(id))) continue;

        // Search term
        const matchesSearch = user.username.toLowerCase().includes(term) || user.full_name.toLowerCase().includes(term);
        if (searchTerm !== "" && !matchesSearch) continue;

        filtered.push(user);
    }
    return filtered.sort((a, b) => a.username.localeCompare(b.username));
};

// Whitelist Management
export const loadWhitelist = () => {
    const data = localStorage.getItem(WHITELISTED_RESULTS_STORAGE_KEY);
    return data ? JSON.parse(data) : [];
};

export const saveWhitelist = (whitelist) => {
    localStorage.setItem(WHITELISTED_RESULTS_STORAGE_KEY, JSON.stringify(whitelist));
};

export const addToWhitelist = (user) => {
    const list = loadWhitelist();
    if (!list.some(u => u.id === user.id)) {
        list.push(user);
        saveWhitelist(list);
    }
    return list;
};

export const removeFromWhitelist = (userId) => {
    const list = loadWhitelist();
    const newList = list.filter(u => u.id !== userId);
    saveWhitelist(newList);
    return newList;
};
