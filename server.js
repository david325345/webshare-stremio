const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const needle = require('needle');
const md5 = require('cryptmd5');
const sha1 = require('sha1');
const xml2js = require('xml2js');

const manifest = {
    id: 'com.webshare.anime',
    version: '1.1.1',
    name: 'Webshare Anime',
    description: 'Anime z Webshare.cz',
    resources: ['stream'],
    types: ['series', 'movie'],
    catalogs: [],
    idPrefixes: ['tt', 'kitsu'],
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
        }
    ]
};

const builder = new addonBuilder(manifest);

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

// AniList GraphQL API pro získání všech variant názvů anime z IMDb ID
async function getAnimeNamesFromIMDb(imdbId) {
    try {
        console.log('=== getAnimeNamesFromIMDb START ===');
        console.log('IMDb ID:', imdbId);
        
        // Zkusíme TMDB
        const tmdbUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=0eefece0676icing90e9977c1e47c9dd&external_source=imdb_id`;
        console.log('Calling TMDB:', tmdbUrl);
        
        const tmdbResp = await needle('get', tmdbUrl);
        console.log('TMDB response status:', tmdbResp.statusCode);
        console.log('TMDB tv_results:', tmdbResp.body?.tv_results);
        
        let searchName = null;
        
        if (tmdbResp.body && tmdbResp.body.tv_results && tmdbResp.body.tv_results.length > 0) {
            const tvShow = tmdbResp.body.tv_results[0];
            searchName = tvShow.name || tvShow.original_name;
            console.log('Got name from TMDB:', searchName);
        } else {
            console.log('TMDB returned no TV results');
            return [];
        }
        
        // Vyčistíme název pro lepší vyhledávání
        const cleanName = searchName
            .replace(/Don't Toy with Me,?\s*/i, '')
            .replace(/Miss\s+/i, '')
            .replace(/Season \d+/gi, '')
            .trim();
        
        console.log('Cleaned search name:', cleanName);
        
        // Hledáme na AniList
        const searchQuery = `
        query ($search: String) {
            Media(search: $search, type: ANIME) {
                title {
                    romaji
                    english
                    native
                }
                synonyms
                idMal
            }
        }`;
        
        // Zkusíme oba názvy
        for (const name of [searchName, cleanName]) {
            console.log('Searching AniList with:', name);
            
            const searchResp = await needle('post', 'https://graphql.anilist.co', {
                query: searchQuery,
                variables: { search: name }
            }, {
                json: true
            });
            
            console.log('AniList response status:', searchResp.statusCode);
            console.log('AniList data:', searchResp.body?.data);
            
            if (searchResp.body && searchResp.body.data && searchResp.body.data.Media) {
                const media = searchResp.body.data.Media;
                const names = [];
                
                if (media.title.romaji) names.push(media.title.romaji);
                if (media.title.english) names.push(media.title.english);
                if (media.title.native) names.push(media.title.native);
                if (media.synonyms) names.push(...media.synonyms);
                
                console.log('Found on AniList:', names);
                console.log('=== getAnimeNamesFromIMDb SUCCESS ===');
                return [...new Set(names)];
            }
        }
        
        console.log('Not found on AniList after trying both names');
        console.log('=== getAnimeNamesFromIMDb FAIL ===');
    } catch (error) {
        console.error('=== getAnimeNamesFromIMDb ERROR ===');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
    }
    
    return [];
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
            
            if (args.type === 'series' && episode) {
                const seasonEp = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                searchQueries.push(`${mainName} ${seasonEp}`);
            } else {
                // Žádné číslo epizody - hledáme jen název
                searchQueries.push(mainName);
            }
        } else if (args.id.startsWith('tt')) {
            const parts = args.id.split(':');
            const imdbId = parts[0];
            const season = parts[1];
            const episode = parts[2];

            console.log('IMDb ID detected, checking if it is anime on AniList...');

            // Zkusíme získat všechny názvy z AniList (pokud je to anime)
            let names = await getAnimeNamesFromIMDb(imdbId);
            
            if (names.length > 0) {
                // Je to anime! Použijeme všechny názvy z AniList
                console.log('Found anime on AniList with names:', names);
                
                // Filtrujeme latinské názvy
                const latinNames = names.filter(name => {
                    return /^[\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF]+$/.test(name);
                });
                
                console.log('Filtered to latin names:', latinNames);
                
                if (latinNames.length === 0) {
                    console.log('No latin names available, trying Cinemeta');
                    names = await getCinemetaName(args.type, args.id);
                } else {
                    names = latinNames;
                }
            } else {
                // Není to anime na AniList, použijeme Cinemeta
                console.log('Not found on AniList, using Cinemeta');
                names = await getCinemetaName(args.type, args.id);
            }

            console.log('Final names for search:', names);

            if (names.length === 0) {
                console.log('No names found, returning empty');
                return { streams: [] };
            }

            // Pro anime (více názvů z AniList) - hledáme s každým názvem
            if (names.length > 1) {
                console.log('Using multiple names from AniList for better coverage');
                if (args.type === 'series' && season && episode) {
                    const seasonEp = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                    // Použijeme všechny názvy
                    for (const name of names) {
                        searchQueries.push(`${name} ${seasonEp}`);
                    }
                } else {
                    searchQueries = names;
                }
            } else {
                // Jen jeden název (z Cinemeta) - použijeme jen ten
                const mainName = names[0];
                if (args.type === 'series' && season && episode) {
                    const seasonEp = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                    searchQueries.push(`${mainName} ${seasonEp}`);
                } else {
                    searchQueries.push(mainName);
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

        // Pokud hledáme konkrétní epizodu, filtrujeme jen tu
        let filteredResults = results;
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
                    
                    // Přesné patterny pro epizody - musí být přesná shoda
                    const exactPatterns = [
                        `S${String(targetSeason).padStart(2, '0')}E${String(targetEpisode).padStart(2, '0')}`,  // S01E01
                        `S${targetSeason}E${String(targetEpisode).padStart(2, '0')}`,  // S1E01
                        `S${String(targetSeason).padStart(2, '0')}E${targetEpisode}`,  // S01E1
                        `S${targetSeason}E${targetEpisode}`,  // S1E1
                        `${String(targetSeason).padStart(2, '0')}X${String(targetEpisode).padStart(2, '0')}`,  // 01x01
                        `${targetSeason}X${String(targetEpisode).padStart(2, '0')}`,  // 1x01
                        `${String(targetSeason).padStart(2, '0')}X${targetEpisode}`,  // 01x1
                        `${targetSeason}X${targetEpisode}`,  // 1x1
                    ];
                    
                    // EP/Episode patterns - musí být následované přesným číslem a koncem slova
                    const episodeOnlyPatterns = [
                        new RegExp(`E${String(targetEpisode).padStart(2, '0')}[^0-9]`, 'i'),  // E01 (následované non-digit)
                        new RegExp(`E${String(targetEpisode).padStart(2, '0')}$`, 'i'),  // E01 (na konci)
                        new RegExp(`EP${String(targetEpisode).padStart(2, '0')}[^0-9]`, 'i'),  // EP01
                        new RegExp(`EP${String(targetEpisode).padStart(2, '0')}$`, 'i'),
                        new RegExp(`EPISODE[\\s-_]*${String(targetEpisode).padStart(2, '0')}[^0-9]`, 'i'),  // EPISODE 01
                        new RegExp(`EPISODE[\\s-_]*${String(targetEpisode).padStart(2, '0')}$`, 'i'),
                    ];
                    
                    // Kontrola přesných patternů
                    const hasExactPattern = exactPatterns.some(pattern => nameUpper.includes(pattern));
                    if (hasExactPattern) return true;
                    
                    // Kontrola episode-only patternů (pro single season anime)
                    const hasEpisodePattern = episodeOnlyPatterns.some(pattern => pattern.test(nameUpper));
                    return hasEpisodePattern;
                });
                
                console.log(`Filtered to ${filteredResults.length} results matching episode`);
                
                // Pokud přísný filtr nenajde nic, vrátíme všechny výsledky
                if (filteredResults.length === 0) {
                    console.log('No exact matches, returning all results');
                    filteredResults = results;
                }
            } else {
                console.log('No episode number to filter - showing all results');
            }
        }

        // Prioritizace CZ/SK - české a slovenské soubory dáme nahoru
        filteredResults.sort((a, b) => {
            const aHasCZSK = a.name.toUpperCase().includes('CZ') || 
                            a.name.toUpperCase().includes('CZECH') ||
                            a.name.toUpperCase().includes('SK') ||
                            a.name.toUpperCase().includes('SLOVAK');
            const bHasCZSK = b.name.toUpperCase().includes('CZ') || 
                            b.name.toUpperCase().includes('CZECH') ||
                            b.name.toUpperCase().includes('SK') ||
                            b.name.toUpperCase().includes('SLOVAK');
            
            if (aHasCZSK && !bHasCZSK) return -1;
            if (!aHasCZSK && bHasCZSK) return 1;
            
            // Seřadit podle čísla epizody v názvu (E01, E02, atd.)
            const aMatch = a.name.match(/[SE](\d+)/i);
            const bMatch = b.name.match(/[SE](\d+)/i);
            if (aMatch && bMatch) {
                const aNum = parseInt(aMatch[1]);
                const bNum = parseInt(bMatch[1]);
                if (aNum !== bNum) return aNum - bNum;
            }
            
            // Pak podle velikosti (větší = lepší kvalita)
            return parseInt(b.size) - parseInt(a.size);
        });

        if (filteredResults.length === 0) {
            return { streams: [] };
        }

        // Vytvoříme streamy pro každý výsledek
        // Pokud nemáme číslo epizody, vrátíme víc výsledků (50) aby uživatel viděl všechny epizody
        const hasEpisodeNumber = args.id.split(':').length >= 3;
        const maxStreams = hasEpisodeNumber ? 10 : 50;
        
        const filesToProcess = filteredResults.slice(0, maxStreams);
        console.log(`Processing ${filesToProcess.length} files for links...`);
        
        const streams = [];
        
        // Zpracujeme soubory najednou (ne po dávkách - rychlejší)
        const streamPromises = filesToProcess.map(async (file) => {
            try {
                const link = await getFileLink(file.ident, token);
                if (link) {
                    const quality = detectQuality(file.name);
                    
                    return {
                        name: `Webshare ${quality.resolution}`,
                        title: `${file.name} (${formatSize(file.size)})`,
                        url: link
                    };
                }
                return null;
            } catch (error) {
                console.error('Error getting link:', error.message);
                return null;
            }
        });
        
        const allStreams = await Promise.all(streamPromises);
        const validStreams = allStreams.filter(s => s !== null);
        
        console.log(`Returning ${validStreams.length} streams to Stremio`);
        return { 
            streams: validStreams,
            cacheMaxAge: 0 // Vypneme cache pro streamy
        };
    } catch (error) {
        console.error('=== STREAM HANDLER ERROR ===');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        console.error('Args:', JSON.stringify(args));
        return { streams: [] };
    }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
