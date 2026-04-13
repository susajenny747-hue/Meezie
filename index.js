const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const TMDB_KEY = process.env.TMDB_KEY || ''; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';

// AGGIORNATO: Dominio attuale
let SC_DOMAIN = 'https://streamingcommunityz.moe'; 
let SC_COOKIES = '';
let SC_USERAGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let SC_VERSION = ''; 

const cleanTitle = (t) => t.replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ').trim();

// ─── AGGIORNAMENTO SESSIONE SUL DOMINIO CORRETTO ─────────────────────────────
async function refreshSession() {
    try {
        console.log(`[🚀] FlareSolverr: Accedo a ${SC_DOMAIN} per ottenere i nuovi parametri...`);
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: `${SC_DOMAIN}/it`,
            maxTimeout: 60000
        }, { timeout: 100000 });

        if (response.data.status === 'ok') {
            SC_COOKIES = response.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            SC_USERAGENT = response.data.solution.userAgent;
            
            // Estrazione versione Inertia
            const html = response.data.solution.response;
            const versionMatch = html.match(/"version"\s*:\s*"([^"]+)"/);
            if (versionMatch) {
                SC_VERSION = versionMatch[1];
                console.log(`[✅] Sessione OK su ${SC_DOMAIN} | Versione: ${SC_VERSION}`);
            }
        }
    } catch (e) {
        console.error('[❌] Errore FlareSolverr (Dominio errato o timeout):', e.message);
    }
}

// ─── RICERCA ─────────────────────────────────────────────────────────────────
async function searchSC(query) {
    const q = cleanTitle(query);
    const url = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(q)}`;
    
    try {
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': SC_USERAGENT,
                'Cookie': SC_COOKIES,
                'X-Inertia': 'true',
                'X-Inertia-Version': SC_VERSION,
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json'
            },
            timeout: 15000
        });
        return data?.props?.titles?.data || data?.props?.data || [];
    } catch (e) {
        console.warn(`[⚠️] Ricerca fallita per ${q}. Status: ${e.response?.status}`);
        return [];
    }
}

// ─── ESTRATTORE VIDEO ────────────────────────────────────────────────────────
async function getVixStream(videoId) {
    try {
        const { data: watchPage } = await axios.get(`${SC_DOMAIN}/it/watch/${videoId}`, {
            headers: {
                'User-Agent': SC_USERAGENT,
                'Cookie': SC_COOKIES,
                'X-Inertia': 'true',
                'X-Inertia-Version': SC_VERSION
            }
        });

        const embedUrl = watchPage.props.embedUrl;
        if (!embedUrl) return null;

        const { data: embedHtml } = await axios.get(embedUrl, {
            headers: { 'User-Agent': SC_USERAGENT, 'Referer': SC_DOMAIN }
        });

        const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
        const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
        
        if (token && expires) {
            const vixId = embedUrl.split('/').pop();
            return `https://vixcloud.co/playlist/${vixId}?type=video&rendition=1080p&token=${token}&expires=${expires}`;
        }
        return null;
    } catch (e) { return null; }
}

// ─── CONFIGURAZIONE ADDON ────────────────────────────────────────────────────
const builder = new addonBuilder({
    id: 'org.meezie.stremio.moe',
    version: '1.8.0',
    name: 'Meezie SC (Moe Edition)',
    description: 'StreamingCommunity aggiornato a .moe',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    console.log(`[🔎] Richiesta: ${id} su dominio .moe`);
    
    try {
        const tmdbUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
        const tmdbRes = await axios.get(tmdbUrl).catch(() => null);
        const info = tmdbRes?.data.movie_results?.[0] || tmdbRes?.data.tv_results?.[0];
        
        if (!info) return { streams: [] };

        const results = await searchSC(info.title || info.name);
        if (!results || results.length === 0) return { streams: [] };

        const match = results.find(r => r.type === (type === 'movie' ? 'movie' : 'tv')) || results[0];

        const titlePageUrl = type === 'movie' 
            ? `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}`
            : `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`;

        const { data: titleData } = await axios.get(titlePageUrl, {
            headers: {
                'User-Agent': SC_USERAGENT,
                'Cookie': SC_COOKIES,
                'X-Inertia': 'true',
                'X-Inertia-Version': SC_VERSION
            }
        });

        let videoId = null;
        if (type === 'movie') {
            videoId = titleData.props.title.videos[0]?.id;
        } else {
            const ep = titleData.props.loadedSeason.episodes.find(e => String(e.number) === String(episode));
            videoId = ep?.videos[0]?.id || ep?.id;
        }

        const streamUrl = videoId ? await getVixStream(videoId) : null;

        return {
            streams: streamUrl ? [{
                url: streamUrl,
                title: `SC (.moe) 🚀\n1080p - VixCloud`,
                behaviorHints: { notWebReady: false }
            }] : []
        };
    } catch (e) {
        return { streams: [] };
    }
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });

// Prima inizializzazione
refreshSession();
// Refresh ogni 30 minuti
setInterval(refreshSession, 1000 * 60 * 30);
