const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// ─── CONFIGURAZIONE VARIABILI ────────────────────────────────────────────────
const LISTA_URL        = 'https://raw.githubusercontent.com/susajenny747-hue/sc-addon-stremio/main/domini.txt';
const TMDB_KEY         = process.env.TMDB_KEY || ''; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';

let SC_DOMAIN          = 'https://streamingcommunityz.pet';
let SC_COOKIES         = '';
let SC_USERAGENT       = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
let SC_INERTIA_VERSION = '';

// ─── UTILS ───────────────────────────────────────────────────────────────────
const getHeadersInertia = () => ({
    'User-Agent': SC_USERAGENT,
    'Cookie': SC_COOKIES,
    'Referer': `${SC_DOMAIN}/`,
    'X-Inertia': 'true',
    'X-Inertia-Version': SC_INERTIA_VERSION,
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json, text/plain, */*'
});

const cleanTitle = (t) => t.replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ').trim();

// ─── AGGIORNAMENTO DOMINIO E SESSIONE CLOUDFLARE ─────────────────────────────
async function refreshSession() {
    try {
        console.log(`[🚀] Inizializzo bypass Cloudflare tramite: ${FLARESOLVERR_URL}`);
        
        // 1. Recupero dominio aggiornato
        try {
            const { data: list } = await axios.get(LISTA_URL, { timeout: 5000 });
            const liveDomain = list.split('\n').find(l => l.includes('streamingcommunity'))?.trim();
            if (liveDomain) SC_DOMAIN = liveDomain.replace(/\/$/, '');
        } catch (e) {
            console.warn('[⚠️] GitHub non raggiungibile, uso dominio predefinito.');
        }

        // 2. Chiamata FlareSolverr per ottenere Cookie e Inertia Version
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: `${SC_DOMAIN}/it`,
            maxTimeout: 60000
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 70000 });

        const data = response.data;

        if (data.status === 'ok') {
            SC_COOKIES = data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            SC_USERAGENT = data.solution.userAgent;
            
            // Cerchiamo la versione di Inertia nell'HTML (indispensabile per le chiamate JSON)
            const html = data.solution.response;
            const versionMatch = html.match(/"version"\s*:\s*"([^"]+)"/);
            
            if (versionMatch) {
                SC_INERTIA_VERSION = versionMatch[1];
                console.log(`[✅] Bypass riuscito! Dominio: ${SC_DOMAIN} | Inertia: ${SC_INERTIA_VERSION}`);
            }
        } else {
            console.error('[❌] FlareSolverr non è riuscito a risolvere la sfida:', data.message);
        }
    } catch (e) {
        console.error('[❌] Errore connessione FlareSolverr:', e.message);
    }
}

// ─── MOTORE DI RICERCA INTERNO ───────────────────────────────────────────────
async function searchSC(query) {
    const q = cleanTitle(query);
    const url = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(q)}`;
    try {
        const { data } = await axios.get(url, { headers: getHeadersInertia(), timeout: 10000 });
        return data?.props?.titles?.data || data?.props?.data || [];
    } catch (e) {
        console.warn(`[⚠️] Nessun risultato per "${q}" (Status: ${e.response?.status || e.message})`);
        return [];
    }
}

// ─── RISOLUTORE STREAM (VIXCLOUD) ────────────────────────────────────────────
async function getVixStream(videoId) {
    try {
        const { data: watchData } = await axios.get(`${SC_DOMAIN}/it/watch/${videoId}`, { 
            headers: getHeadersInertia() 
        });
        
        const embedUrl = watchData.props.embedUrl || `https://vixcloud.co/embed/${videoId}`;
        const { data: embedHtml } = await axios.get(embedUrl, { 
            headers: { 'User-Agent': SC_USERAGENT, 'Referer': SC_DOMAIN } 
        });

        // Estrazione token dinamici di Vixcloud
        const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
        const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
        const vixId = embedUrl.match(/embed\/(\d+)/)?.[1];

        if (token && expires && vixId) {
            return `https://vixcloud.co/playlist/${vixId}?type=video&rendition=1080p&token=${token}&expires=${expires}`;
        }
        // Fallback m3u8 diretto
        return embedHtml.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/)?.[1] || null;
    } catch (e) { return null; }
}

// ─── MANIFEST ADDON ──────────────────────────────────────────────────────────
const manifest = {
    id: 'org.meezie.stremio.sc',
    version: '1.6.2',
    name: 'Meezie SC (Robust Mode)',
    description: 'StreamingCommunity via Railway FlareSolverr',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

const builder = new addonBuilder(manifest);

// ─── HANDLER RICHIESTE VIDEO ──────────────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    console.log(`[🔎] Richiesta Stremio per: ${id}`);
    
    try {
        // 1. Traduzione ID Stremio -> Titolo Film/Serie tramite TMDB
        const tmdbUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
        const tmdbRes = await axios.get(tmdbUrl).catch(() => null);
        const info = tmdbRes?.data.movie_results?.[0] || tmdbRes?.data.tv_results?.[0];
        
        if (!info) {
            console.error('[❌] TMDB non ha trovato questo film. Verifica la KEY.');
            return { streams: [] };
        }

        const searchQueries = [info.title || info.name, info.original_title || info.original_name];
        let results = [];

        // 2. Ricerca ciclica (Fallback titolo originale se l'italiano fallisce)
        for (const query of searchQueries) {
            if (!query) continue;
            results = await searchSC(query);
            if (results.length > 0) break;
        }

        if (results.length === 0) return { streams: [] };

        // 3. Selezione del contenuto corretto
        const targetType = type === 'movie' ? 'movie' : 'tv';
        const match = results.find(r => r.type === targetType) || results[0];

        // 4. Navigazione verso il Video ID specifico
        const targetUrl = type === 'movie' 
            ? `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}`
            : `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`;
        
        const { data: pageData } = await axios.get(targetUrl, { headers: getHeadersInertia() });
        
        let videoId = null;
        if (type === 'movie') {
            videoId = pageData.props.title.videos[0]?.id;
        } else {
            const ep = pageData.props.loadedSeason.episodes.find(e => String(e.number) === String(episode));
            videoId = ep?.videos[0]?.id || ep?.id;
        }

        // 5. Estrazione link finale m3u8
        const streamUrl = videoId ? await getVixStream(videoId) : null;

        if (streamUrl) {
            console.log(`[✅] Link trovato per: ${match.name}`);
            return {
                streams: [{
                    url: streamUrl,
                    title: `StreamingCommunity 🚀\n1080p - VixCloud`,
                    behaviorHints: { notWebReady: false }
                }]
            };
        }
    } catch (e) {
        console.error('[❌] Errore critico nell\'handler:', e.message);
    }
    return { streams: [] };
});

// ─── AVVIO SERVER ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });

// Inizializzazione sessione e loop di aggiornamento ogni ora
refreshSession();
setInterval(refreshSession, 1000 * 60 * 60);
