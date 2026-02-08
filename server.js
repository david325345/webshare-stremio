const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const needle = require('needle');
const md5 = require('cryptmd5');
const sha1 = require('sha1');
const xml2js = require('xml2js');

const manifest = {
    id: 'com.webshare.anime',
    version: '3.23.1',
    name: 'Webshare Anime',
    description: 'Anime z Webshare.cz',
    logo: `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:7000'}/logo.png`,
    resources: ['stream'],
    types: ['series', 'movie'],
    catalogs: [],
    idPrefixes: ['tt', 'kitsu'],
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
        }
    ]
};

const builder = new addonBuilder(manifest);

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
    return sha1(md5.cryptMD5(password, salt));
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
    const resp = await needle('post', 'https://webshare.cz/api/search/', params, { headers });
    
    const files = resp.body.children.filter(el => el.name == 'file');
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
            
            console.log('Kitsu names:', names);
            return [...new Set(names)]; // Odstranění duplicit
        }
    } catch (error) {
        console.error('Error getting names from Kitsu:', error.message);
    }
    return [];
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

builder.defineStreamHandler(async (args) => {
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

        // Získáme všechny varianty názvů
        let searchQueries = [];
        let cinemataYear = null; // Pro filtrování filmů podle roku
        
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
            const names = await getKitsuNames(kitsuId);
            
            console.log('Found names from Kitsu:', names);

            if (names.length === 0) {
                console.log('No names found from Kitsu, returning empty');
                return { streams: [] };
            }

            // Filtrujeme jen názvy bez japonských znaků
            const latinNames = names.filter(name => {
                // Ponecháme jen názvy v latinské abecedě (a-z, A-Z, 0-9, mezery, pomlčky, atd.)
                return /^[\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF]+$/.test(name);
            });
            
            console.log('Filtered to latin names:', latinNames);
            
            if (latinNames.length === 0) {
                console.log('No latin names available, returning empty');
                return { streams: [] };
            }

            // Použijeme jen první (hlavní) název pro rychlost
            const mainName = latinNames[0];
            
            // Vyčistíme speciální znaky z názvu
            const cleanName = mainName.replace(/[!?:\*]/g, '');
            
            if (args.type === 'series' && episode) {
                const seasonEp = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                searchQueries.push(`${cleanName} ${seasonEp}`);
            } else {
                // Žádné číslo epizody - hledáme jen název
                searchQueries.push(cleanName);
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
                    const englishRomajiNames = anilistNames.filter(name => {
                        // Jen základní ASCII znaky (bez diakritiky)
                        return /^[a-zA-Z0-9\s\-':!\[\]\(\)\.&]+$/.test(name);
                    });
                    
                    console.log('Filtered to English/Romaji names:', englishRomajiNames);
                    
                    if (englishRomajiNames.length > 0) {
                        // Pro anime používáme JEN anglické/romaji názvy
                        names = englishRomajiNames;
                    } else {
                        // Žádné anglické názvy z AniList - použijeme anglický z TMDB
                        console.log('No English/Romaji names from AniList, using English from TMDB');
                        const englishName = tmdbNames.length > 1 ? tmdbNames[tmdbNames.length - 1] : tmdbNames[0];
                        names = [englishName];
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
                        // Vyčistíme speciální znaky
                        const cleanName = name.replace(/[!?:\*]/g, '');
                        searchQueries.push(`${cleanName} ${seasonEp}`);
                        // Jen epizoda pro seriály bez čísla sezóny
                        searchQueries.push(`${cleanName} ${episodeOnly}`);
                    }
                } else {
                    // Jen první 3 názvy
                    searchQueries = names.slice(0, 3).map(n => n.replace(/[!?:\*]/g, ''));
                }
            } else {
                // Jeden nebo více názvů (z TMDB nebo Cinemeta)
                // Pro každý název vytvoříme samostatný search query
                if (args.type === 'series' && season && episode) {
                    const seasonEp = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                    const episodeOnly = `E${String(episode).padStart(2, '0')}`;
                    
                    for (const name of names) {
                        const cleanName = name.replace(/[!?:\*]/g, '');
                        // Standardní formát S01E04
                        searchQueries.push(`${cleanName} ${seasonEp}`);
                        // Pouze epizoda E04 (pro seriály které nemají číslo sezóny)
                        searchQueries.push(`${cleanName} ${episodeOnly}`);
                    }
                } else {
                    // Filmy nebo bez epizody
                    searchQueries = names.map(n => n.replace(/[!?:\*]/g, ''));
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
        if (args.type === 'movie' && cinemataYear) {
            console.log(`Filtering movies by year: ${cinemataYear} (±1 year tolerance)`);
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
                            const yearDiff = Math.abs(fileYear - cinemataYear);
                            return yearDiff <= 1;
                        });
                        
                        if (!hasMatchingYear) {
                            console.log(`  Filtered out: ${result.name.substring(0, 50)} (years ${validYears} vs ${cinemataYear})`);
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
                    
                    // 1) Přesné patterny s číslem sezóny a epizody
                    const exactPatterns = [
                        `S${String(targetSeason).padStart(2, '0')}E${String(targetEpisode).padStart(2, '0')}`,  // S05E03
                        `S${targetSeason}E${String(targetEpisode).padStart(2, '0')}`,  // S5E03
                        `S${String(targetSeason).padStart(2, '0')}E${targetEpisode}`,  // S05E3
                        `S${targetSeason}E${targetEpisode}`,  // S5E3
                        `${String(targetSeason).padStart(2, '0')}X${String(targetEpisode).padStart(2, '0')}`,  // 05x03
                        `${targetSeason}X${String(targetEpisode).padStart(2, '0')}`,  // 5x03
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
                            
                            // Pro krátké keywords kontrolovat přímo
                            if (keyword.length <= 4) {
                                return nameLower.includes(keyword);
                            }
                            
                            const words = keyword.split(/\s+/).filter(w => w.length > 3);
                            if (words.length === 0) return true;
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
            
            // 1. JAZYK (CZ/SK má přednost)
            const aLang = hasLanguage(a.name);
            const bLang = hasLanguage(b.name);
            if (aLang && !bLang) return -1;
            if (!aLang && bLang) return 1;
            
            // 2. RELEVANCE - kolik slov z názvu se shoduje
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
        
        return response;
    } catch (error) {
        console.error('=== STREAM HANDLER ERROR ===');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        console.error('Args:', JSON.stringify(args));
        
        // Vracíme prázdné pole i při erroru
        return { streams: [] };
    }
});


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

// CORS middleware
app.use((req, res, next) => {
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
    
    <h2>📥 Instalace</h2>
    <div class="note">
        Vyplňte své přihlašovací údaje a klikněte na tlačítko pro instalaci.
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
            <input type="text" id="tmdb" name="tmdb" placeholder="79171fa24cf58cc89b8df8b165f0bcd4">
        </div>
        
        <button type="submit" class="install-btn" id="installBtn">
            🚀 Nainstalovat do Stremio
        </button>
    </form>
    
    <div id="installLinkContainer" style="display: none; margin-top: 20px;">
        <div class="note">
            <strong>📋 Instalační link:</strong>
            <div style="margin-top: 10px; word-break: break-all; background: #0d1b2a; padding: 10px; border-radius: 5px; font-family: monospace; font-size: 12px;">
                <span id="installLinkDisplay"></span>
            </div>
            <button onclick="copyInstallLink()" style="margin-top: 10px; padding: 8px 15px; background: #00d9ff; color: #1a1a2e; border: none; border-radius: 5px; cursor: pointer; font-weight: bold;">
                📋 Zkopírovat link
            </button>
        </div>
    </div>
    
    <h2>✨ Funkce</h2>
    <ul>
        <li>🎯 Automatická detekce anime přes AniList</li>
        <li>🌐 TMDB metadata (obrázky, popisy)</li>
        <li>📺 Podpora seriálů i filmů</li>
        <li>🇨🇿 CZ/SK priorita</li>
        <li>🎬 Smart filtrování podle roku a epizod</li>
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
        const btn = document.getElementById('installBtn');
        let currentInstallUrl = '';
        
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
            
            if (!username || !password) {
                alert('⚠️ Username a password jsou povinné!');
                return;
            }
            
            // Vytvoříme config objekt
            const config = {
                username: username,
                password: password
            };
            
            // Přidáme TMDB klíč pokud je vyplněn
            if (tmdb) {
                config.tmdb_api_key = tmdb;
            }
            
            // URL encode config
            const configEncoded = encodeURIComponent(JSON.stringify(config));
            
            // Vytvoříme Stremio install URL
            const installUrl = \`stremio://\${window.location.host}/manifest.json?config=\${configEncoded}\`;
            currentInstallUrl = installUrl;
            
            // Zobrazíme link
            document.getElementById('installLinkDisplay').textContent = installUrl;
            document.getElementById('installLinkContainer').style.display = 'block';
            
            // Přesměrujeme
            window.location.href = installUrl;
        });
    </script>
</body>
</html>
    `);
});

// Stremio addon routes
const addonRouter = getRouter(builder.getInterface());
app.use(addonRouter);

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Addon accessible at: http://localhost:${PORT}/manifest.json`);
});

