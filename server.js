const axios = require('axios');
const NodeCache = require('node-cache');
const express = require('express');
const xml2js = require('xml2js');

const tokenCache = new NodeCache({ stdTTL: 3600 });
const searchCache = new NodeCache({ stdTTL: 600 });
const parser = new xml2js.Parser();

class WebshareAPI {
    constructor(username, password) {
        this.username = username;
        this.password = password;
        this.baseUrl = 'https://webshare.cz/api';
        this.token = null;
    }

    async login() {
        const cacheKey = `token_${this.username}`;
        const cached = tokenCache.get(cacheKey);
        if (cached) {
            this.token = cached;
            return cached;
        }

        const params = new URLSearchParams();
        params.append('username_or_email', this.username);
        params.append('password', this.password);
        params.append('keep_logged_in', '1');

        const response = await axios.post(`${this.baseUrl}/login/`, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const result = await parser.parseStringPromise(response.data);
        
        if (result.response.status[0] !== 'OK') {
            throw new Error('Login failed');
        }

        this.token = result.response.token[0];
        tokenCache.set(cacheKey, this.token);
        return this.token;
    }

    async search(query) {
        if (!this.token) await this.login();

        const cacheKey = `search_${this.username}_${query}`;
        const cached = searchCache.get(cacheKey);
        if (cached) return cached;

        try {
            const params = new URLSearchParams();
            params.append('what', query);
            params.append('category', 'video');
            params.append('sort', 'largest');
            params.append('wst', this.token);

            const response = await axios.post(`${this.baseUrl}/search/`, params, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            const result = await parser.parseStringPromise(response.data);
            
            if (result.response.status[0] !== 'OK') {
                return [];
            }

            const files = result.response.file || [];
            searchCache.set(cacheKey, files);
            return files;
        } catch (error) {
            console.error('Search error:', error.message);
            return [];
        }
    }

    async getFileLink(ident) {
        if (!this.token) await this.login();

        try {
            const params = new URLSearchParams();
            params.append('ident', ident);
            params.append('wst', this.token);

            const response = await axios.post(`${this.baseUrl}/file_link/`, params, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            const result = await parser.parseStringPromise(response.data);
            
            if (result.response.status[0] !== 'OK') {
                return null;
            }

            return result.response.link[0];
        } catch (error) {
            console.error('File link error:', error.message);
            return null;
        }
    }
}

async function getStreams(username, password, type, id) {
    try {
        const api = new WebshareAPI(username, password);
        
        const parts = id.split(':');
        let query = parts[0];
        const season = parts[1];
        const episode = parts[2];
        
        if (type === 'series' && season && episode) {
            query = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        }

        console.log('Searching for:', query);
        const results = await api.search(query);
        
        if (!results || results.length === 0) {
            console.log('No results found');
            return { streams: [] };
        }

        console.log(`Found ${results.length} results`);
        
        const streams = await Promise.all(
            results.slice(0, 10).map(async (file) => {
                try {
                    const ident = file.ident[0];
                    const name = file.name ? file.name[0] : (file.n ? file.n[0] : 'Unknown');
                    const link = await api.getFileLink(ident);
                    
                    return link ? {
                        name: `Webshare`,
                        title: name,
                        url: link
                    } : null;
                } catch (error) {
                    console.error('Error processing file:', error.message);
                    return null;
                }
            })
        );

        const validStreams = streams.filter(s => s !== null);
        console.log(`Returning ${validStreams.length} streams`);
        return { streams: validStreams };
    } catch (error) {
        console.error('Stream error:', error.message);
        return { streams: [] };
    }
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Webshare Stremio Addon</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            padding: 40px;
            max-width: 500px;
            width: 100%;
        }
        h1 {
            color: #333;
            margin-bottom: 30px;
            font-size: 28px;
            text-align: center;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            color: #333;
            font-weight: 600;
            margin-bottom: 8px;
        }
        input {
            width: 100%;
            padding: 12px;
            border: 2px solid #e0e0e0;
            border-radius: 10px;
            font-size: 15px;
            outline: none;
        }
        input:focus {
            border-color: #667eea;
        }
        button {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            margin-top: 10px;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
        }
        #result {
            margin-top: 20px;
            padding: 15px;
            border-radius: 10px;
            display: none;
            text-align: center;
        }
        #result.show {
            display: block;
            background: #d4edda;
            color: #155724;
            border: 2px solid #c3e6cb;
        }
        .install-link {
            display: inline-block;
            margin-top: 10px;
            padding: 10px 20px;
            background: #28a745;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-weight: 600;
        }
        .install-link:hover {
            background: #218838;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎌 Webshare Anime Addon</h1>
        <form id="form">
            <div class="form-group">
                <label>Webshare uživatelské jméno:</label>
                <input type="text" id="username" required>
            </div>
            <div class="form-group">
                <label>Webshare heslo:</label>
                <input type="password" id="password" required>
            </div>
            <button type="submit">🚀 Vygenerovat odkaz</button>
        </form>
        <div id="result"></div>
    </div>
    <script>
        document.getElementById('form').addEventListener('submit', (e) => {
            e.preventDefault();
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const creds = btoa(username + ':' + password);
            const url = 'stremio://' + window.location.host + '/' + creds + '/manifest.json';
            document.getElementById('result').className = 'show';
            document.getElementById('result').innerHTML = 
                '✅ Připraveno!<br><br><a href="' + url + '" class="install-link">📥 Nainstalovat</a>';
        });
    </script>
</body>
</html>
    `);
});

app.get('/:creds/manifest.json', (req, res) => {
    try {
        const [username] = Buffer.from(req.params.creds, 'base64').toString().split(':');
        
        const manifest = {
            id: `cz.webshare.${Buffer.from(username).toString('base64').substring(0, 10)}`,
            version: '1.0.0',
            name: 'Webshare Anime',
            description: 'Anime z Webshare.cz',
            resources: ['stream'],
            types: ['series', 'movie'],
            catalogs: [],
            idPrefixes: ['tt', 'kitsu']
        };
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.json(manifest);
    } catch (error) {
        res.status(400).json({ error: 'Invalid credentials' });
    }
});

app.get('/:creds/stream/:type/:id.json', async (req, res) => {
    try {
        const [username, password] = Buffer.from(req.params.creds, 'base64').toString().split(':');
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        
        const result = await getStreams(username, password, req.params.type, req.params.id.replace('.json', ''));
        res.json(result);
    } catch (error) {
        console.error('Stream endpoint error:', error);
        res.json({ streams: [] });
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
