const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const needle = require('needle');
const crypto = require('crypto');
const sha1 = require('sha1');
const xml2js = require('xml2js');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

// Debounce cache pro logSearch - zamezí logování prefetch requestů od Stremio
// Klíč: "username:imdbId", hodnota: timestamp prvního requestu
const searchLogDebounce = new Map();
const SEARCH_LOG_DEBOUNCE_MS = 10000; // 10 sekund

// Vlastní implementace MD5-crypt (kompatibilní s PHP/Apache)
function md5crypt(password, salt) {
    // Odstranit $1$ prefix pokud existuje
    salt = salt.replace(/^\$1\$/, '').split('$')[0];
    
    // MD5-crypt algoritmus
    const magic = '$1$';
    
    // Alternate sum
    let ctx1 = crypto.createHash('md5');
    ctx1.update(password);
    ctx1.update(salt);
    ctx1.update(password);
    let final = ctx1.digest();
    
    // Primary sum
    let ctx = crypto.createHash('md5');
    ctx.update(password);
    ctx.update(magic);
    ctx.update(salt);
    
    // Add alternate sum
    for (let pl = password.length; pl > 0; pl -= 16) {
        ctx.update(final.slice(0, pl > 16 ? 16 : pl));
    }
    
    // Add password bits
    for (let i = password.length; i > 0; i >>= 1) {
        if (i & 1) {
            ctx.update(Buffer.from([0]));
        } else {
            ctx.update(password[0]);
        }
    }
    
    final = ctx.digest();
    
    // Iterate 1000 times
    for (let i = 0; i < 1000; i++) {
        let ctx1 = crypto.createHash('md5');
        if (i & 1) {
            ctx1.update(password);
        } else {
            ctx1.update(final);
        }
        if (i % 3) {
            ctx1.update(salt);
        }
        if (i % 7) {
            ctx1.update(password);
        }
        if (i & 1) {
            ctx1.update(final);
        } else {
            ctx1.update(password);
        }
        final = ctx1.digest();
    }
    
    // Convert to base64-like encoding
    const itoa64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let result = magic + salt + '$';
    
    const encode = (b0, b1, b2, n) => {
        let w = (b0 << 16) | (b1 << 8) | b2;
        let output = '';
        for (let i = 0; i < n; i++) {
            output += itoa64[w & 0x3f];
            w >>= 6;
        }
        return output;
    };
    
    result += encode(final[0], final[6], final[12], 4);
    result += encode(final[1], final[7], final[13], 4);
    result += encode(final[2], final[8], final[14], 4);
    result += encode(final[3], final[9], final[15], 4);
    result += encode(final[4], final[10], final[5], 4);
    result += encode(0, 0, final[11], 2);
    
    return result;
}

// R2 Cloud Storage setup
const r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || ''
    }
});

const R2_BUCKET = process.env.R2_BUCKET_NAME || 'titulky-cache';
const R2_PREFIX = 'webshare-addon/';

// Super admin - nemůže být odebrán
const SUPER_ADMIN = 'Procha';

// Získat seznam adminů z R2
async function getAdmins() {
    const admins = await getFromR2('admins.json') || [SUPER_ADMIN];
    // Vždy zahrnout super admina
    if (!admins.includes(SUPER_ADMIN)) {
        admins.push(SUPER_ADMIN);
    }
    return admins;
}

async function isAdmin(username) {
    const admins = await getAdmins();
    return admins.includes(username);
}

async function addAdmin(username, addedBy) {
    if (!await isAdmin(addedBy)) {
        return { success: false, error: 'Only admins can add admins' };
    }
    
    const admins = await getAdmins();
    if (admins.includes(username)) {
        return { success: false, error: 'Already an admin' };
    }
    
    admins.push(username);
    await putToR2('admins.json', admins);
    console.log(`✅ Admin added: ${username} by ${addedBy}`);
    return { success: true };
}

async function removeAdmin(username, removedBy) {
    if (!await isAdmin(removedBy)) {
        return { success: false, error: 'Only admins can remove admins' };
    }
    
    if (username === SUPER_ADMIN) {
        return { success: false, error: 'Cannot remove super admin' };
    }
    
    const admins = await getAdmins();
    const index = admins.indexOf(username);
    if (index === -1) {
        return { success: false, error: 'Not an admin' };
    }
    
    admins.splice(index, 1);
    await putToR2('admins.json', admins);
    console.log(`✅ Admin removed: ${username} by ${removedBy}`);
    return { success: true };
}

// === BAN SYSTEM ===
async function getBannedUsers() {
    return await getFromR2('banned-users.json') || [];
}

async function isBanned(username) {
    const banned = await getBannedUsers();
    return banned.some(b => b.username === username);
}

async function banUser(username, bannedBy, reason) {
    if (!await isAdmin(bannedBy)) {
        return { success: false, error: 'Pouze admin může banovat' };
    }
    if (await isAdmin(username)) {
        return { success: false, error: 'Nelze banovat admina' };
    }
    
    const banned = await getBannedUsers();
    if (banned.some(b => b.username === username)) {
        return { success: false, error: 'Uživatel je již zabanován' };
    }
    
    banned.push({
        username: username,
        banned_by: bannedBy,
        banned_at: new Date().toISOString(),
        reason: reason || ''
    });
    await putToR2('banned-users.json', banned);
    console.log(`🚫 User banned: ${username} by ${bannedBy} (${reason || 'no reason'})`);
    return { success: true };
}

async function unbanUser(username, unbannedBy) {
    if (!await isAdmin(unbannedBy)) {
        return { success: false, error: 'Pouze admin může odbanovat' };
    }
    
    const banned = await getBannedUsers();
    const index = banned.findIndex(b => b.username === username);
    if (index === -1) {
        return { success: false, error: 'Uživatel není zabanován' };
    }
    
    banned.splice(index, 1);
    await putToR2('banned-users.json', banned);
    console.log(`✅ User unbanned: ${username} by ${unbannedBy}`);
    return { success: true };
}

// R2 Helper Functions
async function getFromR2(key) {
    try {
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET,
            Key: R2_PREFIX + key
        });
        const response = await r2Client.send(command);
        const body = await response.Body.transformToString();
        return JSON.parse(body);
    } catch (error) {
        if (error.name === 'NoSuchKey') {
            return null;
        }
        console.error('R2 GET error:', error.message);
        return null;
    }
}

async function putToR2(key, data) {
    try {
        const command = new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: R2_PREFIX + key,
            Body: JSON.stringify(data, null, 2),
            ContentType: 'application/json'
        });
        await r2Client.send(command);
        return true;
    } catch (error) {
        console.error('R2 PUT error:', error.message);
        return false;
    }
}

async function logSearch(username, query, resultsCount, imdbId, type, displayName, fallbackPoster) {
    try {
        const userKey = `user-searches/${username}.json`;
        let userSearches = await getFromR2(userKey) || {};
        
        // Získat poster z Cinemeta pokud máme IMDB ID
        let poster = null;
        if (imdbId && type) {
            try {
                const metaResp = await needle('get', `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 3000 });
                poster = metaResp.body?.meta?.poster || null;
            } catch (err) {
                console.log('Failed to fetch poster:', err.message);
            }
        }
        // Fallback poster (Kitsu)
        if (!poster && fallbackPoster) {
            poster = fallbackPoster;
        }
        
        if (!userSearches[query]) {
            userSearches[query] = {
                count: 0,
                first_search: new Date().toISOString(),
                last_search: new Date().toISOString(),
                results_count: resultsCount,
                poster: poster
            };
        }
        
        userSearches[query].count += 1;
        userSearches[query].last_search = new Date().toISOString();
        userSearches[query].results_count = resultsCount;
        if (poster && !userSearches[query].poster) {
            userSearches[query].poster = poster;
        }
        // Uložit display name (originální název s diakritikou/romaji)
        if (displayName && !userSearches[query].display_name) {
            userSearches[query].display_name = displayName;
            console.log(`  📝 Display name set: "${displayName}"`);
        }
        
        await putToR2(userKey, userSearches);
        console.log(`✅ Logged search for ${username}: "${query}" (${resultsCount} results)`);
    } catch (error) {
        console.error('Failed to log search:', error.message);
    }
}

async function getManualLinks() {
    return await getFromR2('manual-links.json') || {};
}

async function addManualLink(query, webshareIdent, addedBy, displayName, poster) {
    try {
        const manualLinks = await getManualLinks();
        
        // Inicializovat pole pokud neexistuje
        if (!manualLinks[query]) {
            manualLinks[query] = [];
        }
        
        // Přidat nový link do pole
        manualLinks[query].push({
            webshare_ident: webshareIdent,
            added_by: addedBy,
            added_at: new Date().toISOString(),
            display_name: displayName || query,
            poster: poster || null,
            status: 'ok', // 'ok' nebo 'broken'
            last_checked: new Date().toISOString(),
            fail_count: 0
        });
        
        await putToR2('manual-links.json', manualLinks);
        console.log(`✅ Manual link added: "${query}" → ${webshareIdent} (${manualLinks[query].length} total)`);
        return true;
    } catch (error) {
        console.error('Failed to add manual link:', error.message);
        return false;
    }
}

async function markLinkAsBroken(query, linkIndex) {
    try {
        const manualLinks = await getManualLinks();
        
        if (!manualLinks[query] || !Array.isArray(manualLinks[query])) {
            return false;
        }
        
        if (linkIndex >= manualLinks[query].length) {
            return false;
        }
        
        const link = manualLinks[query][linkIndex];
        link.status = 'broken';
        link.last_checked = new Date().toISOString();
        link.fail_count = (link.fail_count || 0) + 1;
        
        await putToR2('manual-links.json', manualLinks);
        console.log(`⚠️ Manual link marked as broken: "${query}" [${linkIndex}] - ${link.display_name}`);
        return true;
    } catch (error) {
        console.error('Failed to mark link as broken:', error.message);
        return false;
    }
}

async function deleteManualLink(query, linkIndex, requestingUser) {
    try {
        const manualLinks = await getManualLinks();
        
        if (!manualLinks[query] || !Array.isArray(manualLinks[query])) {
            return { success: false, error: 'Link neexistuje' };
        }
        
        if (linkIndex >= manualLinks[query].length) {
            return { success: false, error: 'Link neexistuje' };
        }
        
        const link = manualLinks[query][linkIndex];
        
        // Check permissions
        if (!await isAdmin(requestingUser) && link.added_by !== requestingUser) {
            return { success: false, error: 'Nemáte oprávnění smazat tento link' };
        }
        
        // Odstranit z pole
        manualLinks[query].splice(linkIndex, 1);
        
        // Pokud je pole prázdné, smazat celý klíč
        if (manualLinks[query].length === 0) {
            delete manualLinks[query];
        }
        
        await putToR2('manual-links.json', manualLinks);
        console.log(`✅ Manual link deleted: "${query}" [${linkIndex}] by ${requestingUser}`);
        return { success: true };
    } catch (error) {
        console.error('Failed to delete manual link:', error.message);
        return { success: false, error: 'Server error' };
    }
}

async function createBackup() {
    try {
        const manualLinks = await getManualLinks();
        
        // Získat všechny user searches
        const userSearches = {};
        // Note: V produkci bychom museli listovat všechny user-searches/* soubory
        // Pro jednoduchost vrátíme jen manual-links
        
        const backup = {
            timestamp: new Date().toISOString(),
            version: '7.8.0',
            manual_links: manualLinks,
            // user_searches: userSearches // TODO: implementovat listing všech uživatelů
        };
        
        return backup;
    } catch (error) {
        console.error('Failed to create backup:', error.message);
        return null;
    }
}

async function restoreBackup(backupData, restoredBy) {
    try {
        if (!backupData.manual_links) {
            return { success: false, error: 'Invalid backup format' };
        }
        
        // Restore manual links
        await putToR2('manual-links.json', backupData.manual_links);
        
        console.log(`✅ Backup restored by ${restoredBy}`);
        return { success: true, restored: Object.keys(backupData.manual_links).length };
    } catch (error) {
        console.error('Failed to restore backup:', error.message);
        return { success: false, error: 'Server error' };
    }
}

const manifest = {
    id: 'com.webshare.anime',
    version: '7.19.0', // CRITICAL: Remove ALL remaining template literals from client JS
    name: 'Webshare Anime',
    description: 'Anime a filmy z Webshare.cz s vyhledáváním',
    logo: `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:7000'}/logo.png`,
    resources: ['stream', 'catalog', 'meta'],
    types: ['series', 'movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'webshare_search',
            name: 'Webshare Hledat',
            extra: [{ name: 'search', isRequired: true }]
        }
    ],
    idPrefixes: ['tt', 'kitsu', 'webshare'],
    behaviorHints: {
        configurable: true,
        configurationRequired: false,
        adult: false,
        p2p: false
    },
    config: [
        {
            key: 'username',
            type: 'text',
            title: 'Webshare username',
            required: true
        },
        {
            key: 'password',
            type: 'password',
            title: 'Webshare password',
            required: true
        },
        {
            key: 'tmdb_api_key',
            type: 'text',
            title: 'TMDB API Key (optional - for Czech names)',
            required: false,
            default: ''
        },
        {
            key: 'enable_direct_search',
            type: 'checkbox',
            title: 'Enable Direct Search (Webshare Hledat catalog)',
            default: true
        },
        {
            key: 'enable_my_links',
            type: 'checkbox',
            title: 'Enable My Links (manual link management)',
            default: true
        }
    ]
};

const builder = new addonBuilder(manifest);

// Helper funkce pro formátování velikosti
function formatBytes(bytes) {
    if (!bytes || bytes === '0') return '';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

// Nastavení Express pro servírování statických souborů (logo)
const express = require('express');
const path = require('path');

const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': 'text/xml; charset=UTF-8'
};

async function saltPassword(username, password) {
    const params = `username_or_email=${encodeURIComponent(username)}`;
    const resp = await needle('post', 'https://webshare.cz/api/salt/', params, { headers });
    const salt = resp.body.children.find(el => el.name == 'salt').value;
    return sha1(md5crypt(password, salt));
}

async function login(username, saltedPassword) {
    console.log(`Logging in user ${username}`);
    const params = `username_or_email=${encodeURIComponent(username)}&password=${encodeURIComponent(saltedPassword)}&keep_logged_in=1`;
    const resp = await needle('post', 'https://webshare.cz/api/login/', params, { headers });
    
    if (resp.statusCode != 200 || resp.body.children.find(el => el.name == 'status').value != 'OK') {
        throw new Error('Cannot log in to Webshare.cz');
    }
    
    return resp.body.children.find(el => el.name == 'token').value;
}

async function search(query, token) {
    console.log('Searching:', query);
    const params = `what=${encodeURIComponent(query)}&category=video&limit=50&wst=${encodeURIComponent(token)}`;
    
    try {
        const resp = await needle('post', 'https://webshare.cz/api/search/', params, { headers });
        
        console.log('Search API response status:', resp.statusCode);
        console.log('Search API body type:', typeof resp.body);
        
        if (!resp.body || !resp.body.children) {
            console.log('ERROR: Invalid API response structure');
            return [];
        }
        
        const files = resp.body.children.filter(el => el.name == 'file');
        console.log('Files found:', files.length);
        
        return files.map(el => {
            const ident = el.children.find(c => c.name == 'ident')?.value;
            const name = el.children.find(c => c.name == 'name')?.value;
            const size = el.children.find(c => c.name == 'size')?.value;
            const type = el.children.find(c => c.name == 'type')?.value;
            const img = el.children.find(c => c.name == 'img')?.value;
            const positive_votes = el.children.find(c => c.name == 'positive_votes')?.value || '0';
            const negative_votes = el.children.find(c => c.name == 'negative_votes')?.value || '0';
            
            return { 
                ident, 
                name, 
                size: parseInt(size || 0),
                type,
                img,
                positive_votes: parseInt(positive_votes),
                negative_votes: parseInt(negative_votes)
            };
        });
    } catch (error) {
        console.error('Search API error:', error.message);
        return [];
    }
}

async function getFileLink(ident, token) {
    const params = `ident=${encodeURIComponent(ident)}&download_type=video_stream&force_https=1&wst=${encodeURIComponent(token)}`;
    const resp = await needle('post', 'https://webshare.cz/api/file_link/', params, { headers });
    
    const status = resp?.body?.children?.find(el => el.name == 'status')?.value;
    if (status == 'OK') {
        return resp.body.children.find(el => el.name == 'link').value;
    }
    
    // Debug logging pro failed requests
    const errorMsg = resp?.body?.children?.find(el => el.name == 'message')?.value;
    console.log(`getFileLink failed for ${ident}: status=${status}, error=${errorMsg}`);
    return null;
}

// Stealth verze s device parametry — pro custom linky
async function getFileLinkStealth(ident, token) {
    const params = `ident=${encodeURIComponent(ident)}&download_type=video_stream&device_uuid=stremio-addon&device_vendor=Stremio&device_model=WebshareAddon&force_https=1&wst=${encodeURIComponent(token)}`;
    const resp = await needle('post', 'https://webshare.cz/api/file_link/', params, { headers });
    
    const status = resp?.body?.children?.find(el => el.name == 'status')?.value;
    if (status == 'OK') {
        return resp.body.children.find(el => el.name == 'link').value;
    }
    
    const errorMsg = resp?.body?.children?.find(el => el.name == 'message')?.value;
    console.log(`getFileLinkStealth failed for ${ident}: status=${status}, error=${errorMsg}`);
    return null;
}

async function getFileInfo(ident, token) {
    const params = `ident=${encodeURIComponent(ident)}&wst=${encodeURIComponent(token)}`;
    const resp = await needle('post', 'https://webshare.cz/api/file_info/', params, { headers });
    
    if (!resp.body || !resp.body.children) {
        return null;
    }
    
    const children = resp.body.children;
    const name = children.find(el => el.name == 'name')?.value;
    const size = children.find(el => el.name == 'size')?.value;
    const positive_votes = children.find(el => el.name == 'positive_votes')?.value || '0';
    const negative_votes = children.find(el => el.name == 'negative_votes')?.value || '0';
    const description = children.find(el => el.name == 'description')?.value || '';
    const img = children.find(el => el.name == 'img')?.value;
    
    return {
        ident,
        name,
        size: parseInt(size, 10),
        positive_votes: parseInt(positive_votes),
        negative_votes: parseInt(negative_votes),
        description,
        img
    };
}

// Formátování velikosti souboru

// Získat historii stahování z Webshare
async function getWebshareHistory(token, limit = 5) {
    const params = `offset=0&limit=${limit}&wst=${encodeURIComponent(token)}`;
    try {
        const resp = await needle('post', 'https://webshare.cz/api/history/', params, { headers });
        const status = resp?.body?.children?.find(el => el.name === 'status')?.value;
        if (status !== 'OK') return [];
        
        const files = resp.body.children.filter(el => el.name === 'file');
        return files.map(file => {
            const ch = file.children || [];
            return {
                download_id: ch.find(el => el.name === 'download_id')?.value,
                ident: ch.find(el => el.name === 'ident')?.value,
                name: ch.find(el => el.name === 'name')?.value,
                started_at: ch.find(el => el.name === 'started_at')?.value
            };
        });
    } catch (error) {
        console.error('getWebshareHistory error:', error.message);
        return [];
    }
}

// Smazat konkrétní záznamy z historie Webshare
async function clearWebshareHistory(token, ids) {
    const idsParam = ids.map(id => `ids=${encodeURIComponent(id)}`).join('&');
    const params = `${idsParam}&wst=${encodeURIComponent(token)}`;
    try {
        const resp = await needle('post', 'https://webshare.cz/api/clear_history/', params, { headers });
        const status = resp?.body?.children?.find(el => el.name === 'status')?.value;
        console.log(`🗑️ clear_history response: ${status} (ids: ${ids.join(',')})`);
        return status === 'OK';
    } catch (error) {
        console.error('clearWebshareHistory error:', error.message);
        return false;
    }
}

// Po přehrání manuálního linku smazat záznam z Webshare historie
function cleanManualLinkFromHistory(token, ident) {
    setTimeout(async () => {
        try {
            console.log(`🧹 [${ident}] Clearing Webshare history after 3s...`);
            const params = `wst=${encodeURIComponent(token)}`;
            const resp = await needle('post', 'https://webshare.cz/api/clear_history/', params, { headers });
            const status = resp?.body?.children?.find(el => el.name === 'status')?.value;
            console.log(`🧹 [${ident}] clear_history: ${status}`);
        } catch (error) {
            console.error(`🧹 [${ident}] clear_history error:`, error.message);
        }
    }, 3000);
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Detekce rozlišení a kvality z názvu souboru
function detectQuality(filename) {
    const nameUpper = filename.toUpperCase();
    
    // Rozlišení
    const resolutions = ['2160P', '1080P', '720P', '480P', '360P', '4K', 'UHD', 'FHD', 'HD'];
    const resolution = resolutions.find(res => nameUpper.includes(res));
    
    // Codec
    const codecs = ['H265', 'H.265', 'HEVC', 'H264', 'H.264', 'X264', 'X265', 'AVC', 'XVID'];
    const codec = codecs.find(c => nameUpper.includes(c));
    
    // Audio
    const audioFormats = ['DTS', 'AC3', 'AAC', 'FLAC', 'MP3', 'OPUS', 'DD5.1', 'DD+'];
    const audio = audioFormats.find(a => nameUpper.includes(a));
    
    // Source
    const sources = ['BLURAY', 'BLU-RAY', 'BDRIP', 'WEBRIP', 'WEB-DL', 'WEBDL', 'HDTV', 'DVDRIP'];
    const source = sources.find(s => nameUpper.includes(s));
    
    return {
        resolution: resolution || 'SD',
        codec,
        audio,
        source
    };
}

// Kitsu API pro získání názvu z Kitsu ID
async function getKitsuNames(kitsuId) {
    try {
        const resp = await needle('get', `https://kitsu.io/api/edge/anime/${kitsuId}`);
        
        if (resp.body && resp.body.data && resp.body.data.attributes) {
            const attrs = resp.body.data.attributes;
            const names = [];
            
            if (attrs.canonicalTitle) names.push(attrs.canonicalTitle);
            if (attrs.titles) {
                if (attrs.titles.en) names.push(attrs.titles.en);
                if (attrs.titles.en_jp) names.push(attrs.titles.en_jp);
                if (attrs.titles.ja_jp) names.push(attrs.titles.ja_jp);
            }
            if (attrs.abbreviatedTitles) names.push(...attrs.abbreviatedTitles);
            
            // EN název pro display v historii (preferovat en, fallback en_jp, fallback canonicalTitle)
            const enTitle = attrs.titles?.en || attrs.titles?.en_jp || attrs.canonicalTitle || null;
            
            // Získat rok vydání
            let year = null;
            if (attrs.startDate) {
                year = parseInt(attrs.startDate.substring(0, 4));
            }
            
            console.log('Kitsu names:', names);
            console.log('Kitsu EN title:', enTitle);
            console.log('Kitsu year:', year);
            const poster = attrs.posterImage?.original || attrs.posterImage?.large || null;
            return { names: [...new Set(names)], year, poster, enTitle }; // Odstranění duplicit + rok + poster
        }
    } catch (error) {
        console.error('Error getting names from Kitsu:', error.message);
    }
    return { names: [], year: null, poster: null, enTitle: null };
}

// AniList GraphQL API pro získání všech variant názvů anime z názvu
async function getAnimeNamesFromTitle(title) {
    try {
        console.log('=== getAnimeNamesFromTitle START ===');
        console.log('Title:', title);
        
        // Vyčistíme název pro lepší vyhledávání
        const cleanName = title
            .replace(/Don't Toy with Me,?\s*/i, '')
            .replace(/Miss\s+/i, '')
            .replace(/Season \d+/gi, '')
            .replace(/\s+Season$/i, '')
            .trim();
        
        console.log('Cleaned search name:', cleanName);
        
        // Pro názvy s dvojtečkou zkusíme i část před dvojtečkou
        const namesToTry = [title, cleanName];
        if (cleanName.includes(':')) {
            const beforeColon = cleanName.split(':')[0].trim();
            if (beforeColon.length > 3) {
                namesToTry.push(beforeColon);
            }
        }
        
        // Hledáme na AniList (TV i filmy) - vrátíme TOP 10 pro better matching
        const searchQuery = `
        query ($search: String) {
            Page(page: 1, perPage: 10) {
                media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
                    title {
                        romaji
                        english
                        native
                    }
                    synonyms
                    startDate {
                        year
                    }
                    format
                }
            }
        }`;
        
        // Zkusíme všechny varianty názvu
        for (const name of namesToTry) {
            console.log('Searching AniList with:', name);
            
            const searchResp = await needle('post', 'https://graphql.anilist.co', {
                query: searchQuery,
                variables: { search: name }
            }, {
                json: true
            });
            
            console.log('AniList response status:', searchResp.statusCode);
            
            if (searchResp.body && searchResp.body.data && searchResp.body.data.Page) {
                const mediaList = searchResp.body.data.Page.media || [];
                
                if (mediaList.length === 0) {
                    console.log('No results from AniList');
                    continue;
                }
                
                // Najdeme nejlepší match podle similarity
                let bestMatch = null;
                let bestSimilarity = 0;
                
                for (const media of mediaList) {
                    const names = [];
                    if (media.title.romaji) names.push(media.title.romaji);
                    if (media.title.english) names.push(media.title.english);
                    if (media.synonyms) names.push(...media.synonyms);
                    
                    // Spočítáme similarity s search termem
                    const searchLower = name.toLowerCase();
                    const searchWords = searchLower.split(/\s+/).filter(w => w.length > 0);
                    
                    let maxSimilarity = 0;
                    for (const anilistName of names) {
                        const anilistLower = anilistName.toLowerCase();
                        const matchingWords = searchWords.filter(word => anilistLower.includes(word)).length;
                        const similarity = searchWords.length > 0 ? matchingWords / searchWords.length : 0;
                        if (similarity > maxSimilarity) maxSimilarity = similarity;
                    }
                    
                    if (maxSimilarity > bestSimilarity) {
                        bestSimilarity = maxSimilarity;
                        bestMatch = media;
                    }
                }
                
                // Použijeme nejlepší match pokud má alespoň nějakou shodu
                if (bestMatch && bestSimilarity > 0) {
                    const media = bestMatch;
                    const names = [];
                    
                    if (media.title.romaji) names.push(media.title.romaji);
                    if (media.title.english) names.push(media.title.english);
                    if (media.title.native) names.push(media.title.native);
                    if (media.synonyms) names.push(...media.synonyms);
                    
                    console.log('Found on AniList:', names);
                    console.log('AniList year:', media.startDate?.year || 'unknown');
                    console.log('Best match similarity:', bestSimilarity.toFixed(2));
                    console.log('=== getAnimeNamesFromTitle SUCCESS ===');
                    
                    // Vrátíme názvy + rok
                    return {
                        names: [...new Set(names)],
                        year: media.startDate?.year || null
                    };
                }
            }
        }
        
        console.log('Not found on AniList');
        console.log('=== getAnimeNamesFromTitle FAIL ===');
    } catch (error) {
        console.error('=== getAnimeNamesFromTitle ERROR ===');
        console.error('Error:', error.message);
    }
    
    return { names: [], year: null };
}
async function getAnimeNames(imdbId) {
    const query = `
    query ($idMal: Int) {
        Media(idMal: $idMal, type: ANIME) {
            title {
                romaji
                english
                native
            }
            synonyms
        }
    }`;

    try {
        // Nejdřív musíme získat MAL ID z IMDb ID pomocí mapping databáze
        const malId = await getMALfromIMDb(imdbId);
        if (!malId) return [];

        const variables = { idMal: malId };
        
        const resp = await needle('post', 'https://graphql.anilist.co', {
            query,
            variables
        }, {
            json: true
        });

        if (resp.body && resp.body.data && resp.body.data.Media) {
            const media = resp.body.data.Media;
            const names = [];
            
            // Přidáme všechny varianty názvů
            if (media.title.romaji) names.push(media.title.romaji);
            if (media.title.english) names.push(media.title.english);
            if (media.title.native) names.push(media.title.native);
            if (media.synonyms) names.push(...media.synonyms);
            
            // Odstraníme duplicity
            return [...new Set(names)];
        }
    } catch (error) {
        console.error('Error getting anime names from AniList:', error.message);
    }
    
    return [];
}

// Pomocná funkce pro získání MAL ID z IMDb ID
async function getMALfromIMDb(imdbId) {
    try {
        // Použijeme anime-offline-database mapping
        const resp = await needle('get', 'https://raw.githubusercontent.com/manami-project/anime-offline-database/master/anime-offline-database-minified.json');
        
        if (resp.body && resp.body.data) {
            const anime = resp.body.data.find(a => 
                a.sources && a.sources.some(s => s.includes(imdbId))
            );
            
            if (anime && anime.sources) {
                const malSource = anime.sources.find(s => s.includes('myanimelist.net'));
                if (malSource) {
                    const malId = malSource.match(/anime\/(\d+)/);
                    return malId ? parseInt(malId[1]) : null;
                }
            }
        }
    } catch (error) {
        console.error('Error getting MAL ID:', error.message);
    }
    return null;
}

// Fallback na Cinemeta
async function getCinemetaName(type, id) {
    try {
        const baseId = id.split(':')[0];
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${baseId}.json`;
        const resp = await needle('get', url);
        
        if (resp.body && resp.body.meta && resp.body.meta.name) {
            return [resp.body.meta.name];
        }
    } catch (error) {
        console.error('Error getting name from Cinemeta:', error.message);
    }
    return [];
}

// Získání názvů z TMDB (české + anglické)
async function getTMDBNames(imdbId, type, apiKey) {
    // Pokud není API klíč, vrátíme prázdný objekt
    if (!apiKey || apiKey.trim() === '') {
        console.log('TMDB API key not provided, skipping TMDB');
        return { names: [], isJapanese: false };
    }
    
    try {
        console.log('Getting names from TMDB for', imdbId);
        
        const names = [];
        let isJapanese = false;
        
        // Nejdřív zkusíme česky
        const urlCZ = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id&language=cs-CZ`;
        const respCZ = await needle('get', urlCZ);
        
        console.log('TMDB CZ status:', respCZ.statusCode);
        console.log('TMDB CZ body:', JSON.stringify(respCZ.body, null, 2));
        
        if (respCZ.statusCode === 200 && respCZ.body) {
            // Zkontrolujeme TV i filmy
            const tvResults = respCZ.body.tv_results || [];
            const movieResults = respCZ.body.movie_results || [];
            const results = [...tvResults, ...movieResults];
            
            console.log('TMDB CZ results count:', results.length);
            if (results.length > 0) {
                const media = results[0];
                // Detekce japonského obsahu
                if (media.original_language === 'ja') {
                    isJapanese = true;
                }
                // Přidáme lokalizovaný název
                if (media.name) names.push(media.name); // TV show
                if (media.title) names.push(media.title); // Movie
            }
        } else if (respCZ.statusCode === 401) {
            console.log('TMDB API key is invalid (401 Unauthorized)');
            return { names: [], isJapanese: false };
        }
        
        // Pak anglicky
        const urlEN = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id&language=en-US`;
        const respEN = await needle('get', urlEN);
        
        if (respEN.statusCode === 200 && respEN.body) {
            // Zkontrolujeme TV i filmy
            const tvResults = respEN.body.tv_results || [];
            const movieResults = respEN.body.movie_results || [];
            const results = [...tvResults, ...movieResults];
            
            if (results.length > 0) {
                const media = results[0];
                // Přidáme anglické názvy (pokud už nejsou)
                if (media.name && !names.includes(media.name)) names.push(media.name);
                if (media.title && !names.includes(media.title)) names.push(media.title);
            }
        }
        
        // Filtrujeme - POUZE latinské znaky (žádná japonština, čínština, korejština)
        const latinNames = names.filter(name => {
            return /^[\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF\s]+$/.test(name);
        });
        
        console.log('TMDB names (latin only):', latinNames);
        const finalNames = latinNames.length > 0 ? latinNames : names;
        return { names: finalNames, isJapanese };
    } catch (error) {
        console.error('Error getting TMDB names:', error.message);
    }
    return { names: [], isJapanese: false };
}



// Stream handler funkce - použita jak builderem tak personal routes
async function handleStreamRequest(args, req) {
    console.log('=== STREAM REQUEST ===');
    console.log('Full args:', JSON.stringify(args, null, 2));
    console.log('Type:', args.type);
    console.log('ID:', args.id);
    console.log('Config:', args.config ? 'present' : 'missing');
    
    try {
        const { username, password } = args.config;
        if (!username || !password) {
            console.log('Missing credentials');
            return { streams: [] };
        }

        // Kontrola banu
        if (await isBanned(username)) {
            console.log(`🚫 Banned user attempted access: ${username}`);
            return { streams: [{ name: '🚫 Zablokováno', title: 'Váš účet byl zablokován. Kontaktujte administrátora.', url: '#' }] };
        }

        // Připravíme heslo a přihlásíme se
        const saltedPassword = await saltPassword(username, password);
        const token = await login(username, saltedPassword);
        
        // Proměnné pro display name v historii (vyplní se v TMDB/Kitsu větvi)
        let _tmdbNames = null;
        let _isJapaneseContent = false;
        let _kitsuPoster = null;
        
        // NOVÉ: Handling pro webshare- ID (z direct search)
        if (args.id.startsWith('webshare-')) {
            console.log('Direct search file request');
            const fileIdent = args.id.substring(9); // Remove "webshare-" prefix
            console.log('File ident:', fileIdent);
            
            try {
                // Získat info o souboru (hlavně název!)
                console.log('Getting file info...');
                const fileInfo = await getFileInfo(fileIdent, token);
                
                if (!fileInfo || !fileInfo.name) {
                    console.log('No file info available for ident:', fileIdent);
                    return { streams: [] };
                }
                
                console.log('File name:', fileInfo.name);
                
                // Získat link pro TENTO konkrétní soubor
                console.log('Getting file link...');
                const link = await getFileLink(fileIdent, token);
                
                if (!link) {
                    console.log('No link available for file:', fileIdent);
                    return { streams: [] };
                }
                
                console.log('Returning stream with proper filename');
                
                // Detekce kvality pro stream název
                const qualityInfo = detectQuality(fileInfo.name);
                
                // Sestavit název streamu
                let streamName = 'Webshare';
                if (qualityInfo.resolution) streamName += ` 📺${qualityInfo.resolution}`;
                if (qualityInfo.codec) streamName += ` 🎬${qualityInfo.codec}`;
                streamName += ` 💾${formatBytes(fileInfo.size)}`;
                
                // Vrátit JEN tento jeden soubor
                return {
                    streams: [{
                        name: streamName,
                        title: fileInfo.name,  // Správný název místo identu
                        url: link
                    }]
                };
                
            } catch (error) {
                console.error('Error in webshare- handler:', error.message);
                console.error('Stack:', error.stack);
                return { streams: [] };
            }
        }
        
        // Získáme všechny varianty názvů
        let searchQueries = [];
        let cinemataYear = null; // Pro filtrování filmů podle roku (TMDB)
        let kitsuYear = null; // Pro filtrování anime filmů podle roku (Kitsu)
        
        if (args.id.startsWith('kitsu:')) {
            // Kitsu ID formát: kitsu:ID:episode (3 části, sezona je vždy 1)
            const parts = args.id.split(':');
            console.log('Kitsu ID parts:', parts);
            console.log('Parts length:', parts.length);
            
            const kitsuId = parts[1];
            const episode = parts[2];
            const season = 1; // Kitsu nemá sezony, vždy 1
            
            console.log('Parsed - kitsuId:', kitsuId, 'episode:', episode, 'season:', season);

            // Pokud není číslo epizody, hledáme obecně celý seriál
            // (metadata addon neposílá správný formát)
            if (!episode) {
                console.log('No episode number - searching for entire series');
            }

            // Získáme názvy z Kitsu API
            const kitsuData = await getKitsuNames(kitsuId);
            const names = kitsuData.names;
            kitsuYear = kitsuData.year;
            
            // Pro display name a poster v historii
            // Použít EN název z Kitsu jako display name
            _tmdbNames = kitsuData.enTitle ? [kitsuData.enTitle] : (names.length > 0 ? names : null);
            _isJapaneseContent = true;
            _kitsuPoster = kitsuData.poster || null;
            
            console.log('Found names from Kitsu:', names);

            if (names.length === 0) {
                console.log('No names found from Kitsu, returning empty');
                return { streams: [] };
            }

            // Filtrujeme jen názvy bez japonských znaků
            let latinNames = names.filter(name => {
                // Ponecháme jen názvy v latinské abecedě (a-z, A-Z, 0-9, mezery, pomlčky, atd.)
                return /^[\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF]+$/.test(name);
            });
            
            console.log('Filtered to latin names:', latinNames);
            
            // Odfiltrovat příliš krátké názvy (akronymy jako "HOTD", "HSOTD")
            // POUZE pro series - pro filmy jsou jednoslovné názvy legitimní (Paprika, Akira)
            if (args.type === 'series') {
                latinNames = latinNames.filter(name => {
                    const words = name.split(/\s+/);
                    return name.length >= 8 || words.length >= 2;
                });
                
                console.log('After removing acronyms:', latinNames);
            }
            
            if (latinNames.length === 0) {
                console.log('No latin names available, returning empty');
                return { streams: [] };
            }

            // Použijeme všechny latinské názvy pro lepší pokrytí
            if (args.type === 'series' && episode) {
                const seasonEp = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                const episodeOnly = `E${String(episode).padStart(2, '0')}`;
                const plainNumber = String(episode).padStart(2, '0');
                
                for (const name of latinNames) {
                    const cleanName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\//g, ' ').replace(/[!?:\*]/g, '');
                    
                    // Plný název
                    searchQueries.push(`${cleanName} ${seasonEp}`);
                    searchQueries.push(`${cleanName} ${episodeOnly}`);
                    searchQueries.push(`${cleanName} ${plainNumber}`);
                    
                    // Kratší varianta - první 2 slova (pro "Mushoku Tensei: Long Subtitle")
                    const words = cleanName.split(/\s+/);
                    if (words.length > 3) {
                        const shortName = words.slice(0, 3).join(' ');
                        searchQueries.push(`${shortName} ${seasonEp}`);
                        searchQueries.push(`${shortName} ${episodeOnly}`);
                        searchQueries.push(`${shortName} ${plainNumber}`);
                    }
                }
            } else {
                // Žádné číslo epizody - hledáme jen název (BEZ krátkých variant - příliš obecné)
                for (const name of latinNames) {
                    const cleanName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\//g, ' ').replace(/[!?:\*]/g, '');
                    searchQueries.push(cleanName);
                }
            }
        } else if (args.id.startsWith('tt')) {
            const parts = args.id.split(':');
            const imdbId = parts[0];
            const season = parts[1];
            const episode = parts[2];

            console.log('IMDb ID detected, checking if it is anime on AniList...');

            // Zkusíme TMDB jako PRIMÁRNÍ zdroj
            console.log('Trying TMDB as primary source...');
            const tmdbResult = await getTMDBNames(args.id.split(':')[0], args.type, args.config.tmdb_api_key);
            const tmdbNames = tmdbResult.names || [];
            const isJapaneseContent = tmdbResult.isJapanese || false;
            _tmdbNames = tmdbNames;
            _isJapaneseContent = isJapaneseContent;
            
            let names = [];
            let primarySource = 'tmdb';
            
            if (tmdbNames.length > 0) {
                console.log('TMDB found:', tmdbNames);
                
                // Pro japonský obsah (anime) použijeme anglický název + CZ/romaji z TMDB
                if (isJapaneseContent) {
                    console.log('Detected Japanese content - using English name + romaji from TMDB');
                    // Poslední název je anglický (z EN query)
                    const englishName = tmdbNames[tmdbNames.length - 1];
                    names = [englishName];
                    // Přidat i CZ název z TMDB (pro anime to bývá romaji, např. "Sósó no Frieren")
                    if (tmdbNames.length > 1 && tmdbNames[0] !== englishName) {
                        names.push(tmdbNames[0]);
                    }
                } else {
                    // Běžný obsah - použijeme všechny názvy (CZ + EN)
                    names = tmdbNames;
                }
                
                // Získáme rok z TMDB
                try {
                    const baseId = args.id.split(':')[0];
                    const tmdbUrl = `https://api.themoviedb.org/3/find/${baseId}?api_key=${args.config.tmdb_api_key}&external_source=imdb_id`;
                    console.log('Fetching year from TMDB:', tmdbUrl.replace(args.config.tmdb_api_key, 'API_KEY'));
                    const tmdbResp = await needle('get', tmdbUrl);
                    
                    console.log('TMDB year response status:', tmdbResp.statusCode);
                    if (tmdbResp.body) {
                        const tvResults = tmdbResp.body.tv_results || [];
                        const movieResults = tmdbResp.body.movie_results || [];
                        console.log('TMDB year results:', { tv: tvResults.length, movie: movieResults.length });
                        
                        const results = [...tvResults, ...movieResults];
                        if (results.length > 0) {
                            const dateStr = results[0].first_air_date || results[0].release_date;
                            console.log('Date string from TMDB:', dateStr);
                            if (dateStr) {
                                cinemataYear = new Date(dateStr).getFullYear();
                                console.log('TMDB year:', cinemataYear);
                            }
                        } else {
                            console.log('No results from TMDB year fetch');
                        }
                    }
                } catch (e) {
                    console.log('Could not get year from TMDB:', e.message);
                }
            } else {
                // TMDB nenašlo nic - použijeme Cinemeta jako zálohu
                console.log('TMDB not found, falling back to Cinemeta...');
                primarySource = 'cinemeta';
                
                const cinemataNames = await getCinemetaName(args.type, args.id);
                
                if (cinemataNames.length === 0) {
                    console.log('Cinemeta also returned no name - cannot proceed');
                    return { streams: [] };
                }
                
                names = cinemataNames;
                console.log('Got name from Cinemeta:', cinemataNames[0]);
                
                // Získáme rok z Cinemeta
                try {
                    const baseId = args.id.split(':')[0];
                    const cinemataResp = await needle('get', `https://v3-cinemeta.strem.io/meta/${args.type}/${baseId}.json`);
                    if (cinemataResp.body?.meta?.released) {
                        cinemataYear = new Date(cinemataResp.body.meta.released).getFullYear();
                        console.log('Cinemeta year:', cinemataYear);
                    }
                } catch (e) {
                    console.log('Could not get year from Cinemeta');
                }
            }
            
            // Pro anime - zkusíme AniList (JEN pro japonský obsah)
            let anilistNames = [];
            let anilistYear = null;
            let searchName = ''; // Název použitý pro AniList search
            
            if (isJapaneseContent) {
                // Pro anime používáme ANGLICKÝ název pro AniList search
                searchName = names.length > 1 ? names[names.length - 1] : names[0]; // Poslední = anglický
                console.log('Checking if anime on AniList with name:', searchName);
                
                const anilistResult = await getAnimeNamesFromTitle(searchName);
                anilistNames = anilistResult.names;
                anilistYear = anilistResult.year;
            } else {
                console.log('Not Japanese content - skipping AniList check');
            }
            
            if (anilistNames.length > 0) {
                // Zkontrolujeme, jestli je to opravdu stejné anime
                const searchNameLower = searchName.toLowerCase();
                const searchWords = searchNameLower.split(/\s+/).filter(w => w.length > 3);
                
                let bestSimilarity = 0;
                let bestMatchName = anilistNames[0];
                
                for (const anilistName of anilistNames) {
                    const anilistLower = anilistName.toLowerCase();
                    const matchingWords = searchWords.filter(word => anilistLower.includes(word)).length;
                    const similarity = searchWords.length > 0 ? matchingWords / searchWords.length : 0;
                    
                    if (similarity > bestSimilarity) {
                        bestSimilarity = similarity;
                        bestMatchName = anilistName;
                    }
                }
                
                console.log(`Similarity check: ${bestSimilarity.toFixed(2)} (best match: "${bestMatchName}")`);
                
                // Kontrola roku - pro anime tolerujeme větší rozdíl (AniList často vrací rok poslední série)
                let yearMatch = true;
                if (anilistYear && cinemataYear) {
                    const yearDiff = Math.abs(anilistYear - cinemataYear);
                    console.log(`Year difference: ${yearDiff} years (AniList: ${anilistYear}, Source: ${cinemataYear})`);
                    
                    // Tolerujeme 3 roky rozdíl (anime mají více sérií s různými roky)
                    if (yearDiff > 3) {
                        console.log(`Year difference too large - probably not the same content`);
                        yearMatch = false;
                    }
                }
                
                // Pokud se názvy shodují aspoň z 30% A roky sedí, je to anime
                if (bestSimilarity >= 0.3 && yearMatch) {
                    console.log('Found anime on AniList - using AniList names only (English/Romaji)');
                    
                    // Filtrujeme jen základní latinku (bez diakritiky pro jiné jazyky)
                    // Povolujeme: a-z, A-Z, 0-9, mezery, pomlčky, apostrofy, závorky
                    // Zakazujeme: á, ñ, ü, ř, č atd. (české, španělské, německé...)
                    // Filtrujeme a upravujeme názvy
                    const englishRomajiNames = [];
                    for (const name of anilistNames) {
                        // Jen základní ASCII znaky (bez diakritiky)
                        if (!/^[a-zA-Z0-9\s\-':!\[\]\(\)\.&]+$/.test(name)) {
                            continue;
                        }
                        
                        // Odstranit suffix se spin-offy a speciály
                        let cleanedName = name;
                        const nameLower = name.toLowerCase();
                        const spinoffKeywords = ['mini anime', 'chibi', 'special', 'ova', 'ona', 'picture drama', 'recap', 'marumaru'];
                        
                        // Pokud obsahuje spinoff keyword, extrahujeme základní název (část před sufixem)
                        // MUSÍ být word boundary - "ona" nesmí matchovat "Sayonara"
                        for (const keyword of spinoffKeywords) {
                            // Regex s word boundaries
                            const keywordRegex = new RegExp(`\\b${keyword}\\b`, 'i');
                            const match = keywordRegex.exec(nameLower);
                            if (match && match.index > 0) {
                                // Extrahujeme část před sufixem, odstraníme " :", " -", " ~" na konci
                                cleanedName = name.substring(0, match.index).replace(/[\s:\-~●]+$/, '').trim();
                                break;
                            }
                        }
                        
                        // Přidat pouze pokud má aspoň 3 znaky
                        if (cleanedName.length >= 3 && !englishRomajiNames.includes(cleanedName)) {
                            englishRomajiNames.push(cleanedName);
                        }
                    }
                    
                    console.log('Filtered to English/Romaji names:', englishRomajiNames);
                    
                    if (englishRomajiNames.length > 0) {
                        // Pro anime používáme JEN anglické/romaji názvy
                        names = englishRomajiNames;
                    } else {
                        // Žádné anglické názvy z AniList - použijeme anglický z TMDB + romaji
                        console.log('No English/Romaji names from AniList, using English from TMDB + original romaji');
                        const englishName = tmdbNames.length > 1 ? tmdbNames[tmdbNames.length - 1] : tmdbNames[0];
                        names = [englishName];
                        
                        // Přidat také romaji název z TMDB (pokud je jiný než anglický)
                        if (tmdbNames.length > 1 && tmdbNames[0] !== englishName) {
                            names.push(tmdbNames[0]);  // Přidat romaji název
                        }
                    }
                }
            }

            console.log('Final names for search:', names);
            
            // Speciální případ: The Simpsons (tt0096697) má na Webshare obfuskovaný název
            if (imdbId === 'tt0096697') {
                console.log('Detected The Simpsons - adding obfuscated name');
                names.push('Simps.novi');
            }

            if (names.length === 0) {
                console.log('No names found, returning empty');
                return { streams: [] };
            }

            // Pro anime (více názvů z AniList) - hledáme s každým názvem
            if (names.length > 1) {
                console.log('Using multiple names from AniList for better coverage');
                if (args.type === 'series' && season && episode) {
                    const seasonEp = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                    const episodeOnly = `E${String(episode).padStart(2, '0')}`;
                    
                    // Použijeme jen první 3 názvy (romaji + english + hlavní synonym)
                    for (const name of names.slice(0, 3)) {
                        // Vyčistíme speciální znaky a diakritiku
                        const cleanName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\//g, ' ').replace(/[!?:\*]/g, '');
                        const cleanNameNoSuffix = cleanName.replace(/\s*\(TV\)\s*$/i, '').trim();
                        
                        // Varianta s "ou" romanizací (Sayonara → Sayounara)
                        // Nahradíme "o" následované samohláskou za "ou"
                        const nameWithOu = cleanNameNoSuffix.replace(/o([aeiou])/gi, 'ou$1');
                        const hasOuVariant = nameWithOu !== cleanNameNoSuffix;
                        
                        // Varianta pro japonské dlouhé samohlásky: ō→ou, ū→uu
                        let longVowelVariant = null;
                        if (isJapaneseContent) {
                            const lvName = name.normalize('NFD')
                                .replace(/o\u0301/gi, 'ou')
                                .replace(/u\u0301/gi, 'uu')
                                .replace(/a\u0301/gi, 'aa')
                                .replace(/[\u0300-\u036f]/g, '')
                                .replace(/\//g, ' ')
                                .replace(/[!?:\*]/g, '');
                            if (lvName !== cleanName) {
                                longVowelVariant = lvName;
                            }
                        }
                        
                        searchQueries.push(`${cleanName} ${seasonEp}`);
                        searchQueries.push(`${cleanNameNoSuffix} ${seasonEp}`);
                        if (hasOuVariant) searchQueries.push(`${nameWithOu} ${seasonEp}`);
                        if (longVowelVariant) searchQueries.push(`${longVowelVariant} ${seasonEp}`);
                        
                        // Jen epizoda
                        searchQueries.push(`${cleanName} ${episodeOnly}`);
                        searchQueries.push(`${cleanNameNoSuffix} ${episodeOnly}`);
                        if (hasOuVariant) searchQueries.push(`${nameWithOu} ${episodeOnly}`);
                        if (longVowelVariant) searchQueries.push(`${longVowelVariant} ${episodeOnly}`);
                        
                        // Jen číslo
                        const plainNumber = String(episode).padStart(2, '0');
                        searchQueries.push(`${cleanName} ${plainNumber}`);
                        searchQueries.push(`${cleanNameNoSuffix} ${plainNumber}`);
                        if (hasOuVariant) searchQueries.push(`${nameWithOu} ${plainNumber}`);
                        if (longVowelVariant) searchQueries.push(`${longVowelVariant} ${plainNumber}`);
                        
                        // Kratší varianta - první 2 slova
                        const words = cleanNameNoSuffix.split(/\s+/);
                        if (words.length > 3) {
                            const shortName = words.slice(0, 3).join(' ');
                            searchQueries.push(`${shortName} ${seasonEp}`);
                            searchQueries.push(`${shortName} ${episodeOnly}`);
                            searchQueries.push(`${shortName} ${plainNumber}`);
                        }
                    }
                } else {
                    // Jen první 3 názvy + long vowel varianty
                    searchQueries = [];
                    for (const n of names.slice(0, 3)) {
                        const clean = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\//g, ' ').replace(/[!?:\*]/g, '');
                        searchQueries.push(clean);
                        if (isJapaneseContent) {
                            const lvName = n.normalize('NFD')
                                .replace(/o\u0301/gi, 'ou')
                                .replace(/u\u0301/gi, 'uu')
                                .replace(/[\u0300-\u036f]/g, '')
                                .replace(/\//g, ' ')
                                .replace(/[!?:\*]/g, '');
                            if (lvName !== clean) searchQueries.push(lvName);
                        }
                    }
                }
            } else {
                // Jeden nebo více názvů (z TMDB nebo Cinemeta)
                // Pro každý název vytvoříme samostatný search query
                if (args.type === 'series' && season && episode) {
                    const seasonEp = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                    const episodeOnly = `E${String(episode).padStart(2, '0')}`;
                    
                    for (const name of names) {
                        const cleanName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\//g, ' ').replace(/[!?:\*]/g, '');
                        const cleanNameNoSuffix = cleanName.replace(/\s*\(TV\)\s*$/i, '').trim(); // Odstranit "(TV)" suffix
                        
                        // Varianta s "ou" romanizací (Sayonara → Sayounara)
                        const nameWithOu = cleanNameNoSuffix.replace(/o([aeiou])/gi, 'ou$1');
                        const hasOuVariant = nameWithOu !== cleanNameNoSuffix;
                        
                        // Varianta pro japonské dlouhé samohlásky: ō→ou, ū→uu
                        // TMDB dává např. "Sósó" → po NFD normalizaci "Soso" → potřebujeme "Sousou"
                        // Zjistíme jestli originální název obsahuje dlouhé samohlásky (ō, ū, ā)
                        const origNFD = name.normalize('NFD');
                        const hasLongVowels = /[oōuūaā]\u0301/i.test(origNFD) || /[ōūā]/i.test(name);
                        let longVowelVariant = null;
                        if (hasLongVowels || isJapaneseContent) {
                            // Zkusíme o→ou, u→uu variantu na pozicích kde byl accent
                            // Jednodušší přístup: pro každé 'o' v romaji přidáme 'ou' variantu
                            const lvName = name.normalize('NFD')
                                .replace(/o\u0301/gi, 'ou')  // ó → ou
                                .replace(/u\u0301/gi, 'uu')  // ú → uu
                                .replace(/a\u0301/gi, 'aa')  // á → aa (vzácné v JP)
                                .replace(/[\u0300-\u036f]/g, '') // odstranit zbylou diakritiku
                                .replace(/\//g, ' ')
                                .replace(/[!?:\*]/g, '');
                            if (lvName !== cleanName) {
                                longVowelVariant = lvName;
                            }
                        }
                        
                        // Standardní formát S01E04
                        searchQueries.push(`${cleanName} ${seasonEp}`);
                        searchQueries.push(`${cleanNameNoSuffix} ${seasonEp}`);
                        if (hasOuVariant) searchQueries.push(`${nameWithOu} ${seasonEp}`);
                        if (longVowelVariant) searchQueries.push(`${longVowelVariant} ${seasonEp}`);
                        
                        // Pouze epizoda E04
                        searchQueries.push(`${cleanName} ${episodeOnly}`);
                        searchQueries.push(`${cleanNameNoSuffix} ${episodeOnly}`);
                        if (hasOuVariant) searchQueries.push(`${nameWithOu} ${episodeOnly}`);
                        if (longVowelVariant) searchQueries.push(`${longVowelVariant} ${episodeOnly}`);
                        
                        // Jen číslo 01, 04 apod. (pro webshare formát)
                        const plainNumber = String(episode).padStart(2, '0');
                        searchQueries.push(`${cleanName} ${plainNumber}`);
                        searchQueries.push(`${cleanNameNoSuffix} ${plainNumber}`);
                        if (hasOuVariant) searchQueries.push(`${nameWithOu} ${plainNumber}`);
                        if (longVowelVariant) searchQueries.push(`${longVowelVariant} ${plainNumber}`);
                        
                        // Kratší varianta - první 2 slova
                        const words = cleanNameNoSuffix.split(/\s+/);
                        if (words.length > 3) {
                            const shortName = words.slice(0, 3).join(' ');
                            searchQueries.push(`${shortName} ${seasonEp}`);
                            searchQueries.push(`${shortName} ${episodeOnly}`);
                            searchQueries.push(`${shortName} ${plainNumber}`);
                        }
                    }
                } else {
                    // Filmy nebo bez epizody
                    searchQueries = [];
                    for (const n of names) {
                        const clean = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\//g, ' ').replace(/[!?:\*]/g, '');
                        searchQueries.push(clean);
                        // Dlouhé samohlásky pro anime filmy
                        if (isJapaneseContent) {
                            const lvName = n.normalize('NFD')
                                .replace(/o\u0301/gi, 'ou')
                                .replace(/u\u0301/gi, 'uu')
                                .replace(/[\u0300-\u036f]/g, '')
                                .replace(/\//g, ' ')
                                .replace(/[!?:\*]/g, '');
                            if (lvName !== clean) searchQueries.push(lvName);
                        }
                    }
                }
            }
        } else {
            searchQueries = [args.id];
        }

        console.log('Search queries:', searchQueries);
        
        // ========== CHECK PRO MANUÁLNÍ LINKY ==========
        // Zkontrolovat jestli existují manuální linky pro tento query
        let manualLinkStreams = [];
        if (searchQueries.length > 0) {
            const manualLinks = await getManualLinks();
            const queryKey = `${args.id.split(':')[0]}: ${searchQueries[0]}`;
            console.log('Checking manual links for:', queryKey);
            
            if (manualLinks[queryKey] && Array.isArray(manualLinks[queryKey])) {
                // LIMIT: Max 10 manual links per title pro výkonnost
                const maxLinks = 10;
                const linksToProcess = manualLinks[queryKey].slice(0, maxLinks);
                
                console.log(`Found ${manualLinks[queryKey].length} manual links, processing ${linksToProcess.length}`);
                
                // Paralelní fetchování všech manual links (rychlejší než sequential)
                const linkPromises = linksToProcess.map(async (manual, i) => {
                    console.log(`[Manual ${i}] Processing:`, manual.webshare_ident, manual.display_name);
                    try {
                        console.log(`[Manual ${i}] Fetching file info...`);
                        const fileInfo = await getFileInfo(manual.webshare_ident, token);
                        if (!fileInfo) {
                            console.log(`[Manual ${i}] ❌ No file info returned - marking as broken`);
                            await markLinkAsBroken(queryKey, i);
                            return null;
                        }
                        console.log(`[Manual ${i}] ✅ File info:`, fileInfo.name);
                        
                        // Proxy URL — stream jde přes addon server (nezapisuje se do WS historie)
                        const baseUrl = req ? `${req.protocol}://${req.get('host')}` : (process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 7000}`);
                        const proxyUrl = `${baseUrl}/proxy/${encodeURIComponent(token)}/${manual.webshare_ident}`;
                        console.log(`[Manual ${i}] ✅ Proxy URL created`);
                        
                        const quality = detectQuality(fileInfo.name);
                        const qualityStr = quality.resolution || 'SD';
                        const sizeStr = formatSize(fileInfo.size);
                        
                        const nameUpper = fileInfo.name.toUpperCase();
                        const languages = [];
                        if (nameUpper.includes('CZ') || nameUpper.includes('CZECH')) languages.push('🇨🇿 CZ');
                        if (nameUpper.includes('SK') || nameUpper.includes('SLOVAK')) languages.push('🇸🇰 SK');
                        if (nameUpper.includes('EN') || nameUpper.includes('ENGLISH')) languages.push('🇬🇧 EN');
                        
                        const langStr = languages.length > 0 ? languages.join('+') + ' ' : '';
                        const streamName = `📌 Webshare ${langStr}📺${qualityStr} 💾${sizeStr}`;
                        
                        const stream = {
                            name: streamName,
                            title: `📌 ${manual.display_name || 'Manuální link'}`,
                            url: proxyUrl,
                            behaviorHints: {
                                bingeGroup: 'webshare-manual',
                                videoSize: fileInfo.size,
                                filename: fileInfo.name
                            }
                        };
                        console.log(`[Manual ${i}] ✅ Stream created:`, stream.title);
                        return stream;
                    } catch (error) {
                        console.error(`[Manual ${i}] ❌ ERROR:`, error.message);
                        console.error(`[Manual ${i}] Stack:`, error.stack);
                        return null;
                    }
                });
                
                // Počkat na všechny paralelně (rychlé)
                const results = await Promise.all(linkPromises);
                
                manualLinkStreams = results.filter(s => s !== null);
                console.log(`Loaded ${manualLinkStreams.length}/${linksToProcess.length} manual link streams`);
                
                // Po 5s zkontrolovat Webshare historii a smazat záznamy manuálních linků
                if (manualLinkStreams.length > 0) {
                    const manualIdents = linksToProcess.map(m => m.webshare_ident);
                    manualIdents.forEach(ident => {
                        // cleanManualLinkFromHistory(token, ident); // DOČASNĚ VYPNUTO
                    });
                }
            }
        }

        // Vyhledáme pomocí všech variant názvů
        const allResults = await Promise.all(
            searchQueries.map(query => search(query, token))
        );

        // Sloučíme výsledky a odstraníme duplicity podle ident
        const uniqueResults = {};
        allResults.flat().forEach(result => {
            uniqueResults[result.ident] = result;
        });
        const results = Object.values(uniqueResults);

        if (results.length === 0) {
            return { streams: [] };
        }

        console.log(`Found ${results.length} unique results`);

        // Vytvoříme klíčová slova z search queries pro filtrování a sorting
        const searchKeywords = searchQueries.map(q => {
            // Odstraníme S01E08, E08 apod.
            return q.replace(/S\d+E\d+/gi, '').replace(/\sE\d+/gi, '').trim().toLowerCase();
        });
        console.log('Search keywords for matching:', searchKeywords);
        
        // Pomocná funkce pro normalizaci českých znaků
        const normalizeChars = (str) => {
            return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        };

        // Pokud hledáme konkrétní epizodu, filtrujeme jen tu
        let filteredResults = results;
        
        // Pro FILMY: filtrujeme podle roku (pokud je v názvu)
        if (args.type === 'movie' && (cinemataYear || kitsuYear)) {
            const expectedYear = cinemataYear || kitsuYear;
            console.log(`Filtering movies by year: ${expectedYear} (±1 year tolerance)`);
            filteredResults = results.filter(result => {
                // Hledáme rok v názvu (formát: 2009, (2011), .2015., Passengers.2016)
                // Regex hledá 4 číslice s oddělovačem PŘED (ale ne nutně PO)
                const yearMatches = result.name.match(/[\(\.\s\-_](\d{4})(?!p)/gi);
                if (yearMatches) {
                    // Extrahujeme všechna čtyřciferná čísla
                    const years = yearMatches.map(m => parseInt(m.match(/(\d{4})/)[1]));
                    // Filtrujeme jen roky mezi 1920-2030 (ignoruje 1080p, 720p, atd.)
                    const validYears = years.filter(y => y >= 1920 && y <= 2030);
                    
                    if (validYears.length > 0) {
                        // Zkontrolujeme jestli nějaký rok sedí
                        const hasMatchingYear = validYears.some(fileYear => {
                            const yearDiff = Math.abs(fileYear - expectedYear);
                            return yearDiff <= 1;
                        });
                        
                        if (!hasMatchingYear) {
                            console.log(`  Filtered out: ${result.name.substring(0, 50)} (years ${validYears} vs ${expectedYear})`);
                            return false;
                        }
                    }
                }
                return true;
            });
            console.log(`After year filter: ${filteredResults.length} results`);
        }
        
        // Pro FILMY: filtrujeme také podle názvu
        if (args.type === 'movie' && searchKeywords.length > 0) {
            console.log('Filtering movies by title');
            const beforeTitleFilter = filteredResults.length;
            
            filteredResults = filteredResults.filter(result => {
                const nameLower = result.name.toLowerCase();
                const nameNormalized = normalizeChars(nameLower);
                const nameUpper = result.name.toUpperCase();
                
                // PRO FILMY: Odmítnout soubory které vypadají jako epizody seriálů
                // Hledáme patterny: S01E01, S1E1, 1x01, E01, - 01 -, [01], apod.
                const episodePatterns = [
                    /S\d+E\d+/i,           // S01E01, S1E1
                    /\d+X\d+/i,            // 1x01, 01x01
                    /\sE\d{2}/i,           // E01, E12
                    /\d+-\d{2}/,           // 1-01, 2-15
                    /\s-\s\d{2}\s/,        // " - 01 "
                    /\[\d{2}\]/,           // [01], [12]
                    /Episode\s*\d+/i,      // Episode 1
                    /EP\s*\d+/i,           // EP01, EP 1
                ];
                
                // Pokud soubor obsahuje episode pattern → pravděpodobně seriál → SKIP
                if (episodePatterns.some(p => p.test(nameUpper))) {
                    return false;
                }
                
                // Kontrola že obsahuje VŠECHNA slova z ALESPOŇ JEDNOHO názvu
                const hasTitle = searchKeywords.some(keyword => {
                    if (keyword.length < 2) return true;
                    
                    // Pro krátké keywords kontrolovat přímo
                    if (keyword.length <= 4) {
                        return nameLower.includes(keyword);
                    }
                    
                    // Odstranění "the " ze začátku
                    const cleanKeyword = keyword.replace(/^the\s+/i, '');
                    const words = cleanKeyword.split(/\s+/);
                    if (words.length === 0) return true;
                    
                    // SPECIÁLNÍ PŘÍPAD: Jednoslovný název (např. "Longlegs")
                    // Musí být samostatné slovo, ne část jiného (ne "Daddy-Longlegs")
                    if (words.length === 1) {
                        const word = words[0];
                        // Regex s word boundaries: \b před a za slovem
                        const wordBoundaryRegex = new RegExp(`\\b${word}\\b`, 'i');
                        return wordBoundaryRegex.test(nameLower);
                    }
                    
                    // Normalizace slov
                    const normalizedWords = words.map(w => normalizeChars(w));
                    
                    // Pro každé UNIKÁTNÍ slovo kontrolujeme, že se vyskytuje stejněkrát nebo víc
                    const wordCounts = {};
                    normalizedWords.forEach(word => {
                        wordCounts[word] = (wordCounts[word] || 0) + 1;
                    });
                    
                    // Kontrola že název obsahuje každé slovo alespoň tolikrát jako v query
                    for (const [word, requiredCount] of Object.entries(wordCounts)) {
                        const regex = new RegExp(word, 'gi');
                        const matches = nameNormalized.match(regex);
                        const actualCount = matches ? matches.length : 0;
                        
                        if (actualCount < requiredCount) {
                            return false; // Slovo se nevyskytuje dost krát
                        }
                    }
                    
                    return true; // Všechna slova se vyskytují správněkrát
                });
                
                return hasTitle;
            });
            
            console.log(`After title filter: ${filteredResults.length} results (was ${beforeTitleFilter})`);
        }
        
        if (args.type === 'series') {
            const parts = args.id.split(':');
            let targetSeason, targetEpisode;
            
            // Kitsu formát: kitsu:ID:episode (3 části, sezona vždy 1)
            // IMDb formát: tt:season:episode (3 části)
            if (parts[0].startsWith('kitsu')) {
                targetSeason = 1;
                targetEpisode = parseInt(parts[2]);
            } else {
                targetSeason = parseInt(parts[1]);
                targetEpisode = parseInt(parts[2]);
            }
            
            // Pouze filtrujeme, pokud máme číslo epizody
            if (targetSeason && targetEpisode) {
                console.log(`Filtering for season ${targetSeason}, episode ${targetEpisode}`);
                
                filteredResults = results.filter(result => {
                    const nameUpper = result.name.toUpperCase();
                    const nameLower = result.name.toLowerCase();
                    const nameNormalized = normalizeChars(nameLower);
                    
                    // PRVNÍ KONTROLA: Pokud soubor má SxxEyy formát, MUSÍ mít správné číslo epizody
                    const seasonEpisodeMatch = nameUpper.match(/S(\d+)E(\d+)/i);
                    if (seasonEpisodeMatch) {
                        const fileSeason = parseInt(seasonEpisodeMatch[1]);
                        const fileEpisode = parseInt(seasonEpisodeMatch[2]);
                        
                        // Pokud má SxxEyy formát, čísla MUSÍ sedět přesně
                        if (fileSeason !== targetSeason || fileEpisode !== targetEpisode) {
                            return false;  // Špatná sezóna nebo epizoda v SxxEyy formátu
                        }
                    }
                    
                    // 1) Přesné patterny s číslem sezóny a epizody
                    const exactPatterns = [
                        `S${String(targetSeason).padStart(2, '0')}E${String(targetEpisode).padStart(2, '0')}`,  // S05E03
                        `S${targetSeason}E${String(targetEpisode).padStart(2, '0')}`,  // S5E03
                        `S${String(targetSeason).padStart(2, '0')}E${targetEpisode}`,  // S05E3
                        `S${targetSeason}E${targetEpisode}`,  // S5E3
                        `${String(targetSeason).padStart(2, '0')}X${String(targetEpisode).padStart(2, '0')}`,  // 05x03
                        `${targetSeason}X${String(targetEpisode).padStart(2, '0')}`,  // 5x03
                        // Pattern Season-Episode: "1-01", "2-15" (musí mít pomlčku mezi)
                        `${targetSeason}-${String(targetEpisode).padStart(2, '0')}`,  // 1-01, 2-15
                    ];
                    
                    // Pokud název obsahuje přesný pattern, akceptujeme
                    const hasExactPattern = exactPatterns.some(p => nameUpper.includes(p));
                    if (hasExactPattern) {
                        // 2) Kontrola názvu
                        const hasTitle = searchKeywords.some(keyword => {
                            if (keyword.length < 2) return true;
                            
                            // Odstranění "the " ze začátku pro lepší matching
                            const cleanKeyword = keyword.replace(/^the\s+/i, '');
                            const words = cleanKeyword.split(/\s+/);
                            if (words.length === 0) return true;
                            
                            // Normalizace slov z keywords pro porovnání bez diakritiky
                            const normalizedWords = words.map(w => normalizeChars(w));
                            const matchedWords = normalizedWords.filter(word => nameNormalized.includes(word)).length;
                            
                            // Pro běžné seriály: vyžadujeme VŠECHNA slova (100%)
                            const minWords = words.length; // 100% - všechna slova
                            
                            // Debug pro první 3 soubory
                            if (filteredResults.indexOf(result) < 3) {
                                console.log(`  File: ${result.name.substring(0, 50)}`);
                                console.log(`  Keyword: "${keyword}" -> "${cleanKeyword}", Words: ${normalizedWords}, Matched: ${matchedWords}/${minWords}`);
                            }
                            
                            return matchedWords >= minWords;
                        });
                        return hasTitle;
                    }
                    
                    // 3) Episode-only patterny (E03, EP03, -03-) - POUZE pokud název NEOBSAHUJE jinou sezónu
                    const episodeOnlyPatterns = [
                        new RegExp(`E${String(targetEpisode).padStart(2, '0')}[^0-9]`, 'i'),
                        new RegExp(`E${String(targetEpisode).padStart(2, '0')}$`, 'i'),
                        // Jen číslo s oddělovačem před I po: " 03 ", "-03-", ".03.", "_03_", "[03]", "(03)"
                        // Ale NE pokud má S nebo E bezprostředně před/za (aby S01E10 nematchovalo "01")
                        new RegExp(`[\\s\\-_\\.\\[\\(]${String(targetEpisode).padStart(2, '0')}[\\s\\-_\\.\\]\\)]`, 'i'),
                        new RegExp(`[\\s\\-_\\.\\[\\(]${String(targetEpisode).padStart(2, '0')}$`, 'i'),
                        // Na začátku souboru: "08 -", "08.", "08_"
                        new RegExp(`^${String(targetEpisode).padStart(2, '0')}[\\s\\-_\\.]`, 'i'),
                        // Pattern - 09. (pomlčka mezera číslo tečka)
                        new RegExp(`-\\s${String(targetEpisode).padStart(2, '0')}\\.`, 'i'),
                        // Dvouciferná čísla bez nuly: " 15 ", "-15-", " 15." (pro epizody 10+)
                        ...(targetEpisode >= 10 ? [
                            new RegExp(`[\\s\\-_\\.\\[\\(]${targetEpisode}[\\s\\-_\\.\\]\\)]`, 'i'),
                            new RegExp(`[\\s\\-_\\.\\[\\(]${targetEpisode}$`, 'i'),
                            new RegExp(`^${targetEpisode}[\\s\\-_\\.]`, 'i'),
                            new RegExp(`-\\s${targetEpisode}\\.`, 'i'),
                        ] : []),
                        // Jednociferná čísla pro 1-9: " 3 ", "-3-", "[3]", ".3."
                        // KRITICKÉ: Musí mít (?!\d) aby " 1 " nematchovalo " 10 "
                        ...(targetEpisode < 10 ? [
                            new RegExp(`[\\s\\-_\\.\\[\\(]${targetEpisode}(?!\\d)[\\s\\-_\\.\\]\\)]`, 'i'),
                            new RegExp(`[\\s\\-_\\.\\[\\(]${targetEpisode}(?!\\d)$`, 'i'),
                            new RegExp(`-\\s${targetEpisode}(?!\\d)\\.`, 'i'),
                        ] : [])
                    ];
                    
                    const hasEpisodePattern = episodeOnlyPatterns.some(p => p.test(nameUpper));
                    if (hasEpisodePattern) {
                        // EXTRA KONTROLA: Pokud číslo epizody je v SxxE formátu, musí být SPRÁVNÁ epizoda
                        // např. pro E01 nesmí matchovat "S01E10" (kde "01" je součást sezóny)
                        const seasonEpisodePattern = /S\d+E(\d+)/i;
                        const seMatch = nameUpper.match(seasonEpisodePattern);
                        if (seMatch) {
                            const fileEpisode = parseInt(seMatch[1]);
                            if (fileEpisode !== targetEpisode) {
                                return false;  // Má SxxE formát ale špatnou epizodu
                            }
                        }
                        
                        // KRITICKÁ KONTROLA: Ujistíme se, že v názvu NENÍ jiné číslo sezóny
                        // Hledáme: S1, S2, S01, S02, "2nd Season", "Season 2", "Part 2"
                        let fileSeason = null;
                        
                        // Pattern 1: S1, S2, S01, S02...
                        const sMatch = nameUpper.match(/S(\d+)/i);
                        if (sMatch) {
                            fileSeason = parseInt(sMatch[1]);
                        }
                        
                        // Pattern 2: "2nd Season", "3rd Season", "Season 2"
                        const seasonMatch = nameUpper.match(/(\d+)(?:ST|ND|RD|TH)?\s+SEASON/i) || 
                                          nameUpper.match(/SEASON\s+(\d+)/i);
                        if (seasonMatch) {
                            fileSeason = parseInt(seasonMatch[1]);
                        }
                        
                        // Pattern 3: "Part 2", "P2", "Pt 2" (musí být word boundary před P)
                        const partMatch = nameUpper.match(/\b(?:PART|PT)\.?\s*(\d+)/i);
                        if (partMatch && !fileSeason) { // Jen pokud jsme nenašli Season
                            fileSeason = parseInt(partMatch[1]);
                        }
                        
                        // Pattern 4: Samostatné " 2 " v názvu (např. "Ansatsu Kyoushitsu 2 - 01")
                        // Musí být: mezera+číslo+mezera nebo mezera+číslo+pomlčka
                        // Ignorujeme čísla >10 (mohlo by být rok nebo epizoda)
                        if (!fileSeason) {
                            const standaloneMatch = nameUpper.match(/\s(\d{1})[\s\-]/);
                            if (standaloneMatch) {
                                const num = parseInt(standaloneMatch[1]);
                                // Jen pokud je to 2-9 (ne 1, protože 1 je default)
                                if (num >= 2 && num <= 9) {
                                    fileSeason = num;
                                }
                            }
                        }
                        
                        // Pattern 5: Římské číslice (II, III, IV, V) - např. "Strike the Blood III"
                        // Musí mít mezeru nebo pomlčku před římskou číslicí
                        if (!fileSeason) {
                            const romanMatch = nameUpper.match(/[\s\-](II|III|IV|V|VI|VII|VIII|IX|X)[\s\-]/);
                            if (romanMatch) {
                                const romanToArabic = {
                                    'II': 2, 'III': 3, 'IV': 4, 'V': 5,
                                    'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10
                                };
                                fileSeason = romanToArabic[romanMatch[1]];
                            }
                        }
                        
                        if (fileSeason && fileSeason !== targetSeason) {
                            // Debug - ukázat proč bylo odmítnuto
                            if (filteredResults.indexOf(result) < 5) {
                                console.log(`  REJECTED wrong season: ${result.name.substring(0, 60)} (has S${fileSeason}, need S${targetSeason})`);
                            }
                            return false;  // Má špatnou sezónu, odmítneme
                        } else if (!fileSeason) {
                            // Soubor NEMÁ číslo sezóny (jen E01, - 01, atd.)
                            // Akceptujeme JEN pokud hledáme sezónu 1!
                            if (targetSeason !== 1) {
                                if (filteredResults.indexOf(result) < 5) {
                                    console.log(`  REJECTED no season number: ${result.name.substring(0, 60)} (need S${targetSeason}, file has no S)`);
                                }
                                return false;
                            }
                        }
                        
                        // Kontrola názvu - vyžadujeme VŠECHNA slova (100%)
                        const hasTitle = searchKeywords.some(keyword => {
                            if (keyword.length < 2) return true;
                            
                            // Pro krátké keywords (≤4 znaky) - akronymy jako "fmp"
                            // Musí být samostatné slovo, ne část jiného slova
                            if (keyword.length <= 4) {
                                const wordBoundaryRegex = new RegExp(`\\b${keyword}\\b`, 'i');
                                return wordBoundaryRegex.test(nameLower);
                            }
                            
                            const words = keyword.split(/\s+/).filter(w => w.length > 3);
                            
                            // Pokud keyword nemá žádná slova delší než 3 znaky (např. "gto - the", "gto")
                            // NEPOVOLUJEME auto-pass - musí matchovat celý keyword
                            if (words.length === 0) {
                                // Celý keyword musí být přítomen jako substring (bez pomlček)
                                const cleanKeyword = keyword.replace(/[\s\-]+/g, '').toLowerCase();
                                const cleanName = nameLower.replace(/[\s\-]+/g, '');
                                return cleanName.includes(cleanKeyword);
                            }
                            
                            // SPECIÁLNÍ: Pro jednoslovné keywords (např. "Another")
                            // vyžadujeme že slovo je blízko začátku NEBO těsně před číslem epizody
                            if (words.length === 1) {
                                const word = words[0];
                                
                                // Pattern 1: Slovo na začátku (do 5 znaků od začátku)
                                const startPattern = new RegExp(`^.{0,5}${word}`, 'i');
                                if (startPattern.test(nameLower)) {
                                    return true;
                                }
                                
                                // Pattern 2: Slovo těsně před S01E01, E01, - 01, apod.
                                const beforeEpisodePattern = new RegExp(`${word}[\\s\\-\\.]*(s\\d+e\\d+|e\\d+|\\-\\s*\\d{2}|\\s\\d{2}\\s)`, 'i');
                                if (beforeEpisodePattern.test(nameLower)) {
                                    return true;
                                }
                                
                                return false;  // Jednoslovný keyword nenalezen správně
                            }
                            
                            const matchedWords = words.filter(word => nameLower.includes(word)).length;
                            
                            // Vyžadujeme VŠECHNA slova (100%)
                            return matchedWords === words.length;
                        });
                        return hasTitle;
                    }
                    
                    return false;
                });
                
                console.log(`Filtered to ${filteredResults.length} results matching episode`);
                
                // Debug - vypíšeme první 5 souborů
                if (filteredResults.length > 0) {
                    console.log('First matched files:');
                    filteredResults.slice(0, 5).forEach((f, i) => {
                        console.log(`  ${i+1}. ${f.name}`);
                    });
                }
                
                // Pokud nic nenajdeme s názvem, zkusíme jen sezon+epizodu s kontrolou alespoň nejdelšího slova
                if (filteredResults.length === 0) {
                    console.log('No matches with title filter, trying season+episode with partial name match');
                    
                    let debugCount = 0;
                    filteredResults = results.filter(result => {
                        const nameUpper = result.name.toUpperCase();
                        const nameLower = result.name.toLowerCase();
                        const nameNormalized = normalizeChars(nameLower);
                        
                        // Přesné patterny se sezónou
                        const exactPatterns = [
                            `S${String(targetSeason).padStart(2, '0')}E${String(targetEpisode).padStart(2, '0')}`,
                            `S${targetSeason}E${String(targetEpisode).padStart(2, '0')}`,
                            `S${String(targetSeason).padStart(2, '0')}E${targetEpisode}`,
                            `S${targetSeason}E${targetEpisode}`,
                        ];
                        
                        const hasExactPattern = exactPatterns.some(p => nameUpper.includes(p));
                        if (!hasExactPattern) {
                            // Episode-only patterns - POUZE pokud NEMÁ jinou sezónu
                            const episodeOnlyPatterns = [
                                new RegExp(`E${String(targetEpisode).padStart(2, '0')}[^0-9]`, 'i'),
                                new RegExp(`E${String(targetEpisode).padStart(2, '0')}$`, 'i'),
                                new RegExp(`[\\s\\-_\\.\\[\\(]${String(targetEpisode).padStart(2, '0')}[\\s\\-_\\.\\]\\)]`, 'i'),
                                new RegExp(`^${String(targetEpisode).padStart(2, '0')}[\\s\\-_\\.]`, 'i'),
                                // Pattern - 09. (pomlčka mezera číslo tečka)
                                new RegExp(`-\\s${String(targetEpisode).padStart(2, '0')}\\.`, 'i'),
                                // Dvouciferná čísla bez nuly: " 15 ", "-15-" (pro epizody 10+)
                                ...(targetEpisode >= 10 ? [
                                    new RegExp(`[\\s\\-_\\.\\[\\(]${targetEpisode}[\\s\\-_\\.\\]\\)]`, 'i'),
                                    new RegExp(`^${targetEpisode}[\\s\\-_\\.]`, 'i'),
                                    new RegExp(`-\\s${targetEpisode}\\.`, 'i'),
                                ] : []),
                                // Jednociferná čísla pro 1-9
                                // KRITICKÉ: (?!\d) aby " 1 " nematchovalo " 10 "
                                ...(targetEpisode < 10 ? [
                                    new RegExp(`[\\s\\-_\\.\\[\\(]${targetEpisode}(?!\\d)[\\s\\-_\\.\\]\\)]`, 'i'),
                                    new RegExp(`-\\s${targetEpisode}(?!\\d)\\.`, 'i'),
                                ] : []),
                            ];
                            
                            const hasEpisodePattern = episodeOnlyPatterns.some(p => p.test(nameUpper));
                            if (!hasEpisodePattern) {
                                if (debugCount < 5 && nameNormalized.includes('svet')) {
                                    console.log(`  DEBUG: ${result.name.substring(0, 60)} - no episode pattern`);
                                    debugCount++;
                                }
                                return false;
                            }
                            
                            // KRITICKÁ KONTROLA: Kontrola že NEMÁ špatnou sezónu
                            // Hledáme: S1, S2, "2nd Season", "Season 2", "Part 2"
                            let fileSeason = null;
                            
                            const sMatch = nameUpper.match(/S(\d+)/i);
                            if (sMatch) fileSeason = parseInt(sMatch[1]);
                            
                            const seasonMatch = nameUpper.match(/(\d+)(?:ST|ND|RD|TH)?\s+SEASON/i) || 
                                              nameUpper.match(/SEASON\s+(\d+)/i);
                            if (seasonMatch) fileSeason = parseInt(seasonMatch[1]);
                            
                            const partMatch = nameUpper.match(/\b(?:PART|PT)\.?\s*(\d+)/i);
                            if (partMatch && !fileSeason) fileSeason = parseInt(partMatch[1]);
                            
                            // Římské číslice (II, III, IV, V)
                            if (!fileSeason) {
                                const romanMatch = nameUpper.match(/[\s\-](II|III|IV|V|VI|VII|VIII|IX|X)[\s\-]/);
                                if (romanMatch) {
                                    const romanToArabic = {
                                        'II': 2, 'III': 3, 'IV': 4, 'V': 5,
                                        'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10
                                    };
                                    fileSeason = romanToArabic[romanMatch[1]];
                                }
                            }
                            
                            if (fileSeason && fileSeason !== targetSeason) {
                                if (debugCount < 5) {
                                    console.log(`  DEBUG: ${result.name.substring(0, 60)} - wrong season S${fileSeason} (need S${targetSeason})`);
                                    debugCount++;
                                }
                                return false;
                            } else if (!fileSeason && targetSeason !== 1) {
                                if (debugCount < 5) {
                                    console.log(`  DEBUG: ${result.name.substring(0, 60)} - no season (need S${targetSeason})`);
                                    debugCount++;
                                }
                                return false;
                            }
                        }
                        
                        // Kontrola názvu - musí obsahovat VŠECHNA slova z názvu
                        const hasAllWords = searchKeywords.some(keyword => {
                            if (keyword.length < 2) return false;
                            
                            // Odstranění "the " ze začátku
                            const cleanKeyword = keyword.replace(/^the\s+/i, '');
                            const words = cleanKeyword.split(/\s+/);
                            if (words.length === 0) return false;
                            
                            // Normalizujeme všechna slova a kontrolujeme každé
                            const normalizedWords = words.map(w => normalizeChars(w));
                            const matchedWords = normalizedWords.filter(word => nameNormalized.includes(word)).length;
                            
                            if (debugCount < 5 && nameNormalized.includes('svet')) {
                                console.log(`  DEBUG: ${result.name.substring(0, 60)}`);
                                console.log(`    Keywords: "${cleanKeyword}", Words: [${normalizedWords.join(', ')}], Matched: ${matchedWords}/${words.length}`);
                                debugCount++;
                            }
                            
                            // Vyžadujeme VŠECHNA slova (100%)
                            return matchedWords === words.length;
                        });
                        
                        return hasAllWords;
                    });
                    console.log(`Relaxed filter found ${filteredResults.length} results`);
                    
                    // Debug - vypíšeme první 5 souborů
                    if (filteredResults.length > 0) {
                        console.log('Relaxed filter matched files:');
                        filteredResults.slice(0, 5).forEach((f, i) => {
                            console.log(`  ${i+1}. ${f.name}`);
                        });
                    }
                }
            } else {
                // Nemáme číslo epizody - filtrujeme jen podle názvu
                console.log('No episode number - filtering by title only');
                
                filteredResults = results.filter(result => {
                    const nameLower = result.name.toLowerCase();
                    const nameNormalized = normalizeChars(nameLower);
                    
                    // Kontrola že obsahuje VŠECHNA slova z názvu
                    const hasTitle = searchKeywords.some(keyword => {
                        if (keyword.length < 2) return true;
                        
                        // Pro krátké keywords kontrolovat přímo
                        if (keyword.length <= 4) {
                            return nameLower.includes(keyword);
                        }
                        
                        // Odstranění "the " ze začátku
                        const cleanKeyword = keyword.replace(/^the\s+/i, '');
                        const words = cleanKeyword.split(/\s+/);
                        if (words.length === 0) return true;
                        
                        // Normalizace slov
                        const normalizedWords = words.map(w => normalizeChars(w));
                        const matchedWords = normalizedWords.filter(word => nameNormalized.includes(word)).length;
                        
                        // Vyžadujeme VŠECHNA slova (100%)
                        return matchedWords === words.length;
                    });
                    
                    return hasTitle;
                });
                
                console.log(`Filtered by title to ${filteredResults.length} results`);
            }
        }

        // Řazení podle priority
        filteredResults.sort((a, b) => {
            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();
            const aUpper = a.name.toUpperCase();
            const bUpper = b.name.toUpperCase();
            
            // Detekce kvality
            const getQualityScore = (name) => {
                const upper = name.toUpperCase();
                if (upper.includes('2160') || upper.includes('4K')) return 4;
                if (upper.includes('1080')) return 3;
                if (upper.includes('720')) return 2;
                if (upper.includes('480')) return 1;
                return 0;
            };
            
            // Detekce jazyka (CZ/SK)
            const hasLanguage = (name) => {
                const upper = name.toUpperCase();
                return upper.includes('CZ') || upper.includes('CZECH') || 
                       upper.includes('SK') || upper.includes('SLOVAK');
            };
            
            // SPECIÁLNÍ: Pro seriály s konkrétní epizodou - exact match pattern má nejvyšší prioritu
            if (args.type === 'series' && args.id.includes(':')) {
                const parts = args.id.split(':');
                let season, episode;
                
                if (parts[0].startsWith('kitsu')) {
                    season = 1;
                    episode = parseInt(parts[2]);
                } else {
                    season = parseInt(parts[1]);
                    episode = parseInt(parts[2]);
                }
                
                if (season && episode) {
                    // Pattern 1: S01E01 (full format)
                    const exactPattern = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                    const aHasExact = aUpper.includes(exactPattern);
                    const bHasExact = bUpper.includes(exactPattern);
                    
                    if (aHasExact && !bHasExact) return -1;
                    if (!aHasExact && bHasExact) return 1;
                    
                    // Pattern 2: E01 (episode only - pro anime)
                    const episodePattern = `E${String(episode).padStart(2, '0')}`;
                    const aHasEpisode = aUpper.includes(episodePattern);
                    const bHasEpisode = bUpper.includes(episodePattern);
                    
                    // Soubory s E01 mají prioritu nad soubory bez něj
                    if (aHasEpisode && !bHasEpisode) return -1;
                    if (!aHasEpisode && bHasEpisode) return 1;
                }
            }
            
            // 1. RELEVANCE - kolik slov z názvu se shoduje (NEJDŮLEŽITĚJŠÍ!)
            const aScore = searchKeywords.reduce((score, keyword) => {
                const words = keyword.split(/\s+/).filter(w => w.length >= 3);
                const matches = words.filter(word => aName.includes(word)).length;
                return score + matches;
            }, 0);
            
            const bScore = searchKeywords.reduce((score, keyword) => {
                const words = keyword.split(/\s+/).filter(w => w.length >= 3);
                const matches = words.filter(word => bName.includes(word)).length;
                return score + matches;
            }, 0);
            
            if (aScore !== bScore) return bScore - aScore;
            
            // 2. JAZYK (CZ/SK má přednost)
            const aLang = hasLanguage(a.name);
            const bLang = hasLanguage(b.name);
            if (aLang && !bLang) return -1;
            if (!aLang && bLang) return 1;
            
            // 3. KVALITA (4K > 1080P > 720P > 480P)
            const aQuality = getQualityScore(a.name);
            const bQuality = getQualityScore(b.name);
            if (aQuality !== bQuality) return bQuality - aQuality;
            
            // 4. ČÍSLO EPIZODY (E01, E02...)
            const aMatch = a.name.match(/[SE](\d+)/i);
            const bMatch = b.name.match(/[SE](\d+)/i);
            if (aMatch && bMatch) {
                const aNum = parseInt(aMatch[1]);
                const bNum = parseInt(bMatch[1]);
                if (aNum !== bNum) return aNum - bNum;
            }
            
            // 5. VELIKOST (větší = lepší)
            return parseInt(b.size) - parseInt(a.size);
        });

        if (filteredResults.length === 0) {
            return { streams: [] };
        }

        // Vytvoříme streamy pro každý výsledek
        // Pokud nemáme číslo epizody, vrátíme víc výsledků (50) aby uživatel viděl všechny epizody
        const hasEpisodeNumber = args.id.split(':').length >= 3;
        const maxStreams = hasEpisodeNumber ? 30 : 50;
        
        const filesToProcess = filteredResults.slice(0, maxStreams);
        console.log(`Processing ${filesToProcess.length} files for links...`);
        
        const streams = [];
        
        // Zpracujeme soubory najednou (ne po dávkách - rychlejší)
        const streamPromises = filesToProcess.map(async (file) => {
            try {
                const link = await getFileLink(file.ident, token);
                if (link) {
                    const quality = detectQuality(file.name);
                    
                    // Sestavíme metadata
                    const sizeStr = formatSize(file.size);
                    const qualityStr = quality.resolution || 'SD';
                    
                    // Detekce jazyka/titulků z názvu
                    const nameUpper = file.name.toUpperCase();
                    const languages = [];
                    if (nameUpper.includes('CZ') || nameUpper.includes('CZECH')) languages.push('🇨🇿 CZ');
                    if (nameUpper.includes('SK') || nameUpper.includes('SLOVAK')) languages.push('🇸🇰 SK');
                    if (nameUpper.includes('EN') || nameUpper.includes('ENGLISH')) languages.push('🇬🇧 EN');
                    if (nameUpper.includes('MULTI') || nameUpper.includes('DUAL')) languages.push('🌍 MULTI');
                    
                    // Detekce typu zvuku
                    const audioTypes = [];
                    if (nameUpper.includes('DABING') || nameUpper.includes('DUBBED')) audioTypes.push('DABING');
                    if (nameUpper.includes('TITULKY') || nameUpper.includes('SUBS') || nameUpper.includes('SUB')) audioTypes.push('TITULKY');
                    
                    // Sestavíme název streamu s co nejvíce informací
                    let streamName = 'Webshare';
                    
                    // Jazyk a audio typ
                    if (languages.length > 0) {
                        streamName += ` ${languages.join('+')}`;
                        if (audioTypes.length > 0) streamName += ` ${audioTypes[0]}`;
                    }
                    
                    // Rozlišení
                    streamName += ` 📺${qualityStr}`;
                    
                    // Codec
                    if (quality.codec) streamName += ` 🎬${quality.codec}`;
                    
                    // Audio formát
                    if (quality.audio) streamName += ` 🔊${quality.audio}`;
                    
                    // Source
                    if (quality.source) streamName += ` 📀${quality.source}`;
                    
                    // Velikost
                    streamName += ` 💾${sizeStr}`;
                    
                    // Rating
                    if (file.positive_votes > 0 || file.negative_votes > 0) {
                        const ratio = file.positive_votes / (file.positive_votes + file.negative_votes + 1);
                        if (ratio > 0.7) streamName += ` ⭐`;
                    }
                    
                    return {
                        name: streamName,
                        title: file.name,
                        url: link,
                        behaviorHints: {
                            bingeGroup: 'webshare-anime',
                            videoSize: file.size,
                            filename: file.name,
                            videoHash: file.ident,
                            // Přidáme všechna detekovaná metadata
                            notWebReady: false
                        },
                        // Přidáme i alternativní metadata pole (některé klienty je používají)
                        subtitles: audioTypes.includes('TITULKY') ? [{
                            lang: languages[0]?.split(' ')[1] || 'cz',
                            url: ''
                        }] : undefined
                    };
                } else {
                    console.log(`No link available for file: ${file.name}`);
                }
                return null;
            } catch (error) {
                console.error(`Error getting link for ${file.name}:`, error.message);
                return null;
            }
        });
        
        const allStreams = await Promise.all(streamPromises);
        const validStreams = allStreams.filter(s => s !== null);
        
        // Přidat všechny manuální linky NA ZAČÁTEK pokud existují
        if (manualLinkStreams.length > 0) {
            validStreams.unshift(...manualLinkStreams);
            console.log(`${manualLinkStreams.length} manual link streams added to beginning`);
        }
        
        console.log(`Returning ${validStreams.length} streams to Stremio`);
        
        // Vracíme pole streamů - i když je prázdné
        const response = { 
            streams: validStreams.length > 0 ? validStreams : []
        };
        
        console.log('=== RESPONSE READY ===');
        console.log('Response object:', JSON.stringify(response, null, 2).substring(0, 500));
        
        // Zalogovat TT/IMDB/KITSU vyhledávání (NE webshare- přímé vyhledávání)
        if (!args.id.startsWith('webshare-') && validStreams.length > 0 && username && searchQueries.length > 0) {
            const mainQuery = searchQueries[0];
            const idParts = args.id.split(':');
            const imdbId = idParts[0]; // tt1234567 nebo kitsu
            const type = args.type; // movie nebo series
            
            // Debounce: logovat jen první request pro dané imdbId od uživatele (10s okno)
            const debounceKey = `${username}:${imdbId}`;
            const now = Date.now();
            const lastLog = searchLogDebounce.get(debounceKey);
            
            if (!lastLog || (now - lastLog) > SEARCH_LOG_DEBOUNCE_MS) {
                searchLogDebounce.set(debounceKey, now);
                // Sestavit display name z originálního TMDB/Kitsu názvu
                let displayName = null;
                if (_tmdbNames && _tmdbNames.length > 0) {
                    if (args.id.startsWith('kitsu:')) {
                        // Kitsu: EN název z Kitsu API
                        displayName = _tmdbNames[0];
                    } else if (_isJapaneseContent && _tmdbNames.length > 1) {
                        // TMDB anime: EN název = poslední
                        displayName = _tmdbNames[_tmdbNames.length - 1];
                    } else {
                        // Ostatní: CZ název s diakritikou = první
                        displayName = _tmdbNames[0];
                    }
                    // Přidat epizodu pokud je seriál
                    if (args.type === 'series') {
                        if (args.id.startsWith('kitsu:')) {
                            // Kitsu formát: kitsu:ID:episode → S01Exx
                            const kitsuParts = args.id.split(':');
                            const ep = kitsuParts[2];
                            if (ep) {
                                displayName += ' S01E' + String(ep).padStart(2, '0');
                            }
                        } else if (args.id.includes(':')) {
                            // IMDB formát: tt1234567:season:episode
                            const ep = args.id.split(':');
                            if (ep[1] && ep[2]) {
                                displayName += ' S' + String(ep[1]).padStart(2, '0') + 'E' + String(ep[2]).padStart(2, '0');
                            }
                        }
                    }
                }
                logSearch(username, `${idParts[0]}: ${mainQuery}`, validStreams.length, imdbId, type, displayName, _kitsuPoster).catch(err => {
                    console.error('R2 logging failed:', err.message);
                });
            } else {
                console.log(`⏭️ Skipping log for "${imdbId}" (debounce, ${now - lastLog}ms since last)`);
            }
            
            // Vyčistit staré záznamy z debounce cache (každých 100 requestů)
            if (searchLogDebounce.size > 100) {
                for (const [key, ts] of searchLogDebounce) {
                    if (now - ts > 60000) searchLogDebounce.delete(key);
                }
            }
        }
        
        return response;
    } catch (error) {
        console.error('=== STREAM HANDLER ERROR ===');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        console.error('Args:', JSON.stringify(args));
        
        // Vracíme prázdné pole i při erroru
        return { streams: [] };
    }
}

// Registrujeme handler do builderu
builder.defineStreamHandler(handleStreamRequest);

// Catalog handler funkce - použita builderem i personal routes
async function handleCatalogRequest(args) {
    try {
        console.log('=== CATALOG REQUEST ===');
        console.log('Type:', args.type);
        console.log('ID:', args.id);
        console.log('Extra:', JSON.stringify(args.extra));
        console.log('Config present:', !!args.config);
        
        // Pouze pro search katalog
        if (args.id !== 'webshare_search') {
            console.log('Not webshare_search catalog, returning empty');
            return { metas: [] };
        }
        
        // Kontrola jestli má uživatel povolené přímé vyhledávání
        if (args.config?.enable_direct_search === false) {
            console.log('Direct search is disabled in user config');
            return { metas: [] };
        }
        
        if (!args.extra || !args.extra.search) {
            console.log('No search query in extra, returning empty');
            return { metas: [] };
        }
        
        const searchQuery = args.extra.search;
        const { username, password } = args.config || {};
        
        if (!username || !password) {
            console.log('Missing credentials in catalog request');
            return { metas: [] };
        }
        
        console.log('Direct search query:', searchQuery);
        
        // Přihlásit se
        const saltedPassword = await saltPassword(username, password);
        const token = await login(username, saltedPassword);
        
        // Vyhledat na Webshare
        const results = await search(searchQuery, token);
        
        if (results.length === 0) {
            console.log('No results found');
            return { metas: [] };
        }
        
        console.log(`Found ${results.length} files for search: ${searchQuery}`);
        
        // Backdrop URL - náš vlastní obrázek
        const backdropUrl = 'https://raw.githubusercontent.com/david325345/webshare-stremio/main/public/webshare-backdrop.jpg';
        
        // Vytvořit metas - každý soubor jako samostatný meta
        const metas = results.slice(0, 50).map((file, index) => {
            // Generovat unikátní ID pro každý soubor - použít - místo :
            const metaId = `webshare-${file.ident}`;
            
            return {
                id: metaId,
                type: args.type,
                name: file.name,
                poster: file.img || backdropUrl,  // Webshare thumbnail nebo fallback
                background: backdropUrl,  // Náš backdrop
                description: `Webshare: ${formatBytes(parseInt(file.size))}`,
                releaseInfo: file.name,
                links: []  // Důležité - prázdné links znamená že addon poskytne streamy
            };
        });
        
        console.log(`Returning ${metas.length} metas`);
        return { metas };
        
    } catch (error) {
        console.error('=== CATALOG ERROR ===');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        return { metas: [] };
    }
}

// Catalog handler pro přímé vyhledávání
builder.defineCatalogHandler(handleCatalogRequest);

// Meta handler funkce pro webshare: ID
async function handleMetaRequest(args) {
    try {
        console.log('=== META REQUEST ===');
        console.log('Type:', args.type);
        console.log('ID:', args.id);
        
        // Pouze pro webshare- ID
        if (!args.id.startsWith('webshare-')) {
            return { meta: {} };
        }
        
        const fileIdent = args.id.substring(9); // Remove "webshare-" prefix
        const { username, password } = args.config || {};
        
        if (!username || !password) {
            console.log('Missing credentials in meta request');
            return { meta: {} };
        }
        
        console.log('Getting file info for:', fileIdent);
        
        // Přihlásit se
        const saltedPassword = await saltPassword(username, password);
        const token = await login(username, saltedPassword);
        
        // Získat info o souboru
        const fileInfo = await getFileInfo(fileIdent, token);
        
        if (!fileInfo) {
            console.log('File info not found');
            return { meta: {} };
        }
        
        // Backdrop URL
        const backdropUrl = 'https://raw.githubusercontent.com/david325345/webshare-stremio/main/public/webshare-backdrop.jpg';
        
        console.log('Returning meta for:', fileInfo.name);
        
        // Detekce kvality a dalších info z názvu
        const qualityInfo = detectQuality(fileInfo.name);
        
        // Sestavit detailní description s celým názvem a metadaty
        let description = `📄 ${fileInfo.name}\n\n`;
        
        // Přidat kvalitu/rozlišení pokud je detekováno
        if (qualityInfo.resolution) {
            description += `📺 Rozlišení: ${qualityInfo.resolution}\n`;
        }
        if (qualityInfo.codec) {
            description += `🎬 Kodek: ${qualityInfo.codec}\n`;
        }
        if (qualityInfo.audio) {
            description += `🔊 Audio: ${qualityInfo.audio}\n`;
        }
        if (qualityInfo.source) {
            description += `📀 Zdroj: ${qualityInfo.source}\n`;
        }
        
        // Základní info
        description += `💾 Velikost: ${formatBytes(fileInfo.size)}\n`;
        description += `👍 ${fileInfo.positive_votes} 👎 ${fileInfo.negative_votes}\n`;
        
        // Pokud má Webshare popis, přidat ho
        if (fileInfo.description && fileInfo.description.trim()) {
            description += `\n📝 ${fileInfo.description}`;
        }
        
        return {
            meta: {
                id: args.id,
                type: args.type,
                name: fileInfo.name,
                poster: fileInfo.img || backdropUrl,
                background: fileInfo.img || backdropUrl,
                description: description,
                website: `https://webshare.cz/#/file/${fileIdent}`
            }
        };
        
    } catch (error) {
        console.error('=== META ERROR ===');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        return { meta: {} };
    }
}

// Meta handler pro webshare: ID
builder.defineMetaHandler(handleMetaRequest);


// ========== KEEP-ALIVE CRON JOB ==========
const cron = require('node-cron');

// Server se probouzí hned při startu
const wakeUpDate = new Date().toDateString();
console.log(`🚀 Server started on ${wakeUpDate} - pings will run until midnight`);

// Ping každých 10 minut (jen do půlnoci dne probuzení)
cron.schedule('*/10 * * * *', async () => {
    const now = new Date();
    const currentDate = now.toDateString();
    
    // Pokud je půlnoc nebo další den, přestaneme pingovat
    if (currentDate !== wakeUpDate) {
        console.log('🌙 Midnight passed - server will sleep');
        return;
    }
    
    try {
        const url = process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000';
        console.log(`⏰ Keep-alive ping: ${now.toLocaleTimeString()}`);
        await needle('get', `${url}/manifest.json`, { timeout: 5000 });
    } catch (error) {
        console.error('❌ Keep-alive ping failed:', error.message);
    }
});

console.log('✅ Keep-alive scheduler initialized');

// ========== EXPRESS SERVER ==========
const app = express();

// Body parser middleware - MUSÍ BÝT PŘED routes!
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware
app.use((req, res, next) => {
    // Log pouze API requesty, ne statické soubory
    if (!req.url.endsWith('.svg') && !req.url.endsWith('.png') && !req.url.endsWith('.jpg')) {
        console.log(`📥 ${req.method} ${req.url}`);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Static files (logo)
app.use(express.static(path.join(__dirname, 'public')));

// Proxy endpoint pro custom linky — přeposílá stream z Webshare bez session (nezapisuje se do historie)
app.get('/proxy/:token/:ident', async (req, res) => {
    try {
        const { token, ident } = req.params;
        
        // Získat dočasný link z Webshare
        const link = await getFileLink(ident, decodeURIComponent(token));
        if (!link) {
            console.log(`🔀 Proxy: no link for ${ident}`);
            return res.status(404).send('File not available');
        }
        
        console.log(`🔀 Proxy: streaming ${ident}`);
        
        // Forwardovat Range header od Stremia
        const proxyHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };
        if (req.headers.range) {
            proxyHeaders['Range'] = req.headers.range;
            console.log(`🔀 Proxy: Range ${req.headers.range}`);
        }
        
        // Čistý GET na Webshare link — bez cookies, bez session (jako prohlížeč)
        const https = require('https');
        const http = require('http');
        const urlModule = require('url');
        const parsed = urlModule.parse(link);
        const client = parsed.protocol === 'https:' ? https : http;
        
        const proxyReq = client.get({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.path,
            headers: proxyHeaders
        }, (proxyRes) => {
            console.log(`🔀 Proxy: response ${proxyRes.statusCode}, content-length: ${proxyRes.headers['content-length'] || 'unknown'}`);
            
            // Přeposlat status a hlavičky
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
                ...(proxyRes.headers['content-length'] && { 'Content-Length': proxyRes.headers['content-length'] }),
                ...(proxyRes.headers['content-range'] && { 'Content-Range': proxyRes.headers['content-range'] }),
                'Accept-Ranges': 'bytes'
            });
            
            // Pipe data přímo
            proxyRes.pipe(res);
        });
        
        proxyReq.on('error', (err) => {
            console.error(`🔀 Proxy request error for ${ident}:`, err.message);
            if (!res.headersSent) res.status(500).send('Stream error');
        });
        
        res.on('close', () => {
            proxyReq.destroy();
        });
    } catch (error) {
        console.error(`🔀 Proxy error:`, error.message);
        if (!res.headersSent) res.status(500).send('Proxy error');
    }
});

// Root route - installation page
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Webshare Anime Addon</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { 
            font-family: Arial, sans-serif; 
            max-width: 600px; 
            margin: 50px auto; 
            padding: 20px;
            background: #1a1a2e;
            color: #eee;
        }
        h1 { color: #00d9ff; }
        h2 { color: #9d4edd; margin-top: 30px; }
        .form-group {
            margin: 15px 0;
        }
        label {
            display: block;
            margin-bottom: 5px;
            color: #00d9ff;
        }
        input {
            width: 100%;
            padding: 10px;
            background: #16213e;
            border: 1px solid #00d9ff;
            border-radius: 5px;
            color: #eee;
            font-size: 14px;
            box-sizing: border-box;
        }
        input:focus {
            outline: none;
            border-color: #9d4edd;
        }
        .install-btn {
            display: inline-block;
            background: #7b2cbf;
            color: white;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 5px;
            margin: 20px 0;
            font-size: 18px;
            border: none;
            cursor: pointer;
            width: 100%;
        }
        .install-btn:hover { background: #9d4edd; }
        .install-btn:disabled {
            background: #555;
            cursor: not-allowed;
        }
        code { 
            background: #16213e; 
            padding: 2px 6px; 
            border-radius: 3px;
            color: #00d9ff;
        }
        .note {
            background: #16213e;
            padding: 10px;
            border-left: 3px solid #00d9ff;
            margin: 15px 0;
            font-size: 14px;
        }
        ul { line-height: 1.8; }
    </style>
</head>
<body>
    <h1>🎌 Webshare Anime Addon</h1>
    <p>Stremio addon pro anime a seriály z Webshare.cz</p>
    
    <h2>📥 Vytvoření osobního addonu</h2>
    <div class="note">
        Vyplňte své údaje a vygenerujte si osobní instalační link s vašimi credentials.
    </div>
    
    <form id="installForm">
        <div class="form-group">
            <label for="username">Webshare username *</label>
            <input type="text" id="username" name="username" placeholder="vase-jmeno" required>
        </div>
        
        <div class="form-group">
            <label for="password">Webshare password *</label>
            <input type="password" id="password" name="password" placeholder="••••••••" required>
        </div>
        
        <div class="form-group">
            <label for="tmdb">TMDB API Key (volitelné)</label>
            <input type="text" id="tmdb" name="tmdb" placeholder="Získejte zdarma na themoviedb.org">
        </div>
        
        <div class="form-group">
            <label style="display: flex; align-items: center; cursor: pointer;">
                <input type="checkbox" id="enable_direct_search" name="enable_direct_search" checked style="width: auto; margin-right: 10px;">
                <span>Enable Direct Search (Webshare Hledat catalog)</span>
            </label>
        </div>
        
        <div class="form-group">
            <label style="display: flex; align-items: center; cursor: pointer;">
                <input type="checkbox" id="enable_my_links" name="enable_my_links" checked style="width: auto; margin-right: 10px;">
                <span>Enable My Links (manual link management)</span>
            </label>
        </div>
        
        <button type="submit" class="install-btn">
            🔗 Vygenerovat instalační link
        </button>
    </form>
    
    <div id="myLinksSection" style="display: none; margin-top: 20px; text-align: center;">
        <a id="myLinksLink" href="/mylinks" style="display: inline-block; padding: 12px 24px; background: #9d4edd; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
            🔗 My Links - Správa historie vyhledávání
        </a>
        <p style="color: #999; font-size: 14px; margin-top: 10px;">
            Spravujte manuální linky pro vyhledávání (max 10 posledních hledání)
        </p>
    </div>
    
    <div id="installLinkContainer" style="display: none; margin-top: 20px;">
        <div class="note">
            <strong>✅ Váš osobní addon je připraven!</strong>
            <div style="margin-top: 10px; word-break: break-all; background: #0d1b2a; padding: 10px; border-radius: 5px; font-family: monospace; font-size: 11px;">
                <span id="installLinkDisplay"></span>
            </div>
            <div style="margin-top: 10px;">
                <button onclick="copyInstallLink()" style="padding: 10px 20px; background: #00d9ff; color: #1a1a2e; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; margin-right: 10px;">
                    📋 Zkopírovat
                </button>
                <button onclick="installNow()" style="padding: 10px 20px; background: #7b2cbf; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold;">
                    🚀 Nainstalovat
                </button>
            </div>
        </div>
        <div class="note" style="margin-top: 10px; background: #2d1b00; border-left-color: #ff9500;">
            <strong>⚠️ Bezpečnost:</strong> Tento link obsahuje vaše heslo. Nesdílejte ho s nikým!
        </div>
    </div>
    
    <h2>✨ Funkce</h2>
    <ul>
        <li>🎯 Automatická detekce anime přes AniList</li>
        <li>🌐 TMDB české názvy</li>
        <li>📺 Podpora seriálů i filmů</li>
        <li>🇨🇿 CZ/SK priorita</li>
        <li>🎬 Smart filtrování podle roku a epizod</li>
        <li>🔍 Přímé vyhledávání na Webshare</li>
        <li>📱 Optimalizace pro Stremio a Omni (Apple TV)</li>
    </ul>
    
    <div class="note">
        <strong>💡 Tip:</strong> TMDB API klíč získáte zdarma na 
        <a href="https://www.themoviedb.org/settings/api" target="_blank" style="color: #00d9ff;">themoviedb.org</a>
    </div>
    
    <p style="margin-top: 40px; color: #999; font-size: 12px;">
        Version ${manifest.version} | 
        <a href="/manifest.json" style="color: #00d9ff;">manifest.json</a>
    </p>
    
    <script>
        // Auto-fill z localStorage pokud existuje
        let autoGenerate = false;
        try {
            const saved = localStorage.getItem('webshare_config');
            if (saved) {
                const config = JSON.parse(saved);
                if (config.username) {
                    document.getElementById('username').value = config.username;
                    autoGenerate = true;
                }
                if (config.password) {
                    document.getElementById('password').value = config.password;
                }
                if (config.tmdb_api_key) document.getElementById('tmdb').value = config.tmdb_api_key;
                if (config.enable_direct_search !== undefined) {
                    document.getElementById('enable_direct_search').checked = config.enable_direct_search;
                }
                if (config.enable_my_links !== undefined) {
                    document.getElementById('enable_my_links').checked = config.enable_my_links;
                }
                
                // Auto-generate install link po načtení stránky
                if (autoGenerate) {
                    setTimeout(() => {
                        document.getElementById('installForm').dispatchEvent(new Event('submit'));
                    }, 100);
                }
            }
        } catch (e) {
            console.error('Failed to load saved config:', e);
        }
        
        const form = document.getElementById('installForm');
        let currentInstallUrl = '';
        
        function installNow() {
            window.location.href = currentInstallUrl;
        }
        
        function copyInstallLink() {
            navigator.clipboard.writeText(currentInstallUrl).then(() => {
                alert('✅ Link zkopírován do schránky!');
            }).catch(() => {
                // Fallback pro starší prohlížeče
                const textArea = document.createElement('textarea');
                textArea.value = currentInstallUrl;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
                alert('✅ Link zkopírován do schránky!');
            });
        }
        
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value.trim();
            const tmdb = document.getElementById('tmdb').value.trim();
            const enableDirectSearch = document.getElementById('enable_direct_search').checked;
            const enableMyLinks = document.getElementById('enable_my_links').checked;
            
            if (!username || !password) {
                alert('⚠️ Username a password jsou povinné!');
                return;
            }
            
            // Vytvoříme config objekt
            const config = {
                username: username,
                password: password,
                tmdb_api_key: tmdb || '',
                enable_direct_search: enableDirectSearch,
                enable_my_links: enableMyLinks
            };
            
            // Uložit do localStorage pro příště
            try {
                localStorage.setItem('webshare_config', JSON.stringify(config));
            } catch (e) {
                console.error('Failed to save config:', e);
            }
            
            // Base64 encode config pro personal URL
            const configB64 = btoa(JSON.stringify(config));
            
            // Vytvoříme PERSONAL Stremio install URL s credentials v path
            const installUrl = \`stremio://\${window.location.host}/\${configB64}/manifest.json\`;
            currentInstallUrl = installUrl;
            
            // Zobrazíme link
            document.getElementById('installLinkDisplay').textContent = installUrl;
            document.getElementById('installLinkContainer').style.display = 'block';
            
            // Zobrazit My Links tlačítko pokud je My Links povoleno
            const myLinksSection = document.getElementById('myLinksSection');
            if (enableMyLinks && myLinksSection) {
                myLinksSection.style.display = 'block';
                // Nastavit URL s configem
                const myLinksLink = document.getElementById('myLinksLink');
                if (myLinksLink) {
                    myLinksLink.href = \`/mylinks?config=\${configB64}\`;
                }
            }
            
            // Scrollujeme k linku
            document.getElementById('installLinkContainer').scrollIntoView({ behavior: 'smooth' });
            
            // NE-přesměrováváme automaticky, uživatel si může vybrat
        });
    </script>
</body>
</html>
    `);
});

// Personal manifest route - každý uživatel má vlastní URL s embedded credentials
app.get('/:userConfig/manifest.json', (req, res) => {
    try {
        const configB64 = req.params.userConfig;
        
        // Dekódujeme config z base64
        const configJson = Buffer.from(configB64, 'base64').toString('utf8');
        const config = JSON.parse(configJson);
        
        console.log(`📦 Personal manifest request for user: ${config.username}`);
        console.log(`   Search catalog enabled: ${config.enable_search !== false}`);
        
        // Vytvoříme personal manifest BEZ config fields a BEZ katalogu
        const personalManifest = {
            ...manifest,
            id: `${manifest.id}.${configB64.substring(0, 8)}`,
            name: 'Webshare+Anime',
            config: undefined,
            behaviorHints: {
                ...manifest.behaviorHints,
                configurable: false,
                configurationRequired: false
            }
        };
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json(personalManifest);
    } catch (error) {
        console.error('Personal manifest error:', error.message);
        res.status(400).json({ error: 'Invalid config URL' });
    }
});

// Personal stream handler - používá config z URL path
app.get('/:userConfig/stream/:type/:id.json', async (req, res) => {
    try {
        const configB64 = req.params.userConfig;
        
        // Dekódujeme config
        const configJson = Buffer.from(configB64, 'base64').toString('utf8');
        const config = JSON.parse(configJson);
        
        // Vytvoříme args pro stream handler
        const args = {
            type: req.params.type,
            id: req.params.id,
            extra: {},
            config: config
        };
        
        console.log('=== PERSONAL STREAM REQUEST ===');
        console.log('User:', config.username);
        console.log('Type:', args.type);
        console.log('ID:', args.id);
        
        // Zavoláme stream handler přímo
        const result = await handleStreamRequest(args, req);
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json(result);
    } catch (error) {
        console.error('Personal stream error:', error.message);
        res.status(500).json({ streams: [] });
    }
});

// Personal catalog handler - používá config z URL path
// Používá regex pro zachycení všeho včetně .json
app.get(/^\/([^\/]+)\/catalog\/([^\/]+)\/([^\/]+)\/(.+)$/, async (req, res) => {
    try {
        const configB64 = req.params[0];
        const type = req.params[1];
        const id = req.params[2];
        const extraPath = req.params[3];
        
        // Dekódujeme config
        const configJson = Buffer.from(configB64, 'base64').toString('utf8');
        const config = JSON.parse(configJson);
        
        // Odstranit .json na konci
        const extraString = extraPath.replace(/\.json$/, '');
        
        // Parse extra params (např. search=frieren)
        const extra = {};
        if (extraString) {
            const pairs = extraString.split('&');
            pairs.forEach(pair => {
                const [key, value] = pair.split('=');
                if (key && value) {
                    extra[key] = decodeURIComponent(value);
                }
            });
        }
        
        // Vytvoříme args pro catalog handler
        const args = {
            type: type,
            id: id,
            extra: extra,
            config: config
        };
        
        console.log('=== PERSONAL CATALOG REQUEST ===');
        console.log('User:', config.username);
        console.log('Type:', args.type);
        console.log('ID:', args.id);
        console.log('Extra:', extra);
        
        // Zavoláme catalog handler přímo
        const result = await handleCatalogRequest(args);
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json(result);
    } catch (error) {
        console.error('Personal catalog error:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ metas: [] });
    }
});

// Personal meta handler - používá config z URL path
app.get('/:userConfig/meta/:type/:id.json', async (req, res) => {
    try {
        const configB64 = req.params.userConfig;
        
        // Dekódujeme config
        const configJson = Buffer.from(configB64, 'base64').toString('utf8');
        const config = JSON.parse(configJson);
        
        // Vytvoříme args pro meta handler
        const args = {
            type: req.params.type,
            id: req.params.id,
            config: config
        };
        
        console.log('=== PERSONAL META REQUEST ===');
        console.log('User:', config.username);
        console.log('Type:', args.type);
        console.log('ID:', args.id);
        
        // Zavoláme meta handler přímo
        const result = await handleMetaRequest(args);
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.json(result);
    } catch (error) {
        console.error('Personal meta error:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ meta: {} });
    }
});

// Stremio addon routes - DISABLED pro personal URL system
// Personal routes (:userConfig/*) zajišťují všechnu funkcionalitu
// const addonRouter = getRouter(builder.getInterface());
// app.use(addonRouter);

// ========== MY LINKS - Web rozhraní pro správu manuálních linků ==========
app.get('/mylinks', async (req, res) => {
    // Získat config z URL nebo username/password (pro zpětnou kompatibilitu)
    let username = req.query.username || '';
    let password = '';
    let tmdbApiKey = '';
    
    if (req.query.config) {
        try {
            const configJson = Buffer.from(req.query.config, 'base64').toString('utf8');
            const config = JSON.parse(configJson);
            username = config.username || '';
            password = config.password || '';
            tmdbApiKey = config.tmdb_api_key || '';
            console.log('My Links - parsed username:', username);
            console.log('My Links - TMDB API key:', tmdbApiKey ? 'present' : 'missing');
        } catch (error) {
            console.error('Failed to parse config:', error.message);
        }
    }
    
    console.log('My Links - rendering for username:', username);
    
    const isAdminUser = await isAdmin(username);
    const loginDisplay = username ? 'none' : 'block';
    const historyClass = username ? '' : 'hidden';
    const loadingStyle = username ? '' : 'display: none;';
    
    // Build admin panel HTML - always present but hidden if not admin (can be shown after login)
    const adminPanelHTML = `
    <div id="adminPanel" style="display: ${isAdminUser ? 'block' : 'none'}; background: #2d1b00; border: 2px solid #ff9500; border-radius: 10px; padding: 20px; margin: 20px 0;">
        <h2 style="color: #ff9500; margin-top: 0;">&#x1F451; Admin Panel</h2>
        <div style="display: flex; gap: 10px; margin-top: 15px; flex-wrap: wrap; align-items: stretch;">
            <button onclick="downloadBackup()" style="flex: 1; min-width: 150px; padding: 12px; background: #00d9ff; color: #1a1a2e; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 14px; margin: 0;">
                &#x1F4BE; Stáhnout zálohu
            </button>
            <label style="flex: 1; min-width: 150px; padding: 12px; background: #7b2cbf; color: white; border-radius: 5px; cursor: pointer; font-weight: bold; text-align: center; display: flex; align-items: center; justify-content: center; font-size: 14px; margin: 0; box-sizing: border-box;">
                &#x1F4E4; Nahrát zálohu
                <input type="file" id="restoreFile" accept=".json" style="display: none;" onchange="restoreBackup(this)">
            </label>
            <button onclick="showBrokenLinks()" style="flex: 1; min-width: 150px; padding: 12px; background: #ff4444; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 14px; margin: 0;">
                &#x26A0;&#xFE0F; Nefunkční linky
            </button>
            <button onclick="showAdminManager()" style="flex: 1; min-width: 150px; padding: 12px; background: #ff9500; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 14px; margin: 0;">
                &#x1F465; Správa adminů
            </button>
            <button onclick="showBanManager()" style="flex: 1; min-width: 150px; padding: 12px; background: #cc0000; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 14px; margin: 0;">
                &#x1F6AB; Správa banů
            </button>
        </div>
        <p id="adminMessage" style="margin-top: 10px; display: none;"></p>
        <div id="adminManagerPanel" style="display: none; margin-top: 20px; padding: 15px; background: #1a0d00; border: 2px solid #ff9500; border-radius: 8px;">
            <h3 style="color: #ff9500; margin-top: 0;">&#x1F465; Správa adminů</h3>
            <div id="adminsList" style="margin-bottom: 15px;"></div>
            <div style="display: flex; gap: 10px; margin-top: 15px;">
                <input type="text" id="newAdminUsername" placeholder="Uživatelské jméno" style="flex: 1; padding: 10px; background: #0d1b2a; color: white; border: 1px solid #ff9500; border-radius: 5px;">
                <button onclick="addNewAdmin()" style="padding: 10px 20px; background: #00d9ff; color: #1a1a2e; border: none; border-radius: 5px; cursor: pointer; font-weight: bold;">
                    &#x2795; Přidat admina
                </button>
            </div>
            <p id="adminManagerMessage" style="margin-top: 10px; display: none;"></p>
            <button onclick="hideAdminManager()" style="margin-top: 15px; padding: 8px 16px; background: #444; color: white; border: none; border-radius: 5px; cursor: pointer;">Zavřít</button>
        </div>
        <div id="banManagerPanel" style="display: none; margin-top: 20px; padding: 15px; background: #1a0000; border: 2px solid #cc0000; border-radius: 8px;">
            <h3 style="color: #cc0000; margin-top: 0;">&#x1F6AB; Správa banů</h3>
            <div id="bannedList" style="margin-bottom: 15px;"></div>
            <div style="display: flex; gap: 10px; margin-top: 15px;">
                <input type="text" id="banUsername" placeholder="Uživatelské jméno" style="flex: 1; padding: 10px; background: #0d1b2a; color: white; border: 1px solid #cc0000; border-radius: 5px;">
                <input type="text" id="banReason" placeholder="Důvod (nepovinné)" style="flex: 1; padding: 10px; background: #0d1b2a; color: white; border: 1px solid #cc0000; border-radius: 5px;">
                <button onclick="doBanUser()" style="padding: 10px 20px; background: #cc0000; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold;">
                    &#x1F6AB; Zabanovat
                </button>
            </div>
            <p id="banManagerMessage" style="margin-top: 10px; display: none;"></p>
            <button onclick="hideBanManager()" style="margin-top: 15px; padding: 8px 16px; background: #444; color: white; border: none; border-radius: 5px; cursor: pointer;">Zavřít</button>
        </div>
        <div id="brokenLinksPanel" style="display: none; margin-top: 20px; padding: 15px; background: #1a0d0d; border: 2px solid #ff4444; border-radius: 8px;">
            <h3 style="color: #ff4444; margin-top: 0;">&#x26A0;&#xFE0F; Nefunkční manuální linky</h3>
            <div id="brokenLinksList"></div>
            <button onclick="hideBrokenLinks()" style="margin-top: 10px; padding: 8px 16px; background: #444; color: white; border: none; border-radius: 5px; cursor: pointer;">Zavřít</button>
        </div>
    </div>`;

    const htmlPage = `<!DOCTYPE html>
<html>
<head>
    <title>My Links - Webshare Addon</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            max-width: 1300px;
            margin: 30px auto;
            padding: 20px;
            background: #1a1a2e;
            color: #eee;
        }
        h1 { color: #00d9ff; }
        h2 { color: #9d4edd; margin-top: 30px; }
        .page-layout {
            display: flex;
            gap: 20px;
            align-items: flex-start;
        }
        .main-col {
            flex: 1;
            min-width: 0;
        }
        .side-col {
            width: 340px;
            flex-shrink: 0;
            position: sticky;
            top: 20px;
            max-height: calc(100vh - 40px);
            overflow-y: auto;
        }
        @media (max-width: 900px) {
            .page-layout { flex-direction: column; }
            .side-col { width: 100%; position: static; max-height: none; }
        }
        .login-form {
            background: #16213e;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
        }
        .form-group { margin: 15px 0; }
        label {
            display: block;
            margin-bottom: 5px;
            color: #00d9ff;
        }
        input {
            width: 100%;
            padding: 10px;
            background: #0d1b2a;
            border: 1px solid #00d9ff;
            border-radius: 5px;
            color: #eee;
            font-size: 14px;
            box-sizing: border-box;
        }
        button {
            background: #7b2cbf;
            color: white;
            padding: 10px 20px;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 16px;
            margin-top: 10px;
        }
        button:hover { background: #9d4edd; }
        .search-item {
            background: #16213e;
            padding: 15px;
            margin: 10px 0;
            border-radius: 8px;
            border-left: 3px solid #00d9ff;
        }
        .search-query {
            font-size: 18px;
            font-weight: bold;
            color: #00d9ff;
            margin-bottom: 5px;
        }
        .search-stats {
            color: #999;
            font-size: 14px;
            margin: 5px 0;
        }
        .add-link-form {
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px solid #333;
        }
        .hidden { display: none; }
        .success { color: #00ff00; }
        .error { color: #ff0000; }
        .info { color: #00d9ff; }
    </style>
</head>
<body>
    <h1>&#x1F517; My Links - Správa manuálních linků</h1>

    <div id="loginSection" class="login-form" style="display: ${loginDisplay}">
        <h2>Přihlášení</h2>
        <p>Použijte své Webshare přihlašovací údaje:</p>
        <div class="form-group">
            <label>Username:</label>
            <input type="text" id="loginUsername" placeholder="vase-jmeno">
        </div>
        <div class="form-group">
            <label>Password:</label>
            <input type="password" id="loginPassword" placeholder="••••••••">
        </div>
        <button onclick="doLogin()">Přihlásit se</button>
        <p id="loginError" class="error hidden"></p>
    </div>

    ${adminPanelHTML}

    <div class="page-layout" style="display: ${username ? 'flex' : 'none'};" id="pageLayout">
        <div class="main-col">
            <div id="customLinkSection" style="background: #16213e; border: 2px solid #9d4edd; border-radius: 10px; padding: 20px; margin: 0 0 20px 0;">
        <h2 style="color: #9d4edd; margin-top: 0;">&#x2795; Přidat custom link</h2>
        <p style="color: #999; font-size: 14px; margin-bottom: 15px;">Vyhledej film nebo seriál, vyber ho a přidej Webshare link.</p>
        
        <div style="position: relative;">
            <div style="display: flex; gap: 10px;">
                <input type="text" id="titleSearch" placeholder="Hledat film nebo seriál..." style="flex: 1; padding: 12px; background: #0d1b2a; border: 1px solid #9d4edd; border-radius: 5px; color: #eee; font-size: 15px;">
                <button onclick="searchTitles()" style="padding: 12px 20px; background: #9d4edd; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 15px;">&#x1F50D; Hledat</button>
            </div>
            <div id="titleResults" style="display: none; margin-top: 10px; max-height: 350px; overflow-y: auto;"></div>
        </div>

        <div id="selectedTitle" style="display: none; margin-top: 15px; padding: 15px; background: #0d1b2a; border-radius: 8px; border-left: 4px solid #9d4edd;">
            <div style="display: flex; gap: 12px; align-items: start;">
                <img id="selectedPoster" src="" style="width: 50px; height: 75px; object-fit: cover; border-radius: 5px; flex-shrink: 0;">
                <div style="flex: 1;">
                    <div id="selectedName" style="color: #9d4edd; font-weight: bold; font-size: 16px;"></div>
                    <div id="selectedMeta" style="color: #999; font-size: 13px; margin-top: 3px;"></div>
                    <div id="selectedImdb" style="color: #00d9ff; font-size: 12px; margin-top: 3px; font-family: monospace;"></div>
                </div>
                <button onclick="clearSelection()" style="padding: 5px 10px; background: #444; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; flex-shrink: 0;">&#x2716; Zrušit</button>
            </div>

            <div id="episodeFields" style="display: none; margin-top: 12px; gap: 10px;">
                <div style="flex: 1;">
                    <label style="color: #9d4edd; font-size: 13px; margin-bottom: 4px; display: block;">Série (sezóna)</label>
                    <input type="number" id="customSeason" min="1" value="1" style="width: 100%; padding: 8px; background: #1a1a2e; border: 1px solid #9d4edd; border-radius: 4px; color: #eee; font-size: 14px;">
                </div>
                <div style="flex: 1;">
                    <label style="color: #9d4edd; font-size: 13px; margin-bottom: 4px; display: block;">Díl (epizoda)</label>
                    <input type="number" id="customEpisode" min="1" value="1" style="width: 100%; padding: 8px; background: #1a1a2e; border: 1px solid #9d4edd; border-radius: 4px; color: #eee; font-size: 14px;">
                </div>
            </div>

            <div style="margin-top: 12px;">
                <label style="color: #9d4edd; font-size: 13px; margin-bottom: 4px; display: block;">Popis linku (např. "Frieren EP1 CZ dabing 1080p")</label>
                <input type="text" id="customDisplayName" placeholder="Název souboru / popis" style="width: 100%; padding: 10px; background: #1a1a2e; border: 1px solid #9d4edd; border-radius: 4px; color: #eee; font-size: 14px; box-sizing: border-box;">
            </div>

            <div style="margin-top: 10px;">
                <label style="color: #9d4edd; font-size: 13px; margin-bottom: 4px; display: block;">Webshare link nebo ident</label>
                <input type="text" id="customWebshareLink" placeholder="https://webshare.cz/#/file/xxx nebo ident" style="width: 100%; padding: 10px; background: #1a1a2e; border: 1px solid #9d4edd; border-radius: 4px; color: #eee; font-size: 14px; box-sizing: border-box;">
            </div>

            <button onclick="submitCustomLink()" style="margin-top: 12px; width: 100%; padding: 12px; background: #9d4edd; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 15px;">&#x1F4BE; Uložit link</button>
            <p id="customMsg" style="margin-top: 8px; display: none;"></p>
        </div>
    </div>

    <div id="historySection" class="${historyClass}">
        <div id="loadingMsg" style="text-align: center; padding: 20px; ${loadingStyle}">
            <p style="color: #00d9ff; font-size: 18px;">&#x23F3; Načítám vaši historii vyhledávání...</p>
        </div>
        <h2 style="display: none;" id="histTitle">&#x1F4CA; Vaše historie vyhledávání</h2>
        <p style="display: none;" id="histDesc">Zde vidíte co jste hledali a můžete přidat manuální linky.</p>
        <div id="searchHistory"></div>
    </div>
        </div>

        <div class="side-col">
            <div style="background: #16213e; border: 2px solid #00d9ff; border-radius: 10px; padding: 15px;">
                <h3 style="color: #00d9ff; margin: 0 0 12px 0; font-size: 16px;">&#x1F4DD; Moje přidané linky <span id="myCustomLinksCount" style="color: #666; font-size: 13px; font-weight: normal;"></span></h3>
                <div id="myCustomLinks" style="color: #999; font-size: 13px;">Načítám...</div>
                <div id="myCustomLinksMore" style="display: none; text-align: center; margin-top: 10px;">
                    <button onclick="showMoreCustomLinks()" style="padding: 8px 16px; background: #00d9ff; color: #1a1a2e; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 13px; margin-top: 0;">Zobrazit dalších 10</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        var currentUser = ${JSON.stringify(username || '')};
        var currentPassword = ${JSON.stringify(password || '')};
        var currentIsAdmin = ${isAdminUser};
        var tmdbApiKey = ${JSON.stringify(tmdbApiKey || '')};

        // === REGEX pro čištění názvů (pre-compiled, bezpečné v template literal) ===
        var _diacriticsRe = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');
        var _slashRe = new RegExp(String.fromCharCode(47), 'g');
        var _specialCharsRe = new RegExp('[!?:*]', 'g');
        var _multiSpaceRe = new RegExp(String.fromCharCode(92) + 's+', 'g');

        // === CUSTOM LINK STATE ===
        var selectedImdbId = null;
        var selectedType = null;
        var selectedTitleName = null;
        var selectedEnName = null;
        var selectedIsJapanese = false;
        var selectedPosterUrl = null;
        var searchTimeout = null;
        var allMyCustomLinks = [];
        var customLinksShown = 0;
        var CUSTOM_LINKS_PAGE = 10;

        // Auto-load sidebar custom links
        if (currentUser) {
            setTimeout(function() { loadMyCustomLinks(); }, 200);
        }

        async function loadMyCustomLinks() {
            try {
                var response = await fetch('/api/mylinks/manual');
                var data = await response.json();
                var links = data.links || {};

                allMyCustomLinks = [];
                for (var query in links) {
                    if (Array.isArray(links[query])) {
                        links[query].forEach(function(link, idx) {
                            if (link.added_by === currentUser) {
                                allMyCustomLinks.push({
                                    query: query,
                                    idx: idx,
                                    display_name: link.display_name,
                                    added_at: link.added_at,
                                    status: link.status,
                                    poster: link.poster || null,
                                    webshare_ident: link.webshare_ident
                                });
                            }
                        });
                    }
                }

                // Seřadit podle data přidání (nejnovější první)
                allMyCustomLinks.sort(function(a, b) {
                    return new Date(b.added_at) - new Date(a.added_at);
                });

                customLinksShown = 0;
                renderMyCustomLinks(false);
            } catch (error) {
                document.getElementById('myCustomLinks').innerHTML = '<p style="color:#ff4444;">Chyba načítání</p>';
            }
        }

        function renderMyCustomLinks(append) {
            var container = document.getElementById('myCustomLinks');
            var moreBtn = document.getElementById('myCustomLinksMore');
            var countEl = document.getElementById('myCustomLinksCount');

            if (countEl) countEl.textContent = '(' + allMyCustomLinks.length + ')';

            if (allMyCustomLinks.length === 0) {
                container.innerHTML = '<p style="color:#666;text-align:center;padding:10px;">Zatím jsi nepřidal žádné linky.</p>';
                moreBtn.style.display = 'none';
                return;
            }

            var start = append ? customLinksShown : 0;
            var end = Math.min(start + CUSTOM_LINKS_PAGE, allMyCustomLinks.length);
            var html = append ? container.innerHTML : '';

            for (var i = start; i < end; i++) {
                var item = allMyCustomLinks[i];
                var isBroken = item.status === 'broken';
                var borderCol = isBroken ? '#ff4444' : '#0d1b2a';
                var statusIcon = isBroken ? '\\u26A0\\uFE0F ' : '';
                var date = new Date(item.added_at).toLocaleDateString('cs-CZ');

                // Extrahovat název titulu z query klíče
                var titleName = item.query;
                if (titleName.match(/^tt\\d+:\\s*/)) {
                    titleName = titleName.replace(/^tt\\d+:\\s*/, '');
                }
                if (titleName.match(/^kitsu:\\d+:\\s*/)) {
                    titleName = titleName.replace(/^kitsu:\\d+:\\s*/, '');
                }

                var eQ = encodeURIComponent(item.query).replace(/'/g, '%27');
                var delBtn = '<span onclick="deleteSidebarLink(decodeURIComponent(\\'' + eQ + '\\'), ' + item.idx + ')" style="color:#ff4444;cursor:pointer;font-size:11px;float:right;" title="Smazat">\\u2716</span>';

                html += '<div style="background:#0d1b2a;padding:8px 10px;margin-bottom:6px;border-radius:6px;border-left:3px solid ' + borderCol + ';position:relative;">' +
                    delBtn +
                    '<div style="color:#eee;font-size:13px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:20px;">' + statusIcon + (item.display_name || '') + '</div>' +
                    '<div style="color:#666;font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + titleName + '</div>' +
                    '<div style="color:#555;font-size:10px;margin-top:2px;">' + date + '</div>' +
                '</div>';
            }

            customLinksShown = end;
            container.innerHTML = html;

            if (customLinksShown < allMyCustomLinks.length) {
                moreBtn.style.display = 'block';
            } else {
                moreBtn.style.display = 'none';
            }
        }

        function showMoreCustomLinks() {
            renderMyCustomLinks(true);
        }

        async function deleteSidebarLink(query, linkIndex) {
            if (!confirm('Smazat tento link?')) return;
            try {
                var response = await fetch('/api/mylinks/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: currentUser, query: query, link_index: linkIndex })
                });
                var data = await response.json();
                if (data.success) {
                    loadMyCustomLinks();
                    if (currentUser) loadHistory(currentUser);
                }
            } catch (e) { /* ignore */ }
        }

        // Enter key handler pro title search
        (function() {
            var el = document.getElementById('titleSearch');
            if (el) { el.addEventListener('keydown', function(e) { if (e.key === 'Enter') searchTitles(); }); }
        })();

        async function searchTitles() {
            var input = document.getElementById('titleSearch');
            var query = input ? input.value.trim() : '';
            if (query.length < 2) return;

            var resultsDiv = document.getElementById('titleResults');
            resultsDiv.style.display = 'block';
            resultsDiv.innerHTML = '<p style="color:#9d4edd;text-align:center;padding:15px;">Hledám...</p>';

            try {
                var response = await fetch('/api/search-titles', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: query, tmdb_api_key: tmdbApiKey })
                });
                var data = await response.json();

                if (!data.results || data.results.length === 0) {
                    resultsDiv.innerHTML = '<p style="color:#999;text-align:center;padding:15px;">Nic nenalezeno. Zkus jiný název.</p>';
                    return;
                }

                resultsDiv.innerHTML = data.results.map(function(item, idx) {
                    var posterSrc = item.poster || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="60" fill="%23444"><rect width="40" height="60"/><text x="12" y="35" fill="%23999" font-size="14">?</text></svg>');
                    var typeLabel = item.type === 'movie' ? '\\uD83C\\uDFAC Film' : '\\uD83D\\uDCFA Seriál';
                    if (item.is_japanese) typeLabel = '\\uD83C\\uDDEF\\uD83C\\uDDF5 Anime';
                    var subName = item.en_name ? ' <span style="color:#888;">(' + item.en_name + ')</span>' : (item.original_name ? ' <span style="color:#666;">(' + item.original_name + ')</span>' : '');
                    return '<div onclick="selectTitle(' + idx + ')" style="display:flex;gap:10px;align-items:center;padding:10px;margin:4px 0;background:#0d1b2a;border-radius:6px;cursor:pointer;border:1px solid transparent;transition:border-color 0.2s;" onmouseover="this.style.borderColor=\\'#9d4edd\\'" onmouseout="this.style.borderColor=\\'transparent\\'">' +
                        '<img src="' + posterSrc + '" style="width:40px;height:60px;object-fit:cover;border-radius:4px;flex-shrink:0;" onerror="this.style.display=\\'none\\'">' +
                        '<div style="flex:1;min-width:0;">' +
                            '<div style="color:#eee;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + item.name + subName + '</div>' +
                            '<div style="color:#999;font-size:12px;">' + typeLabel + ' &bull; ' + (item.year || '?') + ' &bull; <span style="color:#00d9ff;">' + item.imdb_id + '</span></div>' +
                        '</div>' +
                    '</div>';
                }).join('');

                // Uložit výsledky globálně pro selectTitle
                window._searchResults = data.results;

            } catch (error) {
                resultsDiv.innerHTML = '<p style="color:#ff4444;text-align:center;padding:15px;">Chyba: ' + error.message + '</p>';
            }
        }

        function selectTitle(idx) {
            var item = window._searchResults[idx];
            if (!item) return;

            selectedImdbId = item.imdb_id;
            selectedType = item.type;
            selectedTitleName = item.name;
            selectedEnName = item.en_name || null;
            selectedIsJapanese = item.is_japanese || false;
            selectedPosterUrl = item.poster;

            // Vyplnit selected panel
            var posterEl = document.getElementById('selectedPoster');
            if (item.poster) { posterEl.src = item.poster; posterEl.style.display = 'block'; }
            else { posterEl.style.display = 'none'; }

            var nameText = item.name;
            if (item.en_name) nameText += ' / ' + item.en_name;
            document.getElementById('selectedName').textContent = nameText;
            var typeLabel = item.type === 'movie' ? 'Film' : 'Seriál';
            var jpLabel = item.is_japanese ? ' \\u2022 \\uD83C\\uDDEF\\uD83C\\uDDF5 Anime' : '';
            document.getElementById('selectedMeta').textContent = typeLabel + ' \\u2022 ' + (item.year || '?') + jpLabel;
            document.getElementById('selectedImdb').textContent = item.imdb_id;

            // Zobrazit/skrýt epizodu pole
            var episodeFields = document.getElementById('episodeFields');
            if (item.type === 'series') {
                episodeFields.style.display = 'flex';
            } else {
                episodeFields.style.display = 'none';
            }

            // Zobrazit selected panel, skrýt výsledky
            document.getElementById('selectedTitle').style.display = 'block';
            document.getElementById('titleResults').style.display = 'none';

            // Auto-focus na display name
            document.getElementById('customDisplayName').focus();
        }

        function clearSelection() {
            selectedImdbId = null;
            selectedType = null;
            selectedTitleName = null;
            selectedEnName = null;
            selectedIsJapanese = false;
            selectedPosterUrl = null;
            document.getElementById('selectedTitle').style.display = 'none';
            document.getElementById('titleResults').style.display = 'none';
            document.getElementById('customDisplayName').value = '';
            document.getElementById('customWebshareLink').value = '';
            document.getElementById('customSeason').value = '1';
            document.getElementById('customEpisode').value = '1';
            var msgEl = document.getElementById('customMsg');
            if (msgEl) msgEl.style.display = 'none';
        }

        function showCustomMsg(msg, type) {
            var el = document.getElementById('customMsg');
            if (el) {
                el.textContent = msg;
                el.style.display = 'block';
                el.style.color = type === 'success' ? '#00ff00' : type === 'error' ? '#ff4444' : '#00d9ff';
            }
        }

        async function submitCustomLink() {
            if (!selectedImdbId || !selectedTitleName) {
                showCustomMsg('Nejprve vyber film nebo seriál!', 'error');
                return;
            }

            var displayName = document.getElementById('customDisplayName').value.trim();
            var webshareLink = document.getElementById('customWebshareLink').value.trim();

            if (!displayName) { showCustomMsg('Zadej popis linku!', 'error'); return; }
            if (!webshareLink) { showCustomMsg('Zadej Webshare link nebo ident!', 'error'); return; }

            // Vybrat správný název - pro anime (japonský obsah) používá addon anglický název
            var rawName = selectedTitleName;
            if (selectedIsJapanese && selectedEnName) {
                rawName = selectedEnName;
            }

            // Vyčistit název STEJNĚ jako addon:
            // 1. Normalizace diakritiky (NFD + remove combining marks)
            // 2. Lomítka na mezery
            // 3. Odstranit !?:*
            var cleanName = rawName.normalize('NFD').replace(_diacriticsRe, '').replace(_slashRe, ' ').replace(_specialCharsRe, '').replace(_multiSpaceRe, ' ').trim();

            // Sestavit query klíč ve formátu, který addon používá
            var queryKey;
            if (selectedType === 'series') {
                var season = parseInt(document.getElementById('customSeason').value) || 1;
                var episode = parseInt(document.getElementById('customEpisode').value) || 1;
                var seasonEp = 'S' + String(season).padStart(2, '0') + 'E' + String(episode).padStart(2, '0');
                queryKey = selectedImdbId + ': ' + cleanName + ' ' + seasonEp;
            } else {
                queryKey = selectedImdbId + ': ' + cleanName;
            }

            showCustomMsg('Kontroluji a ukládám link...', 'info');

            try {
                // Sestavit title_name pro display v historii (originální název s diakritikou)
                var titleForHistory = rawName;
                if (selectedType === 'series') {
                    titleForHistory += ' S' + String(season).padStart(2, '0') + 'E' + String(episode).padStart(2, '0');
                }

                var response = await fetch('/api/mylinks/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: currentUser,
                        password: currentPassword,
                        query: queryKey,
                        link: webshareLink,
                        display_name: displayName,
                        poster: selectedPosterUrl,
                        title_name: titleForHistory
                    })
                });
                var data = await response.json();

                if (data.success) {
                    showCustomMsg('Link uložen! Zobrazí se v addonu i v historii.', 'success');
                    document.getElementById('customWebshareLink').value = '';
                    document.getElementById('customDisplayName').value = '';
                    // Refresh historii po 2s
                    setTimeout(function() {
                        if (currentUser) loadHistory(currentUser);
                        loadMyCustomLinks();
                    }, 2000);
                } else {
                    showCustomMsg(data.error || 'Chyba při ukládání', 'error');
                }
            } catch (error) {
                showCustomMsg('Chyba: ' + error.message, 'error');
            }
        }

        // Auto-load historie pokud máme username z configu
        if (currentUser) {
            setTimeout(function() { loadHistory(currentUser); }, 100);
        }

        async function loadHistory(username) {
            try {
                var response = await fetch('/api/mylinks/history', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username })
                });
                var data = await response.json();

                if (data.error) {
                    document.getElementById('historySection').classList.remove('hidden');
                    hideLoading();
                    document.getElementById('searchHistory').innerHTML = '<p>Chyba načítání historie.</p>';
                } else if (data.searches && Object.keys(data.searches).length > 0) {
                    showHistory(data.searches);
                } else {
                    document.getElementById('historySection').classList.remove('hidden');
                    hideLoading();
                    document.getElementById('searchHistory').innerHTML = '<p>Zatím jste nic nehledali přes addon.</p>';
                }
            } catch (error) {
                document.getElementById('historySection').classList.remove('hidden');
                hideLoading();
                document.getElementById('searchHistory').innerHTML = '<p>Chyba připojení k serveru.</p>';
            }
        }

        function hideLoading() {
            var el = document.getElementById('loadingMsg');
            if (el) el.style.display = 'none';
        }

        function setCookie(name, value, days) {
            var expires = new Date();
            expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
            document.cookie = name + '=' + encodeURIComponent(value) + ';expires=' + expires.toUTCString() + ';path=/';
        }

        function getCookie(name) {
            var nameEQ = name + '=';
            var ca = document.cookie.split(';');
            for (var i = 0; i < ca.length; i++) {
                var c = ca[i].trim();
                if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length));
            }
            return null;
        }

        // Auto-fill ze cookies
        window.addEventListener('load', function() {
            var savedUser = getCookie('ws_username');
            var savedPass = getCookie('ws_password');
            if (savedUser && document.getElementById('loginUsername')) {
                document.getElementById('loginUsername').value = savedUser;
            }
            if (savedPass && document.getElementById('loginPassword')) {
                document.getElementById('loginPassword').value = savedPass;
            }
            if (savedUser && savedPass && !currentUser) {
                setTimeout(function() {
                    if (confirm('Máte uložené přihlašovací údaje. Přihlásit automaticky?')) {
                        doLogin();
                    }
                }, 500);
            }
        });

        async function doLogin() {
            var usernameEl = document.getElementById('loginUsername');
            var passwordEl = document.getElementById('loginPassword');
            var username = usernameEl ? usernameEl.value.trim() : '';
            var password = passwordEl ? passwordEl.value.trim() : '';

            if (!username || !password) {
                showLoginError('Vyplňte username a password!');
                return;
            }

            try {
                var response = await fetch('/api/mylinks/history', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username, password: password })
                });
                var data = await response.json();

                if (data.error) {
                    showLoginError(data.error);
                    return;
                }

                setCookie('ws_username', username, 30);
                setCookie('ws_password', password, 30);

                currentUser = username;
                currentPassword = password;
                var layout = document.getElementById('pageLayout');
                if (layout) layout.style.display = 'flex';
                showHistory(data.searches);
                loadMyCustomLinks();

                // Zkontrolovat admin status
                try {
                    var adminResp = await fetch('/api/mylinks/check-admin', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: username })
                    });
                    var adminData = await adminResp.json();
                    if (adminData.isAdmin) {
                        currentIsAdmin = true;
                        var panel = document.getElementById('adminPanel');
                        if (panel) panel.style.display = 'block';
                    }
                } catch (e) { /* ignore */ }
            } catch (error) {
                showLoginError('Chyba připojení: ' + error.message);
            }
        }

        function showLoginError(msg) {
            var el = document.getElementById('loginError');
            if (el) { el.textContent = msg; el.classList.remove('hidden'); }
        }

        function showHistory(searches) {
            hideLoading();
            document.getElementById('loginSection').style.display = 'none';
            document.getElementById('historySection').classList.remove('hidden');

            var title = document.getElementById('histTitle');
            var desc = document.getElementById('histDesc');
            if (title) title.style.display = 'block';
            if (desc) desc.style.display = 'block';

            var historyDiv = document.getElementById('searchHistory');

            if (!searches || Object.keys(searches).length === 0) {
                historyDiv.innerHTML = '<p>Zatím jste nic nehledali přes addon.</p>';
                return;
            }

            fetch('/api/mylinks/manual')
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    renderHistory(searches, data.links || {});
                })
                .catch(function() {
                    renderHistory(searches, {});
                });
        }

        function renderHistory(searches, manualLinks) {
            var historyDiv = document.getElementById('searchHistory');

            var sorted = Object.entries(searches)
                .sort(function(a, b) { return new Date(b[1].last_search) - new Date(a[1].last_search); })
                .slice(0, 10);

            historyDiv.innerHTML = sorted.map(function(entry) {
                var query = entry[0];
                var stats = entry[1];
                var manualLinksArray = manualLinks[query] || [];
                var hasManualLinks = Array.isArray(manualLinksArray) && manualLinksArray.length > 0;

                var title = query;
                var posterUrl = stats.poster || 'https://via.placeholder.com/60x90/667eea/ffffff?text=?';

                // Použít display_name (originální název s diakritikou/romaji) pokud existuje
                if (stats.display_name) {
                    title = stats.display_name;
                } else if (query.match(/tt\\d+/)) {
                    title = query.replace(/^tt\\d+:\\s*/, '');
                }
                if (!stats.display_name && query.includes('kitsu:')) {
                    title = query.replace(/^kitsu:\\d+:\\s*/, '');
                }

                var manualLinksHtml = '';
                if (hasManualLinks) {
                    manualLinksHtml = manualLinksArray.map(function(manual, idx) {
                        var isBroken = manual.status === 'broken';
                        var isOwner = currentUser === manual.added_by;
                        if (isBroken && !isOwner && !currentIsAdmin) return '';

                        var bgColor = isBroken ? '#2d1b1b' : '#0d1b2a';
                        var borderSt = isBroken ? '2px solid #ff4444' : 'none';
                        var textCol = isBroken ? '#ff4444' : '#00d9ff';
                        var linkType = isBroken ? '\\u26A0\\uFE0F NEFUNKČNÍ LINK' : '\\uD83D\\uDCCC Manuální link';
                        var dateInfo = new Date(manual.added_at).toLocaleDateString('cs-CZ');
                        var brokenInfo = isBroken ? ' &bull; <span style="color:#ff4444;">Nefunguje od: ' + new Date(manual.last_checked).toLocaleDateString('cs-CZ') + '</span>' : '';

                        var eQuery = encodeURIComponent(query).replace(/'/g, '%27');
                        var delBtn = (isOwner || currentIsAdmin) ?
                            '<button onclick="deleteLink(decodeURIComponent(\\'' + eQuery + '\\'), ' + idx + ', \\'' + eQuery + '\\')" style="position:absolute;top:10px;right:10px;padding:5px 10px;background:#ff4444;color:white;border:none;border-radius:3px;cursor:pointer;font-size:12px;">\\uD83D\\uDDD1\\uFE0F Smazat</button>' : '';

                        return '<div style="background:' + bgColor + ';padding:10px;margin-top:10px;border-radius:5px;position:relative;border:' + borderSt + ';">' +
                            '<strong style="color:' + textCol + ';">' + linkType + ':</strong> ' + (manual.display_name || '') + '<br>' +
                            '<small style="color:#999;">Přidal: ' + (manual.added_by || '') + ' &bull; ' + dateInfo + brokenInfo + '</small>' +
                            delBtn + '</div>';
                    }).filter(Boolean).join('');
                }

                var eQ = encodeURIComponent(query).replace(/'/g, '%27');
                return '<div class="search-item" style="display:flex;gap:15px;align-items:start;">' +
                    '<img src="' + posterUrl + '" alt="Poster" style="width:60px;height:90px;object-fit:cover;border-radius:8px;flex-shrink:0;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);" onerror="this.style.display=\\'none\\';this.nextElementSibling.style.display=\\'flex\\';">' +
                    '<div style="width:60px;height:90px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:8px;display:none;align-items:center;justify-content:center;font-size:32px;flex-shrink:0;">\\uD83C\\uDFAC</div>' +
                    '<div style="flex:1;">' +
                        '<div class="search-query">' + title + '</div>' +
                        '<div class="search-stats">' +
                            '\\uD83D\\uDD0D Hledáno: ' + stats.count + 'x | ' +
                            '\\uD83D\\uDCE6 Nalezeno: ' + stats.results_count + ' souborů | ' +
                            '\\uD83D\\uDD52 Naposledy: ' + new Date(stats.last_search).toLocaleString('cs-CZ') +
                        '</div>' +
                        manualLinksHtml +
                        '<div class="add-link-form">' +
                            '<input type="text" id="name_' + eQ + '" placeholder="Název (např. Frieren EP1 CZ 1080p)" style="width:100%;margin-bottom:5px;padding:8px;box-sizing:border-box;">' +
                            '<input type="text" id="link_' + eQ + '" placeholder="Webshare URL nebo ident" style="width:70%;display:inline-block;padding:8px;">' +
                            '<button onclick="addLink(decodeURIComponent(\\'' + eQ + '\\'), \\'' + eQ + '\\')" style="width:28%;display:inline-block;padding:8px;">Přidat</button>' +
                            '<p id="msg_' + eQ + '" class="hidden"></p>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            }).join('');
        }

        async function addLink(query, encodedQuery) {
            var nameInput = document.getElementById('name_' + encodedQuery);
            var linkInput = document.getElementById('link_' + encodedQuery);
            var name = nameInput ? nameInput.value.trim() : '';
            var link = linkInput ? linkInput.value.trim() : '';

            if (!link) { showMessage(encodedQuery, 'Zadejte Webshare ident nebo URL!', 'error'); return; }
            if (!name) { showMessage(encodedQuery, 'Zadejte název pro link!', 'error'); return; }

            try {
                showMessage(encodedQuery, 'Kontroluji link...', 'info');
                var response = await fetch('/api/mylinks/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: currentUser,
                        password: currentPassword,
                        query: query,
                        link: link,
                        display_name: name
                    })
                });
                var data = await response.json();
                if (data.success) {
                    showMessage(encodedQuery, 'Link přidán! Všichni uživatelé ho teď uvidí.', 'success');
                    if (linkInput) linkInput.value = '';
                    if (nameInput) nameInput.value = '';
                    setTimeout(function() { location.reload(); }, 1500);
                } else {
                    showMessage(encodedQuery, data.error || 'Chyba', 'error');
                }
            } catch (error) {
                showMessage(encodedQuery, 'Chyba: ' + error.message, 'error');
            }
        }

        async function deleteLink(query, linkIndex, encodedQuery) {
            if (!confirm('Opravdu chcete smazat tento manuální link?')) return;
            try {
                var response = await fetch('/api/mylinks/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: currentUser,
                        query: query,
                        link_index: linkIndex
                    })
                });
                var data = await response.json();
                if (data.success) {
                    showMessage(encodedQuery, 'Link smazán.', 'success');
                    setTimeout(function() { location.reload(); }, 1000);
                } else {
                    showMessage(encodedQuery, data.error || 'Chyba', 'error');
                }
            } catch (error) {
                showMessage(encodedQuery, 'Chyba: ' + error.message, 'error');
            }
        }

        async function downloadBackup() {
            try {
                var response = await fetch('/api/mylinks/backup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: currentUser })
                });
                var data = await response.json();
                if (data.success && data.backup) {
                    var blob = new Blob([JSON.stringify(data.backup, null, 2)], { type: 'application/json' });
                    var url = URL.createObjectURL(blob);
                    var a = document.createElement('a');
                    a.href = url;
                    a.download = 'webshare-addon-backup-' + new Date().toISOString().split('T')[0] + '.json';
                    a.click();
                    URL.revokeObjectURL(url);
                    showAdminMsg('Záloha stažena', 'success');
                } else {
                    showAdminMsg(data.error || 'Chyba', 'error');
                }
            } catch (error) {
                showAdminMsg('Chyba: ' + error.message, 'error');
            }
        }

        async function restoreBackup(input) {
            var file = input.files[0];
            if (!file) return;
            if (!confirm('VAROVÁNÍ: Tato akce přepíše všechny manuální linky! Pokračovat?')) {
                input.value = '';
                return;
            }
            try {
                var text = await file.text();
                var backup = JSON.parse(text);
                var response = await fetch('/api/mylinks/restore', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: currentUser, backup: backup })
                });
                var data = await response.json();
                if (data.success) {
                    showAdminMsg('Záloha obnovena (' + data.restored + ' linků). Stránka se obnoví.', 'success');
                    setTimeout(function() { location.reload(); }, 2000);
                } else {
                    showAdminMsg(data.error || 'Chyba', 'error');
                }
            } catch (error) {
                showAdminMsg('Chyba: ' + error.message, 'error');
            }
            input.value = '';
        }

        function showAdminMsg(msg, type) {
            var el = document.getElementById('adminMessage');
            if (el) {
                el.textContent = msg;
                el.style.display = 'block';
                el.style.color = type === 'success' ? '#00ff00' : '#ff0000';
            }
        }

        async function showBrokenLinks() {
            try {
                var response = await fetch('/api/mylinks/manual');
                var data = await response.json();
                var links = data.links || {};
                var brokenLinks = [];
                for (var q in links) {
                    if (Array.isArray(links[q])) {
                        links[q].forEach(function(link, idx) {
                            if (link.status === 'broken') {
                                brokenLinks.push({ query: q, idx: idx, link: link });
                            }
                        });
                    }
                }
                var list = document.getElementById('brokenLinksList');
                if (brokenLinks.length === 0) {
                    list.innerHTML = '<p style="color:#00ff00;">Žádné nefunkční linky!</p>';
                } else {
                    list.innerHTML = brokenLinks.map(function(item) {
                        var eQ = encodeURIComponent(item.query).replace(/'/g, '%27');
                        return '<div style="background:#0d1b2a;padding:10px;margin:10px 0;border-radius:5px;border-left:4px solid #ff4444;">' +
                            '<strong style="color:#fff;">' + item.query + '</strong><br>' +
                            '<span style="color:#00d9ff;">' + item.link.display_name + '</span><br>' +
                            '<small style="color:#999;">Přidal: ' + item.link.added_by + ' &bull; Selhalo: ' + new Date(item.link.last_checked).toLocaleString('cs-CZ') + ' &bull; Počet selhání: ' + (item.link.fail_count || 1) + '</small>' +
                            '<br><button onclick="deleteLink(decodeURIComponent(\\'' + eQ + '\\'), ' + item.idx + ', \\'' + eQ + '\\')" style="margin-top:5px;padding:5px 10px;background:#ff4444;color:white;border:none;border-radius:3px;cursor:pointer;">Smazat</button>' +
                            '</div>';
                    }).join('');
                }
                document.getElementById('brokenLinksPanel').style.display = 'block';
            } catch (error) {
                showAdminMsg('Chyba načítání: ' + error.message, 'error');
            }
        }

        function hideBrokenLinks() {
            document.getElementById('brokenLinksPanel').style.display = 'none';
        }

        async function showAdminManager() {
            try {
                var response = await fetch('/api/admins/list');
                var data = await response.json();
                var admins = data.admins || [];
                var list = document.getElementById('adminsList');
                list.innerHTML = '<h4 style="color:#fff;margin:10px 0;">Současní admini:</h4>' +
                    admins.map(function(admin) {
                        var isSuperAdmin = admin === 'Procha';
                        var crown = isSuperAdmin ? '\\uD83D\\uDC51 ' : '';
                        var removeBtn = !isSuperAdmin ?
                            '<button onclick="removeExistingAdmin(\\'' + admin + '\\')" style="padding:5px 10px;background:#ff4444;color:white;border:none;border-radius:3px;cursor:pointer;">Odebrat</button>' :
                            '<span style="color:#ff9500;">Super Admin (nelze odebrat)</span>';
                        return '<div style="background:#0d1b2a;padding:10px;margin:5px 0;border-radius:5px;display:flex;justify-content:space-between;align-items:center;">' +
                            '<span style="color:#00d9ff;font-weight:bold;">' + crown + admin + '</span>' + removeBtn + '</div>';
                    }).join('');
                document.getElementById('adminManagerPanel').style.display = 'block';
            } catch (error) {
                showAdminMsg('Chyba načítání adminů: ' + error.message, 'error');
            }
        }

        function hideAdminManager() {
            document.getElementById('adminManagerPanel').style.display = 'none';
        }

        async function addNewAdmin() {
            var input = document.getElementById('newAdminUsername');
            var username = input ? input.value.trim() : '';
            if (!username) { showAdminMgrMsg('Zadej uživatelské jméno', 'error'); return; }
            try {
                var response = await fetch('/api/admins/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username, added_by: currentUser })
                });
                var data = await response.json();
                if (data.success) {
                    showAdminMgrMsg(username + ' je nyní admin', 'success');
                    input.value = '';
                    setTimeout(showAdminManager, 1000);
                } else {
                    showAdminMgrMsg(data.error, 'error');
                }
            } catch (error) {
                showAdminMgrMsg('Chyba: ' + error.message, 'error');
            }
        }

        async function removeExistingAdmin(username) {
            if (!confirm('Opravdu odebrat admin práva uživateli ' + username + '?')) return;
            try {
                var response = await fetch('/api/admins/remove', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username, removed_by: currentUser })
                });
                var data = await response.json();
                if (data.success) {
                    showAdminMgrMsg(username + ' už není admin', 'success');
                    setTimeout(showAdminManager, 1000);
                } else {
                    showAdminMgrMsg(data.error, 'error');
                }
            } catch (error) {
                showAdminMgrMsg('Chyba: ' + error.message, 'error');
            }
        }

        function showAdminMgrMsg(msg, type) {
            var el = document.getElementById('adminManagerMessage');
            if (el) {
                el.textContent = msg;
                el.style.display = 'block';
                el.style.color = type === 'success' ? '#00ff00' : '#ff0000';
            }
        }

        // === BAN MANAGEMENT ===
        async function showBanManager() {
            document.getElementById('banManagerPanel').style.display = 'block';
            var list = document.getElementById('bannedList');
            list.innerHTML = '<p style="color:#999;">Načítám...</p>';
            try {
                var response = await fetch('/api/mylinks/banned-list', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: currentUser })
                });
                var data = await response.json();
                var banned = data.banned || [];
                if (banned.length === 0) {
                    list.innerHTML = '<p style="color:#00ff00;">Žádní zabanovaní uživatelé.</p>';
                } else {
                    list.innerHTML = banned.map(function(b) {
                        var date = new Date(b.banned_at).toLocaleString('cs-CZ');
                        var reason = b.reason ? ' &bull; Důvod: ' + b.reason : '';
                        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;margin:5px 0;background:#0d1b2a;border-radius:5px;border-left:3px solid #cc0000;">' +
                            '<div>' +
                                '<strong style="color:#ff6666;">' + b.username + '</strong>' +
                                '<div style="color:#999;font-size:12px;">Zabanoval: ' + (b.banned_by || '?') + ' &bull; ' + date + reason + '</div>' +
                            '</div>' +
                            '<button onclick="doUnbanUser(\\'' + b.username + '\\')" style="padding:5px 12px;background:#00ff00;color:#1a1a2e;border:none;border-radius:3px;cursor:pointer;font-weight:bold;font-size:12px;">Odbanovat</button>' +
                        '</div>';
                    }).join('');
                }
            } catch (error) {
                list.innerHTML = '<p style="color:#ff4444;">Chyba: ' + error.message + '</p>';
            }
        }

        function hideBanManager() {
            document.getElementById('banManagerPanel').style.display = 'none';
        }

        async function doBanUser() {
            var nameInput = document.getElementById('banUsername');
            var reasonInput = document.getElementById('banReason');
            var target = nameInput ? nameInput.value.trim() : '';
            var reason = reasonInput ? reasonInput.value.trim() : '';
            if (!target) { showBanMgrMsg('Zadej uživatelské jméno', 'error'); return; }
            try {
                var response = await fetch('/api/mylinks/ban', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: currentUser, target: target, reason: reason })
                });
                var data = await response.json();
                if (data.success) {
                    showBanMgrMsg(target + ' byl zabanován', 'success');
                    nameInput.value = '';
                    reasonInput.value = '';
                    setTimeout(showBanManager, 1000);
                } else {
                    showBanMgrMsg(data.error, 'error');
                }
            } catch (error) {
                showBanMgrMsg('Chyba: ' + error.message, 'error');
            }
        }

        async function doUnbanUser(target) {
            if (!confirm('Odbanovat uživatele ' + target + '?')) return;
            try {
                var response = await fetch('/api/mylinks/unban', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: currentUser, target: target })
                });
                var data = await response.json();
                if (data.success) {
                    showBanMgrMsg(target + ' byl odbanován', 'success');
                    setTimeout(showBanManager, 1000);
                } else {
                    showBanMgrMsg(data.error, 'error');
                }
            } catch (error) {
                showBanMgrMsg('Chyba: ' + error.message, 'error');
            }
        }

        function showBanMgrMsg(msg, type) {
            var el = document.getElementById('banManagerMessage');
            if (el) {
                el.textContent = msg;
                el.style.display = 'block';
                el.style.color = type === 'success' ? '#00ff00' : '#ff0000';
            }
        }

        function showMessage(encodedQuery, msg, type) {
            var el = document.getElementById('msg_' + encodedQuery);
            if (el) { el.textContent = msg; el.className = type; }
        }
    </script>
</body>
</html>`;

    res.send(htmlPage);
});

// API endpoint - vyhledat filmy/seriály přes Cinemeta (pro přidávání custom linků)
// API endpoint - zkontrolovat admin status uživatele
app.post('/api/mylinks/check-admin', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.json({ isAdmin: false });
        const admin = await isAdmin(username);
        res.json({ isAdmin: admin });
    } catch (error) {
        res.json({ isAdmin: false });
    }
});

// API endpoint - seznam zabanovaných uživatelů
app.post('/api/mylinks/banned-list', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username || !await isAdmin(username)) {
            return res.json({ error: 'Přístup odepřen', banned: [] });
        }
        const banned = await getBannedUsers();
        res.json({ banned });
    } catch (error) {
        res.json({ error: 'Server error', banned: [] });
    }
});

// API endpoint - zabanovat uživatele
app.post('/api/mylinks/ban', async (req, res) => {
    try {
        const { username, target, reason } = req.body;
        if (!username || !target) {
            return res.json({ success: false, error: 'Chybí údaje' });
        }
        const result = await banUser(target, username, reason || '');
        res.json(result);
    } catch (error) {
        res.json({ success: false, error: 'Server error' });
    }
});

// API endpoint - odbanovat uživatele
app.post('/api/mylinks/unban', async (req, res) => {
    try {
        const { username, target } = req.body;
        if (!username || !target) {
            return res.json({ success: false, error: 'Chybí údaje' });
        }
        const result = await unbanUser(target, username);
        res.json(result);
    } catch (error) {
        res.json({ success: false, error: 'Server error' });
    }
});

app.post('/api/search-titles', async (req, res) => {
    try {
        const { query, tmdb_api_key } = req.body;
        
        if (!query || query.trim().length < 2) {
            return res.json({ results: [] });
        }
        
        console.log('🔍 Search titles:', query);
        const results = [];
        
        // Hledáme přes TMDB pokud máme klíč
        if (tmdb_api_key) {
            try {
                const tmdbUrl = `https://api.themoviedb.org/3/search/multi?api_key=${tmdb_api_key}&query=${encodeURIComponent(query)}&language=cs-CZ&page=1`;
                const tmdbResp = await needle('get', tmdbUrl, { timeout: 5000 });
                
                if (tmdbResp.statusCode === 200 && tmdbResp.body && tmdbResp.body.results) {
                    for (const item of tmdbResp.body.results.slice(0, 10)) {
                        // Pouze filmy a seriály
                        if (item.media_type !== 'movie' && item.media_type !== 'tv') continue;
                        
                        const type = item.media_type === 'movie' ? 'movie' : 'series';
                        const czName = item.title || item.name || '';
                        const originalName = item.original_title || item.original_name || '';
                        const year = (item.release_date || item.first_air_date || '').substring(0, 4);
                        const poster = item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : null;
                        const tmdbId = item.id;
                        const isJapanese = item.original_language === 'ja';
                        
                        // Potřebujeme IMDB ID - další dotaz na TMDB
                        let imdbId = null;
                        try {
                            const endpoint = type === 'movie' 
                                ? `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=${tmdb_api_key}`
                                : `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${tmdb_api_key}`;
                            const idsResp = await needle('get', endpoint, { timeout: 3000 });
                            if (idsResp.body && idsResp.body.imdb_id) {
                                imdbId = idsResp.body.imdb_id;
                            }
                        } catch (e) {
                            console.log('Failed to get IMDB ID for TMDB', tmdbId);
                        }
                        
                        if (!imdbId) continue; // Bez IMDB ID nemůžeme propojit s addonem
                        
                        // Získat anglický název (druhý dotaz s language=en-US)
                        let enName = czName; // fallback
                        try {
                            const enEndpoint = type === 'movie'
                                ? `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdb_api_key}&language=en-US`
                                : `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${tmdb_api_key}&language=en-US`;
                            const enResp = await needle('get', enEndpoint, { timeout: 3000 });
                            if (enResp.body) {
                                enName = enResp.body.title || enResp.body.name || czName;
                            }
                        } catch (e) {
                            console.log('Failed to get EN name for TMDB', tmdbId);
                        }
                        
                        results.push({
                            imdb_id: imdbId,
                            name: czName,
                            en_name: enName !== czName ? enName : null,
                            original_name: (originalName !== czName && originalName !== enName) ? originalName : null,
                            year: year,
                            type: type,
                            poster: poster,
                            is_japanese: isJapanese
                        });
                    }
                }
            } catch (tmdbErr) {
                console.error('TMDB search error:', tmdbErr.message);
            }
        }
        
        // Fallback na Cinemeta pokud nemáme TMDB nebo nemáme výsledky
        if (results.length === 0) {
            try {
                // Cinemeta search pro filmy
                const movieResp = await needle('get', `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(query)}.json`, { timeout: 5000 });
                if (movieResp.body && movieResp.body.metas) {
                    for (const meta of movieResp.body.metas.slice(0, 5)) {
                        results.push({
                            imdb_id: meta.id,
                            name: meta.name,
                            original_name: null,
                            year: meta.releaseInfo || '',
                            type: 'movie',
                            poster: meta.poster || null
                        });
                    }
                }
                
                // Cinemeta search pro seriály
                const seriesResp = await needle('get', `https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(query)}.json`, { timeout: 5000 });
                if (seriesResp.body && seriesResp.body.metas) {
                    for (const meta of seriesResp.body.metas.slice(0, 5)) {
                        results.push({
                            imdb_id: meta.id,
                            name: meta.name,
                            original_name: null,
                            year: meta.releaseInfo || '',
                            type: 'series',
                            poster: meta.poster || null
                        });
                    }
                }
            } catch (cinemetaErr) {
                console.error('Cinemeta search error:', cinemetaErr.message);
            }
        }
        
        console.log(`Found ${results.length} title results for "${query}"`);
        res.json({ results });
        
    } catch (error) {
        console.error('Search titles error:', error);
        res.json({ results: [], error: 'Server error' });
    }
});

// API endpoint - získat historii vyhledávání uživatele (BEZ ověření hesla)
app.post('/api/mylinks/history', async (req, res) => {
    console.log('📥 POST /api/mylinks/history - Request received');
    try {
        const { username } = req.body;
        console.log('  Username:', username);
        
        if (!username) {
            console.log('  ❌ Missing username');
            return res.json({ error: 'Missing username' });
        }
        
        // Získat historii z R2
        console.log('  Fetching history from R2...');
        const searches = await getFromR2(`user-searches/${username}.json`);
        console.log('  ✅ History fetched, searches:', Object.keys(searches || {}).length);
        
        res.json({ searches: searches || {} });
        
    } catch (error) {
        console.error('  ❌ History API error:', error);
        res.json({ error: 'Server error' });
    }
});

// API endpoint - přidat manuální link
app.post('/api/mylinks/add', async (req, res) => {
    try {
        const { username, password, query, link, display_name, poster: bodyPoster, title_name } = req.body;
        
        if (!username || !query || !link || !display_name) {
            return res.json({ error: 'Missing data', success: false });
        }
        
        // Extrahovat webshare ident z URL nebo použít přímo
        let ident = link;
        if (link.includes('webshare.cz')) {
            const match = link.match(/file\/([a-zA-Z0-9]+)/);
            if (match) {
                ident = match[1];
            }
        }
        
        // Validace formátu
        if (!/^[a-zA-Z0-9]+$/.test(ident)) {
            return res.json({ 
                error: 'Neplatný formát Webshare identu', 
                success: false 
            });
        }
        
        // VALIDACE: Zkontrolovat jestli soubor existuje
        if (password) {
            try {
                console.log(`Validating link ${ident} for user ${username}...`);
                const saltedPassword = await saltPassword(username, password);
                const token = await login(username, saltedPassword);
                
                // Zkusit získat file info
                const fileInfo = await getFileInfo(ident, token);
                if (!fileInfo) {
                    return res.json({ 
                        error: '❌ Soubor nenalezen na Webshare (možná byl smazán)', 
                        success: false 
                    });
                }
                
                // Zkusit získat link
                const fileLink = await getFileLink(ident, token);
                if (!fileLink) {
                    return res.json({ 
                        error: '❌ Soubor nelze stáhnout (zkontroluj kredity/přístup)', 
                        success: false 
                    });
                }
                
                console.log(`✅ Link validated: ${fileInfo.name}`);
            } catch (validationError) {
                console.error('Validation failed:', validationError.message);
                return res.json({ 
                    error: '❌ Validace selhala: ' + validationError.message, 
                    success: false 
                });
            }
        }
        
        // Poster - preferovat z body, fallback na IMDB
        let poster = bodyPoster || null;
        if (!poster && query.includes('tt')) {
            const ttMatch = query.match(/tt(\d+)/);
            if (ttMatch) {
                try {
                    const metaResp = await needle('get', `https://v3-cinemeta.strem.io/meta/movie/tt${ttMatch[1]}.json`, { timeout: 3000 });
                    poster = metaResp.body?.meta?.poster || null;
                } catch (e) { /* ignore */ }
            }
        }
        
        // Pokud přidáváme custom link (ne z historie), zalogovat i do user-searches aby se zobrazil v historii
        console.log(`History check: query="${query}", username="${username}", match=${!!query.match(/^tt\d+:/)}`);
        if (query.match(/^tt\d+:/) && username) {
            try {
                const userKey = `user-searches/${username}.json`;
                let userSearches = await getFromR2(userKey) || {};
                console.log(`History entries: ${Object.keys(userSearches).length}, exists: ${!!userSearches[query]}`);
                if (!userSearches[query]) {
                    userSearches[query] = {
                        count: 0,
                        first_search: new Date().toISOString(),
                        last_search: new Date().toISOString(),
                        results_count: 0,
                        poster: poster,
                        display_name: title_name || null
                    };
                    await putToR2(userKey, userSearches);
                    console.log(`📝 Created history entry for custom link: "${query}" (display: "${title_name || ''}")`);
                } else {
                    let updated = false;
                    if (poster && !userSearches[query].poster) {
                        userSearches[query].poster = poster;
                        updated = true;
                    }
                    if (title_name && !userSearches[query].display_name) {
                        userSearches[query].display_name = title_name;
                        updated = true;
                    }
                    if (updated) {
                        await putToR2(userKey, userSearches);
                        console.log(`📝 Updated history entry: "${query}"`);
                    } else {
                        console.log(`ℹ️ History entry already exists and up to date: "${query}"`);
                    }
                }
            } catch (e) {
                console.error('Failed to create history entry:', e.message);
            }
        }
        
        // Přidat link
        const success = await addManualLink(query, ident, username, display_name, poster);
        
        res.json({ success });
        
    } catch (error) {
        console.error('Add link API error:', error);
        res.json({ error: 'Server error', success: false });
    }
});

// API endpoint - smazat manuální link
app.post('/api/mylinks/delete', async (req, res) => {
    try {
        const { username, query, link_index } = req.body;
        
        if (!username || !query || link_index === undefined) {
            return res.json({ error: 'Missing data', success: false });
        }
        
        const result = await deleteManualLink(query, link_index, username);
        res.json(result);
        
    } catch (error) {
        console.error('Delete link API error:', error);
        res.json({ error: 'Server error', success: false });
    }
});

// API endpoint - stáhnout zálohu (pouze admin)
app.post('/api/mylinks/backup', async (req, res) => {
    try {
        const { username } = req.body;
        
        if (!await isAdmin(username)) {
            return res.json({ error: 'Admin only', success: false });
        }
        
        const backup = await createBackup();
        
        if (!backup) {
            return res.json({ error: 'Failed to create backup', success: false });
        }
        
        res.json({ success: true, backup });
        
    } catch (error) {
        console.error('Backup API error:', error);
        res.json({ error: 'Server error', success: false });
    }
});

// API endpoint - nahrát zálohu (pouze admin)
app.post('/api/mylinks/restore', async (req, res) => {
    try {
        const { username, backup } = req.body;
        
        if (!await isAdmin(username)) {
            return res.json({ error: 'Admin only', success: false });
        }
        
        const result = await restoreBackup(backup, username);
        res.json(result);
        
    } catch (error) {
        console.error('Restore API error:', error);
        res.json({ error: 'Server error', success: false });
    }
});

// API - seznam adminů
app.get('/api/admins/list', async (req, res) => {
    try {
        const admins = await getAdmins();
        res.json({ admins });
    } catch (error) {
        console.error('List admins error:', error);
        res.json({ error: 'Server error', admins: [] });
    }
});

// API - přidat admina
app.post('/api/admins/add', async (req, res) => {
    try {
        const { username, added_by } = req.body;
        
        if (!username || !added_by) {
            return res.json({ error: 'Missing data', success: false });
        }
        
        const result = await addAdmin(username, added_by);
        res.json(result);
        
    } catch (error) {
        console.error('Add admin error:', error);
        res.json({ error: 'Server error', success: false });
    }
});

// API - odebrat admina
app.post('/api/admins/remove', async (req, res) => {
    try {
        const { username, removed_by } = req.body;
        
        if (!username || !removed_by) {
            return res.json({ error: 'Missing data', success: false });
        }
        
        const result = await removeAdmin(username, removed_by);
        res.json(result);
        
    } catch (error) {
        console.error('Remove admin error:', error);
        res.json({ error: 'Server error', success: false });
    }
});

// API endpoint - získat všechny manuální linky
app.get('/api/mylinks/manual', async (req, res) => {
    try {
        const links = await getManualLinks();
        res.json({ links });
    } catch (error) {
        console.error('Manual links API error:', error);
        res.json({ links: {}, error: 'Server error' });
    }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Addon accessible at: http://localhost:${PORT}/manifest.json`);
});

