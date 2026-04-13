const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const TMDB_KEY = process.env.TMDB_KEY || '';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';

let SC_DOMAIN = 'https://streamingcommunityz.moe';
let SESSION = { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/123.0.0.0 Safari/537.36', cookies: '', inertia: '' };

const api = axios.create({ timeout: 10000 });

// Recupera le chiavi d'accesso iniziali (Cloudflare Bypass)
async function refreshSession() {
    try {
        const res = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get', url: SC_DOMAIN, maxTimeout: 60000
        });
        if (res.data.status === 'ok') {
            SESSION.cookies = res.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            SESSION.ua = res.data.solution.userAgent;
            const m = res.data.solution.response.match(/version&quot;:&quot;([^&]+)&quot;/);
            if (m) SESSION.inertia = m[1];
            console.log(`[📡] Sessione Webstreamr-Style Attiva. Inertia: ${SESSION.inertia}`);
        }
    } catch (e) { console.error(`[❌] Errore Sessione`); }
}

// Chiamata API "Pura" (Simula il caricamento dati interno)
async function callInternalApi(url) {
    const res = await api.get(url, {
        headers: {
            'User-Agent': SESSION.ua,
            'Cookie': SESSION.cookies,
            'X-Inertia': 'true',
            'X-Inertia-Version': SESSION.inertia,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json'
        },
        validateStatus: (s) => s < 500
    });

    if (res.status === 409) {
        SESSION.inertia = res.headers['x-inertia-version'] || SESSION.inertia;
        return callInternalApi(url); // Retry istantaneo con nuova versione
    }
    return res.data;
}

const builder = new addonBuilder({
    id: 'org.meezie.webstreamr',
    version: '11.0.0',
    name: 'Meezie Webstreamr-Engine',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    
    try {
        // 1. Risoluzione Titolo
        const tmdb = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`);
        const item = tmdb.data.movie_results?.[0] || tmdb.data.tv_results?.[0];
        if (!item) return { streams: [] };
        const title = item.title || item.name;

        // 2. Ricerca API (molto più veloce del browsing)
        const search = await callInternalApi(`${SC_DOMAIN}/it/search?q=${encodeURIComponent(title)}`);
        const results = search.props?.titles?.data || [];
        const match = results.find(r => r.name.toLowerCase().includes(title.toLowerCase()) || title.toLowerCase().includes(r.name.toLowerCase()));

        if (match) {
            let targetUrl = `${SC_DOMAIN}/it/watch/${match.id}`;
            
            // 3. Se è una serie, otteniamo l'ID episodio specifico
            if (type === 'series') {
                const sData = await callInternalApi(`${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`);
                const ep = sData.props.loadedSeason.episodes.find(e => String(e.number) === String(episode));
                if (ep) targetUrl += `?e=${ep.id}`;
            }

            // 4. Estrazione Master Playlist (vixcloud)
            const watchData = await callInternalApi(targetUrl);
            const embedUrl = watchData.props?.embedUrl;

            if (embedUrl) {
                const { data: embedHtml } = await axios.get(embedUrl, { headers: { 'User-Agent': SESSION.ua } });
                const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
                const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
                const vixId = embedUrl.split('/').pop();

                if (token && expires) {
                    // Restituiamo il formato Master Playlist che hai indicato
                    return { streams: [{
                        url: `https://vixcloud.co/playlist/${vixId}?token=${token}&expires=${expires}&h=1`,
                        title: `WEBSTREAMR-MODE 🚀 Multi-Res`,
                        behaviorHints: { notWebReady: true }
                    }]};
                }
            }
        }
    } catch (e) { console.error(`[💀] Crash: ${e.message}`); }
    return { streams: [] };
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });

(async () => {
    await refreshSession();
    setInterval(refreshSession, 20 * 60 * 1000);
})();
