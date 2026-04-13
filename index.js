const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// ========== CONFIGURAZIONE ==========
const TMDB_KEY = process.env.TMDB_KEY || '';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';
let SC_DOMAIN = process.env.SC_DOMAIN || 'https://streamingcommunityz.moe';

// Stato sessione (cookie, user agent, inertia version)
let SESSION = { ua: '', cookies: '', inertia: '' };

// Cache con scadenza (15 minuti)
const CACHE = new Map();
const CACHE_TTL = 15 * 60 * 1000;

const api = axios.create({
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: (s) => s < 500
});

// ========== FUNZIONI DI SUPPORTO ==========
function setCache(key, value) {
    CACHE.set(key, { value, expires: Date.now() + CACHE_TTL });
}

function getCache(key) {
    const entry = CACHE.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
        CACHE.delete(key);
        return null;
    }
    return entry.value;
}

async function refreshSession() {
    console.log(`[📡] Sincronizzazione sessione con FlareSolverr: ${FLARESOLVERR_URL}`);
    try {
        const res = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: SC_DOMAIN,
            maxTimeout: 60000
        });
        if (res.data.status === 'ok') {
            const solution = res.data.solution;
            SESSION.cookies = solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            SESSION.ua = solution.userAgent;

            // Estrae la versione Inertia dalla risposta HTML
            const inertiaMatch = solution.response.match(/X-Inertia-Version" content="([^"]+)"/i) ||
                                 solution.response.match(/version&quot;:&quot;([^&]+)&quot;/);
            if (inertiaMatch) SESSION.inertia = inertiaMatch[1];
            else SESSION.inertia = '';

            console.log(`[✅] Sessione attiva. UA: ${SESSION.ua.substring(0, 50)}...`);
            return true;
        }
    } catch (e) {
        console.error(`[❌] Errore refresh sessione: ${e.message}`);
    }
    return false;
}

async function callInternalApi(url, retry = true) {
    try {
        const headers = {
            'User-Agent': SESSION.ua,
            'Cookie': SESSION.cookies,
            'Accept': 'application/json',
            'Referer': SC_DOMAIN + '/'
        };
        if (SESSION.inertia) {
            headers['X-Inertia'] = 'true';
            headers['X-Inertia-Version'] = SESSION.inertia;
            headers['X-Requested-With'] = 'XMLHttpRequest';
        }

        const res = await api.get(url, { headers });

        // Gestione redirect Inertia
        if (res.status === 409 || res.headers['x-inertia-location']) {
            const nextUrl = res.headers['x-inertia-location'] || url;
            console.log(`[🔄] Redirect Inertia verso: ${nextUrl}`);
            if (res.headers['x-inertia-version']) SESSION.inertia = res.headers['x-inertia-version'];
            return callInternalApi(nextUrl, false);
        }

        // Se la risposta è HTML ma contiene dati Inertia embedded
        if (typeof res.data === 'string' && !res.headers['content-type']?.includes('json')) {
            const jsonMatch = res.data.match(/<script id="__INERTIA_DATA" type="application\/json">(.*?)<\/script>/s);
            if (jsonMatch) return JSON.parse(jsonMatch[1]);
            throw new Error('Risposta non JSON e nessun dato Inertia trovato');
        }

        return res.data;
    } catch (err) {
        if (retry) {
            console.log(`[⚠️] Errore chiamata API, rinnovo sessione e riprovo...`);
            await refreshSession();
            return callInternalApi(url, false);
        }
        throw err;
    }
}

function extractTokenFromEmbed(html) {
    // Cerca token in vari formati possibili
    let match = html.match(/"token"\s*:\s*"([a-f0-9]+)"/i);
    if (!match) match = html.match(/token=([a-f0-9]+)/i);
    if (!match) match = html.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/i);
    if (!match) return null;

    const token = match[1];
    let expires = null;
    let expMatch = html.match(/"expires"\s*:\s*"(\d+)"/i);
    if (!expMatch) expMatch = html.match(/expires=(\d+)/i);
    if (expMatch) expires = expMatch[1];

    return { token, expires };
}

// ========== LOGICA ADDON ==========
const builder = new addonBuilder({
    id: 'org.meezie.sc-vix',
    version: '1.6.0',
    name: 'StreamingCommunity VixCloud',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
    // id può essere "tt1234567" o "tt1234567:1:2" per serie
    const [imdbId, season, episode] = id.split(':');

    const cached = getCache(id);
    if (cached) return { streams: [cached] };

    try {
        // 1. Recupera titolo da TMDB
        const tmdbRes = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
            params: {
                api_key: TMDB_KEY,
                external_source: 'imdb_id',
                language: 'it-IT'
            }
        });
        const item = tmdbRes.data.movie_results?.[0] || tmdbRes.data.tv_results?.[0];
        if (!item) {
            console.log(`[⚠️] Nessun risultato TMDB per ${imdbId}`);
            return { streams: [] };
        }

        const title = item.title || item.name;
        console.log(`[🔎] Ricerca: "${title}" (${type})`);

        // 2. Cerca su StreamingCommunity
        const searchUrl = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(title)}`;
        const searchData = await callInternalApi(searchUrl);

        // Estrae i risultati in modo flessibile
        let results = [];
        if (searchData.props?.titles?.data) results = searchData.props.titles.data;
        else if (searchData.props?.titles) results = searchData.props.titles;
        else if (searchData.props?.searchResults?.data) results = searchData.props.searchResults.data;
        else if (Array.isArray(searchData.props?.results)) results = searchData.props.results;
        else if (Array.isArray(searchData)) results = searchData;

        const match = results.find(r => {
            const rTitle = (r.name || r.title || '').toLowerCase();
            return rTitle.includes(title.toLowerCase()) || title.toLowerCase().includes(rTitle);
        });

        if (!match) {
            console.log(`[❌] Nessun titolo trovato su SC per "${title}"`);
            return { streams: [] };
        }

        let watchUrl = `${SC_DOMAIN}/it/watch/${match.id}`;
        // Gestione episodi per serie
        if (type === 'series' && season && episode) {
            try {
                const seasonUrl = `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`;
                const seasonData = await callInternalApi(seasonUrl);
                let episodes = [];
                if (seasonData.props?.loadedSeason?.episodes) episodes = seasonData.props.loadedSeason.episodes;
                else if (seasonData.props?.episodes) episodes = seasonData.props.episodes;
                else if (Array.isArray(seasonData)) episodes = seasonData;

                const ep = episodes.find(e => String(e.number) === String(episode));
                if (ep && ep.id) watchUrl += `?e=${ep.id}`;
                else console.log(`[⚠️] Episodio ${episode} non trovato, uso URL base`);
            } catch (err) {
                console.log(`[⚠️] Errore recupero episodi: ${err.message}`);
            }
        }

        // 3. Ottieni embedUrl dalla pagina watch
        const watchData = await callInternalApi(watchUrl);
        let embedUrl = watchData.props?.embedUrl;
        if (!embedUrl && watchData.props?.video?.embedUrl) embedUrl = watchData.props.video.embedUrl;
        if (!embedUrl) {
            console.log(`[❌] Nessun embedUrl trovato in ${watchUrl}`);
            return { streams: [] };
        }

        // 4. Scarica la pagina embed di VixCloud
        const embedHtmlRes = await axios.get(embedUrl, {
            headers: { 'User-Agent': SESSION.ua }
        });
        const embedHtml = embedHtmlRes.data;

        // 5. Estrai token
        const tokenData = extractTokenFromEmbed(embedHtml);
        if (!tokenData || !tokenData.token) {
            console.log(`[❌] Token non trovato nella embed page`);
            return { streams: [] };
        }

        const vixId = embedUrl.split('/').pop();
        let streamUrl = `https://vixcloud.co/playlist/${vixId}?token=${tokenData.token}`;
        if (tokenData.expires) streamUrl += `&expires=${tokenData.expires}`;
        streamUrl += '&h=1';

        const stream = {
            url: streamUrl,
            title: `🎬 StreamingCommunity VixCloud`
        };

        setCache(id, stream);
        console.log(`[✅] Stream generato per ${title}`);
        return { streams: [stream] };

    } catch (err) {
        console.error(`[💀] Errore per ${id}: ${err.message}`);
        return { streams: [] };
    }
});

// ========== AVVIO SERVER ==========
const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });

// Inizializza la sessione e rinnova ogni 20 minuti
(async () => {
    await refreshSession();
    setInterval(refreshSession, 20 * 60 * 1000);
})();