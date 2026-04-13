const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const LISTA_URL = 'https://raw.githubusercontent.com/susajenny747-hue/Meezie/main/domini.txt';
const TMDB_KEY = process.env.TMDB_KEY || ''; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';

let SC_DOMAIN = 'https://streamingcommunityz.moe'; 
let SC_COOKIES = '';
let SC_USERAGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let SC_VERSION = ''; 

const cleanTitle = (t) => t.toLowerCase().replace(/\(.*\)/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

async function refreshSession() {
    try {
        const { data: list } = await axios.get(LISTA_URL).catch(() => ({ data: '' }));
        const liveDomain = list.split('\n').find(l => l.includes('streamingcommunity'))?.trim();
        if (liveDomain) SC_DOMAIN = liveDomain.replace(/\/$/, '');

        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get', url: `${SC_DOMAIN}/it`, maxTimeout: 60000
        }, { timeout: 100000 });

        if (response.data.status === 'ok') {
            SC_COOKIES = response.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            SC_USERAGENT = response.data.solution.userAgent;
            const html = response.data.solution.response;
            const versionMatch = html.match(/"version"\s*:\s*"([^"]+)"/) || html.match(/version&quot;:&quot;([^&]+)&quot;/);
            if (versionMatch) SC_VERSION = versionMatch[1];
            console.log(`[✅] Sessione Rigenerata. Versione: ${SC_VERSION}`);
        }
    } catch (e) { console.error('[❌] Errore FlareSolverr'); }
}

async function searchSC(query) {
    const q = cleanTitle(query);
    const url = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(q)}`;
    
    // Header quasi identici a un browser reale durante una navigazione Inertia
    const headers = {
        'User-Agent': SC_USERAGENT,
        'Cookie': SC_COOKIES,
        'Accept': 'application/json',
        'X-Inertia': 'true',
        'X-Inertia-Version': SC_VERSION,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${SC_DOMAIN}/it`
    };

    try {
        const { data } = await axios.get(url, { headers, timeout: 12000 });
        const results = data?.props?.titles?.data || data?.props?.data || [];
        console.log(`[🔎] Ricerca "${q}": Trovati ${results.length}`);
        return results;
    } catch (e) {
        // Se otteniamo 409, il sito vuole che aggiorniamo la versione o che "soffriamo" un redirect
        if (e.response?.status === 409) {
            const v = e.response.headers['x-inertia-version'];
            if (v) {
                console.log(`[🔄] Update Versione (409) -> ${v}`);
                SC_VERSION = v;
                headers['X-Inertia-Version'] = v;
                try {
                    const { data: retry } = await axios.get(url, { headers });
                    return retry?.props?.titles?.data || retry?.props?.data || [];
                } catch (err) { return []; }
            }
        }
        // Se fallisce ancora, proviamo a svuotare l'header X-Inertia-Version (alcuni siti lo digeriscono così)
        console.error(`[⚠️] Fallimento ricerca "${q}" (Status ${e.response?.status})`);
        return [];
    }
}

async function getVixStream(scId, episodeId = null) {
    try {
        const watchUrl = episodeId ? `${SC_DOMAIN}/it/watch/${scId}?e=${episodeId}` : `${SC_DOMAIN}/it/watch/${scId}`;
        const headers = { 
            'User-Agent': SC_USERAGENT, 
            'Cookie': SC_COOKIES, 
            'X-Inertia': 'true', 
            'X-Inertia-Version': SC_VERSION,
            'Referer': `${SC_DOMAIN}/it`
        };

        const { data: watchPage } = await axios.get(watchUrl, { headers });
        const embedUrl = watchPage.props.embedUrl;
        if (!embedUrl) return null;

        const { data: embedHtml } = await axios.get(embedUrl, { headers: { 'User-Agent': SC_USERAGENT, 'Referer': SC_DOMAIN } });
        const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
        const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
        if (token && expires) {
            const vixId = embedUrl.split('/').pop();
            return `https://vixcloud.co/playlist/${vixId}?type=video&rendition=1080p&token=${token}&expires=${expires}`;
        }
    } catch (e) { return null; }
}

const builder = new addonBuilder({
    id: 'org.meezie.sc.ultra.v3',
    version: '3.0.0',
    name: 'Meezie SC Ultra V3',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    console.log(`[👤] Richiesta Stremio: ${id}`);
    
    try {
        const tmdbUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
        const tmdbRes = await axios.get(tmdbUrl);
        const info = tmdbRes.data.movie_results?.[0] || tmdbRes.data.tv_results?.[0];
        if (!info) return { streams: [] };

        const titleIta = info.title || info.name;
        let results = await searchSC(titleIta);

        if (results.length === 0 && (info.original_title || info.original_name)) {
            results = await searchSC(info.original_title || info.original_name);
        }

        if (results.length === 0) {
            console.log(`[❌] Nessun risultato per: ${titleIta}`);
            return { streams: [] };
        }

        const match = results[0];
        console.log(`[🎯] Match: ${match.name}`);

        let streamUrl = null;
        if (type === 'movie') {
            streamUrl = await getVixStream(match.id);
        } else {
            const seasonUrl = `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`;
            const { data: seasonData } = await axios.get(seasonUrl, {
                headers: { 'User-Agent': SC_USERAGENT, 'Cookie': SC_COOKIES, 'X-Inertia': 'true', 'X-Inertia-Version': SC_VERSION }
            });
            const epData = seasonData.props.loadedSeason.episodes.find(e => String(e.number) === String(episode));
            if (epData) streamUrl = await getVixStream(match.id, epData.id);
        }

        return { 
            streams: streamUrl ? [{ url: streamUrl, title: `SC 🚀 1080p\n(VixCloud)` }] : [] 
        };
    } catch (e) { 
        console.error(`[❌] Errore Handler: ${e.message}`);
        return { streams: [] }; 
    }
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });
refreshSession();
setInterval(refreshSession, 1000 * 60 * 20); // Più frequente per evitare scadenze cookie
