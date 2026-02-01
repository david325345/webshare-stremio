const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const needle = require('needle');
const md5 = require('cryptmd5');
const sha1 = require('sha1');
const xml2js = require('xml2js');

const manifest = {
    id: 'cz.webshare.anime',
    version: '1.0.0',
    name: 'Webshare Anime',
    description: 'Anime z Webshare.cz',
    resources: ['stream'],
    types: ['series', 'movie'],
    catalogs: [],
    idPrefixes: ['tt', 'kitsu'],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
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
    const params = `what=${encodeURIComponent(query)}&category=video&limit=20&wst=${encodeURIComponent(token)}`;
    const resp = await needle('post', 'https://webshare.cz/api/search/', params, { headers });
    
    const files = resp.body.children.filter(el => el.name == 'file');
    return files.map(el => {
        const ident = el.children.find(c => c.name == 'ident').value;
        const name = el.children.find(c => c.name == 'name').value;
        const size = el.children.find(c => c.name == 'size').value;
        return { ident, name, size };
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

// AniList GraphQL API pro získání všech variant názvů anime
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
    try {
        const { username, password } = args.config;
        if (!username || !password) {
            return { streams: [] };
        }

        // Připravíme heslo a přihlásíme se
        const saltedPassword = await saltPassword(username, password);
        const token = await login(username, saltedPassword);

        // Získáme všechny varianty názvů
        let searchQueries = [];
        
        if (args.id.startsWith('kitsu:')) {
            // Kitsu ID
            const parts = args.id.split(':');
            const kitsuId = parts[1];
            const season = parts[2];
            const episode = parts[3];

            // Získáme názvy z Kitsu API
            const names = await getKitsuNames(kitsuId);
            
            console.log('Found names from Kitsu:', names);

            if (names.length === 0) {
                console.log('No names found from Kitsu, returning empty');
                return { streams: [] };
            }

            // Pro každý název vytvoříme search query
            if (args.type === 'series' && season && episode) {
                const seasonEp = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                searchQueries = names.map(name => `${name} ${seasonEp}`);
            } else {
                searchQueries = names;
            }
        } else if (args.id.startsWith('tt')) {
            const parts = args.id.split(':');
            const imdbId = parts[0];
            const season = parts[1];
            const episode = parts[2];

            // Získáme všechny názvy z AniList
            let names = await getAnimeNames(imdbId);
            
            // Pokud AniList nevrátí nic, zkusíme Cinemeta
            if (names.length === 0) {
                console.log('AniList returned no names, trying Cinemeta');
                names = await getCinemetaName(args.type, args.id);
            }

            console.log('Found names:', names);

            if (names.length === 0) {
                console.log('No names found, returning empty');
                return { streams: [] };
            }

            // Pro každý název vytvoříme search query
            if (args.type === 'series' && season && episode) {
                const seasonEp = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                searchQueries = names.map(name => `${name} ${seasonEp}`);
            } else {
                searchQueries = names;
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

        // Vytvoříme streamy pro každý výsledek
        const streams = await Promise.all(
            results.slice(0, 20).map(async (file) => {
                try {
                    const link = await getFileLink(file.ident, token);
                    if (link) {
                        return {
                            name: 'Webshare',
                            title: file.name,
                            url: link,
                            behaviorHints: {
                                bingeGroup: 'webshare-anime'
                            }
                        };
                    }
                    return null;
                } catch (error) {
                    console.error('Error getting link:', error.message);
                    return null;
                }
            })
        );

        return { streams: streams.filter(s => s !== null) };
    } catch (error) {
        console.error('Stream handler error:', error.message, error.stack);
        return { streams: [] };
    }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
