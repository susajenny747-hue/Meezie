const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const TMDB_KEY = process.env.TMDB_KEY || '';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';
const LISTA_URL = 'https://raw.githubusercontent.com/susajenny747-hue/Meezie/main/domini.txt';

let SC_DOMAIN = 'https://streamingcommunityz.moe';
let BROWSER_DATA = { ua: '', cookies: '', inertia: '' };
const CACHE = new Map(); // Per rendere i link istantanei al secondo click

const api = axios.create({ timeout: 10000, validateStatus: false });

async function getBrowserData() {
    console.log(`[🎭] Recupero chiavi d'accesso (FlareSolverr)...`);
    try {
        const res = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get', url: SC_DOMAIN, maxTimeout: 60000
        });
        if (res.data.status === 'ok') {
            BROWSER_DATA.cookies = res.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            BROWSER_DATA.ua = res.data.solution.userAgent;
            const m = res.data.solution.response.match(/version&quot;:&quot;([^&]+)&quot;/);
            if (m) BROWSER_DATA.inertia = m[1];
            console.log(`[✅] Chiavi ottenute! Versione: ${BROWSER_DATA.inertia}`);
        }
    } catch (e) { console.error(`[❌] Errore FlareSolverr: ${e.message}`); }
}

async function scRequest(url) {
    const res = await api.get(url, {
        headers: {
            'User-Agent': BROWSER_DATA.ua,
            'Cookie': BROWSER_DATA.cookies,
            'X-Inertia': 'true',
            'X-Inertia-Version': BROWSER_DATA.inertia,
            'Referer': SC_DOMAIN + '/'
        }
    });
    if (res.status === 409 && res.headers['x-inertia-version']) {
        BROWSER_DATA.inertia = res.headers['x-inertia-version'];
        return scRequest(url);
    }
    return res.data;
}

const builder = new addonBuilder({
    id: 'org.meezie.v8',
    version: '8.0.0',
    name: 'Meezie SC V8',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
    if (CACHE.has(id)) {
        console.log(`[⚡] Link servito da Cache per: ${id}`);
        return { streams: [CACHE.get(id)] };
    }

    console.log(`[🔎] Avvio ricerca per: ${id}`);
    const [imdbId, season, episode] = id.split(':');

    try {
        // 1. Titolo da TMDB
        const tmdbRes = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`);
        const item = tmdbRes.data.movie_results?.[0] || tmdbRes.data.tv_results?.[0];
        if (!item) return { streams: [] };
        const title = item.title || item.name;
        console.log(`[🎬] Titolo TMDB: ${title}`);

        // 2. Ricerca su SC
        const searchRes = await scRequest(`${SC_DOMAIN}/it/search?q=${encodeURIComponent(title)}`);
        const match = searchRes.props?.titles?.data?.[0] || searchRes.props?.data?.[0];
        if (!match) { console.log(`[⚠️] Nessun match su SC`); return { streams: [] }; }
        console.log(`[✅] Trovato su SC: ${match.slug} (ID: ${match.id})`);

        // 3. Pagina Watch / Episodio
        let watchUrl = `${SC_DOMAIN}/it/watch/${match.id}`;
        if (type === 'series') {
            console.log(`[🎞️] Cerco episodio ${episode} stagione ${season}...`);
            const seasonData = await scRequest(`${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`);
            const epObj = seasonData.props.loadedSeason.episodes.find(e => String(e.number) === String(episode));
            if (epObj) watchUrl += `?e=${epObj.id}`;
        }

        // 4. Estrazione Embed e Token
        const pageData = await scRequest(watchUrl);
        const embedUrl = pageData.props?.embedUrl;
        if (!embedUrl) { console.log(`[❌] Embed URL non trovato`); return { streams: [] }; }

        console.log(`[🔗] Embed trovato: ${embedUrl.substring(0, 40)}...`);
        const { data: embedHtml } = await axios.get(embedUrl, { headers: { 'User-Agent': BROWSER_DATA.ua } });
        const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
        const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];

        if (token) {
            const videoUrl = `https://vixcloud.co/playlist/${embedUrl.split('/').pop()}?type=video&rendition=1080p&token=${token}&expires=${expires}`;
            const stream = { url: videoUrl, title: `SC V8 🎥 1080p` };
            CACHE.set(id, stream); // Salva in cache
            console.log(`[🚀] STREAM INVIATO CON SUCCESSO!`);
            return { streams: [stream] };
        }

    } catch (e) { console.error(`[💀] Crash: ${e.message}`); }
    return { streams: [] };
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });

(async () => {
    try {
        const { data } = await axios.get(LISTA_URL);
        const live = data.split('\n').find(l => l.includes('streamingcommunity'))?.trim();
        if (live) SC_DOMAIN = live.replace(/\/$/, '');
        console.log(`[🌐] Target: ${SC_DOMAIN}`);
    } catch(e) {}
    await getBrowserData();
    setInterval(getBrowserData, 20 * 60 * 1000); // Refresh ogni 20 min
})();
