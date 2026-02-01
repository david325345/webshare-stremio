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
        const parts = args.id.split(':');
        let query = parts[0];
        const season = parts[1];
        const episode = parts[2];

        if (args.type === 'series' && season && episode) {
            query = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
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
                            url: link
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
