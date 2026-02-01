const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const needle = require('needle');
const md5 = require('cryptmd5');
const sha1 = require('sha1');
const xml2js = require('xml2js');
const parser = new xml2js.Parser();

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

const TMDB_API_KEY = '0eefece0676icing90e9977c1e47c9dd'; // Free TMDB API key

async function getShowName(type, id) {
    try {
        const baseId = id.split(':')[0];
        
        // Pokud je to IMDb ID (tt...), použijeme TMDB find endpoint
        if (baseId.startsWith('tt')) {
            const tmdbType = type === 'series' ? 'tv_results' : 'movie_results';
            const url = `https://api.themoviedb.org/3/find/${baseId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
            const resp = await needle('get', url);
            
            if (resp.body && resp.body[tmdbType] && resp.body[tmdbType].length > 0) {
                const result = resp.body[tmdbType][0];
                return type === 'series' ? result.name : result.title;
            }
        }
        
        // Fallback na Cinemeta
        const cinemataUrl = `https://v3-cinemeta.strem.io/meta/${type}/${baseId}.json`;
        const resp = await needle('get', cinemataUrl);
        
        if (resp.body && resp.body.meta && resp.body.meta.name) {
            return resp.body.meta.name;
        }
    } catch (error) {
        console.error('Error getting show name:', error.message);
    }
    return null;
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

        // Vytvoříme vyhledávací dotaz
        let query = '';
        
        // Pokud máme ID ve formátu tt1234567:1:1, získáme název z TMDB
        if (args.id.startsWith('tt') || args.id.startsWith('kitsu')) {
            const parts = args.id.split(':');
            const season = parts[1];
            const episode = parts[2];

            // Získáme název anime z TMDB
            const showName = await getShowName(args.type, args.id);
            console.log('Show name from TMDB:', showName);
            
            if (showName) {
                // Pro sérii přidáme season/episode
                if (args.type === 'series' && season && episode) {
                    query = `${showName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
                } else {
                    // Pro filmy použijeme jen název
                    query = showName;
                }
            } else {
                // Fallback pokud nezískáme název
                console.log('Could not get show name, returning empty');
                return { streams: [] };
            }
        } else {
            // Přímé vyhledávání
            query = args.id;
        }

        console.log('Searching for:', query);
        const results = await search(query, token);

        if (!results || results.length === 0) {
            return { streams: [] };
        }

        // Vytvoříme streamy pro každý výsledek
        const streams = await Promise.all(
            results.slice(0, 10).map(async (file) => {
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
        console.error('Stream handler error:', error.message);
        return { streams: [] };
    }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
