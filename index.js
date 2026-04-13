const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const TMDB_KEY = process.env.TMDB_KEY || '';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';

let SC_DOMAIN = 'https://streamingcommunityz.moe';
let SESSION = { ua: '', cookies: '', inertia: '' };
const CACHE = new Map();

const api = axios.create({ 
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: (s) => s < 500 
});

const slugify = (s) => s ? s.toLowerCase().replace(/[^a-z0-9]/g, '') : '';

async function refreshSession() {
    console.log(`[📡] Sincronizzazione sessione (FlareSolverr)...`);
    try {
        const res = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get', url: SC_DOMAIN, maxTimeout: 60000
        });
        if (res.data.status === 'ok') {
            SESSION.cookies = res.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            SESSION.ua = res.data.solution.userAgent;
            const m = res.data.solution.response.match(/version&quot;:&quot;([^&]+)&quot;/);
            if (m) SESSION.inertia = m[1];
            console.log(`[✅] Sessione Webstreamr-Style Attiva. V: ${SESSION.inertia}`);
        }
    } catch (e) { console.error(`[❌] Errore Sessione`); }
}

async function callInternalApi(url) {
    const res = await api.get(url, {
        headers: {
            'User-Agent': SESSION.ua,
            'Cookie': SESSION.cookies,
            'X-Inertia': 'true',
            'X-Inertia-Version': SESSION.inertia,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json',
            'Referer': SC_DOMAIN + '/',
            'Origin': SC_DOMAIN
        }
    });

    // Se troviamo un redirect forzato (X-Inertia-Location), lo seguiamo
    if (res.headers['x-inertia-location']) {
        const nextUrl = res.headers['x-inertia-location'];
        console.log(`[🔄] Seguendo Redirect forzato: ${nextUrl}`);
        return callInternalApi(nextUrl);
    }

    // Se la versione è cambiata (409 Conflict)
    if (res.status === 409) {
        SESSION.inertia = res.headers['x-inertia-version'] || SESSION.inertia;
        return callInternalApi(url);
    }
    
    return res.data;
}

const builder = new addonBuilder({
    id: 'org.meezie.v12.5',
    version: '12.5.0',
    name: 'Meezie Guardian',
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

        console.log(`[🔎] Ricerca: ${title}`);
        const searchRes = await callInternalApi(`${SC_DOMAIN}/it/search?q=${encodeURIComponent(title)}`);
        
        // Estrazione dati sicura
        const results = searchRes.props?.titles?.data || searchRes.props?.titles || [];
        const match = Array.isArray(results) ? results.find(r => slugify(r.name || r.title).includes(slugify(title))) : null;

        if (match) {
            let watchUrl = `${SC_DOMAIN}/it/watch/${match.id}`;
            if (type === 'series') {
                const sData = await callInternalApi(`${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`);
                const ep = (sData.props?.loadedSeason?.episodes || []).find(e => String(e.number) === String(episode));
                if (ep) watchUrl += `?e=${ep.id}`;
            }

            const watchData = await callInternalApi(watchUrl);
            const embedUrl = watchData.props?.embedUrl;

            if (embedUrl) {
                const { data: embedHtml } = await axios.get(embedUrl, { headers: { 'User-Agent': SESSION.ua } });
                const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
                const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
                const vixId = embedUrl.split('/').pop();

                if (token) {
                    const stream = {
                        url: `https://vixcloud.co/playlist/${vixId}?token=${token}&expires=${expires}&h=1`,
                        title: `Meezie 🚀 Guardian VIX`
                    };
                    CACHE.set(id, stream);
                    console.log(`[🚀] STREAM PRONTO!`);
                    return { streams: [stream] };
                }
            }
        }
    } catch (e) { console.error(`[💀] Errore: ${e.message}`); }
    return { streams: [] };
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });

(async () => {
    await refreshSession();
    setInterval(refreshSession, 20 * 60 * 1000);
})();
