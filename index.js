const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// ─── CONFIGURAZIONE ──────────────────────────────────────────────────────────
const LISTA_URL        = 'https://raw.githubusercontent.com/susajenny747-hue/sc-addon-stremio/main/domini.txt';
const TMDB_KEY         = process.env.TMDB_KEY || 'INSERISCI_QUI_TUA_KEY'; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191';

let SC_DOMAIN          = 'https://streamingcommunityz.pet';
let SC_COOKIES         = '';
let SC_USERAGENT       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let SC_INERTIA_VERSION = '';

// ─── UTILS: HEADER E PULIZIA ─────────────────────────────────────────────────
const getHeadersInertia = () => ({
    'User-Agent': SC_USERAGENT,
    'Cookie': SC_COOKIES,
    'Referer': `${SC_DOMAIN}/`,
    'X-Inertia': 'true',
    'X-Inertia-Version': SC_INERTIA_VERSION,
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json, text/plain, */*'
});

// Pulisce il titolo per la ricerca (es: "Spider-Man: No Way Home" -> "Spider Man No Way Home")
const cleanTitle = (t) => t.replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ').trim();

// ─── AGGIORNAMENTO DOMINIO E SESSIONE ────────────────────────────────────────
async function refreshSession() {
    try {
        // 1. Aggiorna Dominio da GitHub
        const { data: list } = await axios.get(LISTA_URL, { timeout: 5000 });
        const liveDomain = list.split('\n').find(l => l.includes('streamingcommunity'))?.trim();
        if (liveDomain) SC_DOMAIN = liveDomain.replace(/\/$/, '');

        // 2. Buca Cloudflare con FlareSolverr
        console.log(`[🔓] Tentativo accesso a: ${SC_DOMAIN}`);
        const { data } = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: `${SC_DOMAIN}/it`,
            maxTimeout: 60000
        });

        if (data.status === 'ok') {
            SC_COOKIES = data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            SC_USERAGENT = data.solution.userAgent;
            
            // Estrae la versione Inertia dall'HTML (fondamentale per le API JSON)
            const versionMatch = data.solution.response.match(/"version"\s*:\s*"([^"]+)"/);
            if (versionMatch) {
                SC_INERTIA_VERSION = versionMatch[1];
                console.log(`[✅] Sessione OK. Inertia-Version: ${SC_INERTIA_VERSION}`);
            }
        }
    } catch (e) {
        console.error('[❌] Errore inizializzazione:', e.message);
    }
}

// ─── MOTORE DI RICERCA ───────────────────────────────────────────────────────
async function searchSC(query) {
    const q = cleanTitle(query);
    const url = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(q)}`;
    try {
        const { data } = await axios.get(url, { headers: getHeadersInertia(), timeout: 10000 });
        return data?.props?.titles?.data || data?.props?.data || [];
    } catch (e) {
        return [];
    }
}

// ─── ESTRATTORE STREAM VIXCLOUD ──────────────────────────────────────────────
async function getVixStream(videoId) {
    try {
        // Chiediamo a SC l'URL dell'embed
        const { data: watchData } = await axios.get(`${SC_DOMAIN}/it/watch/${videoId}`, { 
            headers: getHeadersInertia() 
        });
        
        const embedUrl = watchData.props.embedUrl || `https://vixcloud.co/embed/${videoId}`;
        
        // Entriamo nell'embed di Vixcloud per prendere i token temporanei
        const { data: embedHtml } = await axios.get(embedUrl, { 
            headers: { 'User-Agent': SC_USERAGENT, 'Referer': SC_DOMAIN } 
        });

        const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
        const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
        const vixId = embedUrl.match(/embed\/(\d+)/)?.[1];

        if (token && expires && vixId) {
            return `https://vixcloud.co/playlist/${vixId}?type=video&rendition=1080p&token=${token}&expires=${expires}`;
        }
        
        // Fallback: cerca un m3u8 nudo nell'HTML
        const m3u8Match = embedHtml.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/);
        return m3u8Match ? m3u8Match[1] : null;
    } catch (e) {
        return null;
    }
}

// ─── ADDON DEFINITION ────────────────────────────────────────────────────────
const builder = new addonBuilder({
    id: 'org.meezie.stremio.sc',
    version: '1.5.0',
    name: 'Meezie SC (Robust Mode)',
    description: 'StreamingCommunity con fallback automatici e Inertia JSON',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
});

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    
    // 1. Dati TMDB (per avere i titoli in italiano e originale)
    const tmdbRes = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`).catch(() => null);
    const info = tmdbRes?.data.movie_results?.[0] || tmdbRes?.data.tv_results?.[0];
    if (!info) return { streams: [] };

    const titlesToTry = [info.title || info.name, info.original_title || info.original_name];
    let results = [];

    // 2. Ricerca con Fallback (come Veezie)
    for (const title of titlesToTry) {
        if (!title) continue;
        results = await searchSC(title);
        if (results.length > 0) break;
    }

    if (results.length === 0) return { streams: [] };

    // Filtriamo per tipo (film vs serie)
    const scType = type === 'movie' ? 'movie' : 'tv';
    const match = results.find(r => r.type === scType) || results[0];

    // 3. Recupero Video ID
    let videoId = null;
    try {
        const titleUrl = type === 'movie' 
            ? `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}`
            : `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`;
        
        const { data: pageData } = await axios.get(titleUrl, { headers: getHeadersInertia() });
        
        if (type === 'movie') {
            videoId = pageData.props.title.videos[0]?.id;
        } else {
            const ep = pageData.props.loadedSeason.episodes.find(e => String(e.number) === String(episode));
            videoId = ep?.videos[0]?.id;
        }
    } catch (e) { console.error('[🎬] ID non trovato'); }

    if (!videoId) return { streams: [] };

    // 4. Link Finale
    const streamUrl = await getVixStream(videoId);

    return {
        streams: streamUrl ? [{
            url: streamUrl,
            title: `StreamingCommunity 🚀\n1080p - VixCloud`,
            behaviorHints: { notWebReady: false }
        }] : []
    };
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });

refreshSession();
setInterval(refreshSession, 1000 * 60 * 60); // Refresh ogni ora
