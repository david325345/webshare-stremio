const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const needle = require('needle');
const crypto = require('crypto');
const sha1 = require('sha1');
const xml2js = require('xml2js');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

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
const R2_PREFIX = 'webshare-addon/'; // Prefix pro izolaci od ostatních projektů

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
            return null; // Soubor neexistuje
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

async function logSearch(username, query, resultsCount) {
    try {
        // Získat existující historii uživatele
        const userKey = `user-searches/${username}.json`;
        let userSearches = await getFromR2(userKey) || {};
        
        // Aktualizovat statistiky pro tento search query
        if (!userSearches[query]) {
            userSearches[query] = {
                count: 0,
                first_search: new Date().toISOString(),
                last_search: new Date().toISOString(),
                results_count: resultsCount
            };
        }
        
        userSearches[query].count += 1;
        userSearches[query].last_search = new Date().toISOString();
        userSearches[query].results_count = resultsCount;
        
        // Uložit zpět do R2
        await putToR2(userKey, userSearches);
        console.log(`✅ Logged search for ${username}: "${query}" (${resultsCount} results)`);
    } catch (error) {
        console.error('Failed to log search:', error.message);
    }
}

async function getManualLinks() {
    return await getFromR2('manual-links.json') || {};
}

async function addManualLink(query, webshareIdent, addedBy, fileName) {
    try {
        const manualLinks = await getManualLinks();
        
        manualLinks[query] = {
            webshare_ident: webshareIdent,
            added_by: addedBy,
            added_at: new Date().toISOString(),
            file_name: fileName
        };
        
        await putToR2('manual-links.json', manualLinks);
        console.log(`✅ Manual link added: "${query}" → ${webshareIdent}`);
        return true;
    } catch (error) {
        console.error('Failed to add manual link:', error.message);
        return false;
    }
}

const manifest = {
    id: 'com.webshare.anime',
    version: '7.1.2', // Add debug logging to saltPassword and login
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
            key: 'enable_logging',
            type: 'checkbox',
            title: 'Enable Search Logging (history in My Links)',
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
    
    console.log('Salt received:', salt);
    
    // Webshare používá PHP-style MD5 crypt: md5(md5(password) . salt)
    const passwordMd5 = crypto.createHash('md5').update(password).digest('hex');
    const salted = crypto.createHash('md5').update(passwordMd5 + salt).digest('hex');
    const final = sha1(salted);
    
    console.log('Password MD5:', passwordMd5.substring(0, 10) + '...');
    console.log('Salted MD5:', salted.substring(0, 10) + '...');
    console.log('Final SHA1:', final.substring(0, 10) + '...');
    
    return final;
}

async function login(username, saltedPassword) {
    console.log(`Logging in user ${username}`);
    const params = `username_or_email=${encodeURIComponent(username)}&password=${encodeURIComponent(saltedPassword)}&keep_logged_in=1`;
    const resp = await needle('post', 'https://webshare.cz/api/login/', params, { headers });
    
    console.log('Login response status:', resp.statusCode);
    console.log('Login response body:', JSON.stringify(resp.body, null, 2).substring(0, 500));
    
    if (resp.statusCode != 200 || resp.body.children.find(el => el.name == 'status').value != 'OK') {
        const statusEl = resp.body.children.find(el => el.name == 'status');
        console.log('Login failed - status:', statusEl ? statusEl.value : 'not found');
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
            
            // Získat rok vydání
            let year = null;
            if (attrs.startDate) {
                year = parseInt(attrs.startDate.substring(0, 4));
            }
            
            console.log('Kitsu names:', names);
            console.log('Kitsu year:', year);
            return { names: [...new Set(names)], year }; // Odstranění duplicit + rok
        }
    } catch (error) {
        console.error('Error getting names from Kitsu:', error.message);
    }
    return { names: [], year: null };
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
async function handleStreamRequest(args) {
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

        // Připravíme heslo a přihlásíme se
        const saltedPassword = await saltPassword(username, password);
        const token = await login(username, saltedPassword);
        
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
            
            let names = [];
            let primarySource = 'tmdb';
            
            if (tmdbNames.length > 0) {
                console.log('TMDB found:', tmdbNames);
                
                // Pro japonský obsah (anime) použijeme JEN anglický název
                if (isJapaneseContent) {
                    console.log('Detected Japanese content - using only English name from TMDB');
                    // Poslední název je anglický (z EN query)
                    const englishName = tmdbNames[tmdbNames.length - 1];
                    names = [englishName];
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
                
                // Kontrola roku - PŘESNÝ rok pro filmy i seriály
                let yearMatch = true;
                if (anilistYear && cinemataYear) {
                    const yearDiff = Math.abs(anilistYear - cinemataYear);
                    console.log(`Year difference: ${yearDiff} years (AniList: ${anilistYear}, Source: ${cinemataYear})`);
                    
                    // Vyžadujeme přesný rok (0 rozdíl)
                    if (yearDiff > 0) {
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
                        
                        searchQueries.push(`${cleanName} ${seasonEp}`);
                        searchQueries.push(`${cleanNameNoSuffix} ${seasonEp}`);
                        if (hasOuVariant) searchQueries.push(`${nameWithOu} ${seasonEp}`);
                        
                        // Jen epizoda
                        searchQueries.push(`${cleanName} ${episodeOnly}`);
                        searchQueries.push(`${cleanNameNoSuffix} ${episodeOnly}`);
                        if (hasOuVariant) searchQueries.push(`${nameWithOu} ${episodeOnly}`);
                        
                        // Jen číslo
                        const plainNumber = String(episode).padStart(2, '0');
                        searchQueries.push(`${cleanName} ${plainNumber}`);
                        searchQueries.push(`${cleanNameNoSuffix} ${plainNumber}`);
                        if (hasOuVariant) searchQueries.push(`${nameWithOu} ${plainNumber}`);
                        
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
                    // Jen první 3 názvy
                    searchQueries = names.slice(0, 3).map(n => n.replace(/\//g, ' ').replace(/[!?:\*]/g, ''));
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
                        
                        // Standardní formát S01E04
                        searchQueries.push(`${cleanName} ${seasonEp}`);
                        searchQueries.push(`${cleanNameNoSuffix} ${seasonEp}`);
                        if (hasOuVariant) searchQueries.push(`${nameWithOu} ${seasonEp}`);
                        
                        // Pouze epizoda E04
                        searchQueries.push(`${cleanName} ${episodeOnly}`);
                        searchQueries.push(`${cleanNameNoSuffix} ${episodeOnly}`);
                        if (hasOuVariant) searchQueries.push(`${nameWithOu} ${episodeOnly}`);
                        
                        // Jen číslo 01, 04 apod. (pro webshare formát)
                        const plainNumber = String(episode).padStart(2, '0');
                        searchQueries.push(`${cleanName} ${plainNumber}`);
                        searchQueries.push(`${cleanNameNoSuffix} ${plainNumber}`);
                        if (hasOuVariant) searchQueries.push(`${nameWithOu} ${plainNumber}`);
                        
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
                    searchQueries = names.map(n => n.replace(/\//g, ' ').replace(/[!?:\*]/g, ''));
                }
            }
        } else {
            searchQueries = [args.id];
        }

        console.log('Search queries:', searchQueries);

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
        
        console.log(`Returning ${validStreams.length} streams to Stremio`);
        
        // Vracíme pole streamů - i když je prázdné
        const response = { 
            streams: validStreams.length > 0 ? validStreams : []
        };
        
        console.log('=== RESPONSE READY ===');
        console.log('Response object:', JSON.stringify(response, null, 2).substring(0, 500));
        
        // Zalogovat TT/IMDB/KITSU vyhledávání (NE webshare- přímé vyhledávání)
        if (!args.id.startsWith('webshare-') && validStreams.length > 0 && username && searchQueries.length > 0) {
            const mainQuery = searchQueries[0]; // První (nejdůležitější) název
            logSearch(username, `${args.id.split(':')[0]}: ${mainQuery}`, validStreams.length).catch(err => {
                console.error('R2 logging failed:', err.message);
            });
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
        
        // Zkontrolovat jestli existuje manuální link pro tento search
        const manualLinks = await getManualLinks();
        const manualLink = manualLinks[searchQuery];
        
        if (manualLink) {
            console.log(`Found manual link for "${searchQuery}": ${manualLink.webshare_ident}`);
            // Přidat manuální link na začátek výsledků
            try {
                const manualFileInfo = await getFileInfo(manualLink.webshare_ident, token);
                if (manualFileInfo) {
                    results.unshift({
                        ident: manualLink.webshare_ident,
                        name: manualFileInfo.name,
                        img: manualFileInfo.img,
                        size: manualFileInfo.size,
                        positive_votes: manualFileInfo.positive_votes,
                        negative_votes: manualFileInfo.negative_votes
                    });
                }
            } catch (error) {
                console.log('Failed to fetch manual link file info:', error.message);
            }
        }
        
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
        
        // PŘÍMÉ VYHLEDÁVÁNÍ SE NELOGUJE (podle požadavku uživatele)
        
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

// JSON body parser - MUSÍ BÝT PŘED routes!
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
                <input type="checkbox" id="enable_logging" name="enable_logging" checked style="width: auto; margin-right: 10px;">
                <span>Enable Search Logging (history in My Links)</span>
            </label>
        </div>
        
        <button type="submit" class="install-btn">
            🔗 Vygenerovat instalační link
        </button>
    </form>
    
    <div style="margin-top: 20px; text-align: center;">
        <a href="/mylinks" style="color: #00d9ff; text-decoration: none; font-size: 16px;">
            🔗 My Links - Správa manuálních linků
        </a>
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
                <button onclick="installNow()" style="padding: 10px 20px; background: #7b2cbf; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; margin-right: 10px;">
                    🚀 Nainstalovat
                </button>
                <a id="myLinksBtn" href="/mylinks" target="_blank" style="display: none; padding: 10px 20px; background: #9d4edd; color: white; border-radius: 5px; text-decoration: none; font-weight: bold;">
                    🔗 My Links
                </a>
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
            const enableLogging = document.getElementById('enable_logging').checked;
            
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
                enable_logging: enableLogging
            };
            
            // Base64 encode config pro personal URL
            const configB64 = btoa(JSON.stringify(config));
            
            // Vytvoříme PERSONAL Stremio install URL s credentials v path
            const installUrl = \`stremio://\${window.location.host}/\${configB64}/manifest.json\`;
            currentInstallUrl = installUrl;
            
            // Zobrazíme link
            document.getElementById('installLinkDisplay').textContent = installUrl;
            document.getElementById('installLinkContainer').style.display = 'block';
            
            // Vytvoříme My Links URL s credentials
            const myLinksUrl = \`/mylinks?username=\${encodeURIComponent(username)}&password=\${encodeURIComponent(password)}\`;
            const myLinksBtn = document.getElementById('myLinksBtn');
            if (myLinksBtn) {
                myLinksBtn.href = myLinksUrl;
                myLinksBtn.style.display = 'inline-block';
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
        const result = await handleStreamRequest(args);
        
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
    // Pokud jsou credentials v query (?username=...&password=...), auto-login
    const autoUsername = req.query.username || '';
    const autoPassword = req.query.password || '';
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>My Links - Webshare Addon</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { 
            font-family: Arial, sans-serif; 
            max-width: 900px; 
            margin: 50px auto; 
            padding: 20px;
            background: #1a1a2e;
            color: #eee;
        }
        h1 { color: #00d9ff; }
        h2 { color: #9d4edd; margin-top: 30px; }
        .login-form {
            background: #16213e;
            padding: 20px;
            border-radius: 10px;
            margin: 20px 0;
        }
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
    </style>
</head>
<body>
    <h1>🔗 My Links - Správa manuálních linků</h1>
    
    <div id="loginSection" class="login-form" style="display: ${autoUsername ? 'none' : 'block'}">
        <h2>Přihlášení</h2>
        <p>Použijte své Webshare přihlašovací údaje:</p>
        <div class="form-group">
            <label>Username:</label>
            <input type="text" id="username" placeholder="vase-jmeno">
        </div>
        <div class="form-group">
            <label>Password:</label>
            <input type="password" id="password" placeholder="••••••••">
        </div>
        <button onclick="login()">Přihlásit se</button>
        <p id="loginError" class="error hidden"></p>
    </div>
    
    <div id="historySection" class="${autoUsername ? '' : 'hidden'}">
        <div id="loadingMsg" style="text-align: center; padding: 20px; ${autoUsername ? '' : 'display: none;'}">
            <p style="color: #00d9ff; font-size: 18px;">⏳ Načítám vaši historii vyhledávání...</p>
        </div>
        <h2 style="display: none;" id="histTitle">📊 Vaše historie vyhledávání</h2>
        <p style="display: none;" id="histDesc">Zde vidíte co jste hledali a můžete přidat manuální linky.</p>
        <div id="searchHistory"></div>
    </div>
    
    <script>
        let currentUser = '';
        const autoUsername = '${autoUsername}';
        const autoPassword = '${autoPassword}';
        
        // Auto-login pokud jsou credentials v URL
        if (autoUsername && autoPassword) {
            setTimeout(() => loginWithCredentials(autoUsername, autoPassword), 100);
        }
        
        // Cookie helpers
        function setCookie(name, value, days) {
            const expires = new Date();
            expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
            document.cookie = name + '=' + encodeURIComponent(value) + ';expires=' + expires.toUTCString() + ';path=/';
        }
        
        function getCookie(name) {
            const nameEQ = name + '=';
            const ca = document.cookie.split(';');
            for(let i = 0; i < ca.length; i++) {
                let c = ca[i];
                while (c.charAt(0) === ' ') c = c.substring(1, c.length);
                if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length));
            }
            return null;
        }
        
        // Auto-fill ze cookies při načtení stránky
        window.onload = function() {
            const savedUsername = getCookie('ws_username');
            const savedPassword = getCookie('ws_password');
            
            if (savedUsername) {
                document.getElementById('username').value = savedUsername;
            }
            if (savedPassword) {
                document.getElementById('password').value = savedPassword;
            }
            
            // Auto-login pokud máme credentials
            if (savedUsername && savedPassword) {
                // Počkat chvíli než se stránka načte
                setTimeout(() => {
                    const autoLogin = confirm('Máte uložené přihlašovací údaje. Přihlásit automaticky?');
                    if (autoLogin) {
                        login();
                    }
                }, 500);
            }
        };
        
        async function login() {
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value.trim();
            
            if (!username || !password) {
                showError('Vyplňte username a password!');
                return;
            }
            
            try {
                const response = await fetch('/api/mylinks/history', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                
                const data = await response.json();
                
                if (data.error) {
                    showError(data.error);
                    return;
                }
                
                // Uložit do cookies (platnost 30 dní)
                setCookie('ws_username', username, 30);
                setCookie('ws_password', password, 30);
                
                currentUser = username;
                showHistory(data.searches);
                
            } catch (error) {
                showError('Chyba připojení: ' + error.message);
            }
        }
        
        function showError(msg) {
            const errorEl = document.getElementById('loginError');
            errorEl.textContent = msg;
            errorEl.classList.remove('hidden');
        }
        
        function showHistory(searches) {
            // Skrýt loading a login
            const loadingMsg = document.getElementById('loadingMsg');
            if (loadingMsg) loadingMsg.style.display = 'none';
            
            document.getElementById('loginSection').style.display = 'none';
            document.getElementById('historySection').classList.remove('hidden');
            
            // Zobrazit nadpisy
            const title = document.getElementById('histTitle');
            const desc = document.getElementById('histDesc');
            if (title) title.style.display = 'block';
            if (desc) desc.style.display = 'block';
            
            const historyDiv = document.getElementById('searchHistory');
            
            if (!searches || Object.keys(searches).length === 0) {
                historyDiv.innerHTML = '<p>Zatím jste nic nehledali.</p>';
                return;
            }
            
            // Seřadit podle posledního vyhledávání
            const sorted = Object.entries(searches).sort((a, b) => {
                return new Date(b[1].last_search) - new Date(a[1].last_search);
            });
            
            historyDiv.innerHTML = sorted.map(([query, stats]) => \`
                <div class="search-item">
                    <div class="search-query">\${query}</div>
                    <div class="search-stats">
                        🔍 Hledáno: \${stats.count}x | 
                        📦 Nalezeno: \${stats.results_count} souborů |
                        🕒 Naposledy: \${new Date(stats.last_search).toLocaleString('cs-CZ')}
                    </div>
                    <div class="add-link-form">
                        <input type="text" id="link_\${encodeURIComponent(query)}" placeholder="Webshare ident (např. ABC123) nebo URL" style="width: 70%; display: inline-block;">
                        <button onclick="addLink('\${query.replace(/'/g, "\\\\'")}')">Přidat link</button>
                        <p id="msg_\${encodeURIComponent(query)}" class="hidden"></p>
                    </div>
                </div>
            \`).join('');
        }
        
        async function addLink(query) {
            const linkInput = document.getElementById('link_' + encodeURIComponent(query));
            const link = linkInput.value.trim();
            
            if (!link) {
                showMessage(query, 'Zadejte Webshare ident nebo URL!', 'error');
                return;
            }
            
            try {
                const response = await fetch('/api/mylinks/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        username: currentUser,
                        query: query,
                        link: link
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showMessage(query, '✅ Link přidán! Všichni uživatelé ho teď uvidí.', 'success');
                    linkInput.value = '';
                } else {
                    showMessage(query, '❌ ' + data.error, 'error');
                }
                
            } catch (error) {
                showMessage(query, '❌ Chyba: ' + error.message, 'error');
            }
        }
        
        function showMessage(query, msg, type) {
            const msgEl = document.getElementById('msg_' + encodeURIComponent(query));
            msgEl.textContent = msg;
            msgEl.className = type;
        }
    </script>
</body>
</html>
    `);
});

// API endpoint - získat historii vyhledávání uživatele
app.post('/api/mylinks/history', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.json({ error: 'Missing credentials' });
        }
        
        // Ověřit Webshare login
        try {
            const saltedPassword = await saltPassword(username, password);
            const token = await login(username, saltedPassword);
            console.log('✅ Login successful for', username);
        } catch (error) {
            console.error('❌ Login failed:', error.message);
            return res.json({ error: 'Neplatné přihlašovací údaje: ' + error.message });
        }
        
        // Získat historii z R2
        const searches = await getFromR2(`user-searches/${username}.json`);
        
        res.json({ searches: searches || {} });
        
    } catch (error) {
        console.error('History API error:', error);
        res.json({ error: 'Server error' });
    }
});

// API endpoint - přidat manuální link
app.post('/api/mylinks/add', async (req, res) => {
    try {
        const { username, query, link } = req.body;
        
        if (!username || !query || !link) {
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
        
        // Přidat link
        const success = await addManualLink(query, ident, username, 'N/A');
        
        res.json({ success });
        
    } catch (error) {
        console.error('Add link API error:', error);
        res.json({ error: 'Server error', success: false });
    }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Addon accessible at: http://localhost:${PORT}/manifest.json`);
});

