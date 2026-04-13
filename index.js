const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const TMDB_KEY = process.env.TMDB_KEY || ''; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';
const LISTA_URL = 'https://raw.githubusercontent.com/susajenny747-hue/Meezie/main/domini.txt';

let SC_DOMAIN = 'https://streamingcommunityz.moe';
let BROWSER = { ua: '', cookies: '', inertia: '' };
const CACHE = new Map();

const api = axios.create({ timeout: 15000 });
const slugify = (s) => s ? s.toLowerCase().replace(/[^a-z0-9]/g, '') : '';

async function syncBrowser() {
    console.log(`[📡] Sincronizzazione sessione...`);
    try {
        const res = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get', url: SC_DOMAIN, maxTimeout: 60000
        });
        if (res.data.status === 'ok') {
            BROWSER.cookies = res.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            BROWSER.ua = res.data.solution.userAgent;
            const m = res.data.solution.response.match(/version&quot;:&quot;([^&]+)&quot;/);
            if (m) BROWSER.inertia = m[1];
            console.log(`[✅] Sessione Pronta (V: ${BROWSER.inertia})`);
        }
    } catch (e) { console.error(`[❌] Errore FlareSolverr`); }
}

async function fetchSC(url) {
    const res = await api.get(url, {
        headers: {
            'User-Agent': BROWSER.ua,
            'Cookie': BROWSER.cookies,
            'X-Inertia': 'true',
            'X-Inertia-Version': BROWSER.inertia,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json',
            'Referer': SC_DOMAIN + '/'
        }
    });
    if (res.status === 409) {
        BROWSER.inertia = res.headers['x-inertia-version'] || BROWSER.inertia;
        return fetchSC(url);
    }
    return res.data;
}

const builder = new addonBuilder({
    id: 'org.meezie.pro.v10',
    version: '10.0.1',
    name: 'Meezie Pro SC',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [] 
});

builder.defineStreamHandler(async ({ type, id }) => {
    if (CACHE.has(id)) return { streams: [CACHE.get(id)] };
    
    const [imdbId, season, episode] = id.split(':');
    try {
        const tmdb = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`);
        const item = tmdb.data.movie_results?.[0] || tmdb.data.tv_results?.[0];
        if (!item) return { streams: [] };
        
        const title = item.title || item.name;
        const searchData = await fetchSC(`${SC_DOMAIN}/it/search?q=${encodeURIComponent(title)}`);
        const results = searchData.props?.titles?.data || searchData.props?.titles || [];
        const match = results.find(r => slugify(r.name || r.title).includes(slugify(title)));

        if (!match) return { streams: [] };

        let watchUrl = `${SC_DOMAIN}/it/watch/${match.id}`;
        if (type === 'series') {
            const sData = await fetchSC(`${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`);
            const epObj = (sData.props?.loadedSeason?.episodes || []).find(e => String(e.number) === String(episode));
            if (epObj) watchUrl += `?e=${epObj.id}`;
        }

        const page = await fetchSC(watchUrl);
        const embedUrl = page.props?.embedUrl;

        if (embedUrl) {
            const { data: html } = await axios.get(embedUrl, { headers: { 'User-Agent': BROWSER.ua } });
            const token = html.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
            const expires = html.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
            const vixId = embedUrl.split('/').pop();

            if (token && expires) {
                const stream = { 
                    url: `https://vixcloud.co/playlist/${vixId}?token=${token}&expires=${expires}&h=1`, 
                    title: `Meezie 🚀 Vix-Master`
                };
                CACHE.set(id, stream);
                return { streams: [stream] };
            }
        }
    } catch (e) { console.error(`[💀] Errore: ${e.message}`); }
    return { streams: [] };
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });

(async () => {
    try {
        const { data } = await axios.get(LISTA_URL);
        const live = data.split('\n').find(l => l.includes('streamingcommunity'))?.trim();
        if (live) SC_DOMAIN = live.replace(/\/$/, '');
    } catch(e) {}
    await syncBrowser();
    setInterval(syncBrowser, 25 * 60 * 1000);
})();
