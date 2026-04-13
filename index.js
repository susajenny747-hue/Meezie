const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const LISTA_URL        = 'https://raw.githubusercontent.com/susajenny747-hue/sc-addon-stremio/main/domini.txt';
const TMDB_KEY         = process.env.TMDB_KEY || ''; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';

let SC_DOMAIN          = 'https://streamingcommunityz.pet';
let SC_COOKIES         = '';
let SC_USERAGENT       = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
let SC_INERTIA_VERSION = '';

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

async function refreshSession() {
    try {
        console.log(`[🚀] Inizializzo bypass Cloudflare tramite: ${FLARESOLVERR_URL}`);
        
        try {
            const { data: list } = await axios.get(LISTA_URL, { timeout: 5000 });
            const liveDomain = list.split('\n').find(l => l.includes('streamingcommunity'))?.trim();
            if (liveDomain) SC_DOMAIN = liveDomain.replace(/\/$/, '');
        } catch (e) {}

        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: `${SC_DOMAIN}/it`,
            maxTimeout: 60000
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 70000 });

        const data = response.data;

        if (data.status === 'ok') {
            SC_COOKIES = data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            SC_USERAGENT = data.solution.userAgent;
            
            const html = data.solution.response;
            
            // --- NUOVA LOGICA ESTRAZIONE VERSIONE (Più Robusta per evitare 409) ---
            let version = '';
            // Prova 1: Cerca nel tag data-page (formato JSON)
            const dataPageMatch = html.match(/data-page="([^"]+)"/);
            if (dataPageMatch) {
                try {
                    const decodedJson = JSON.parse(dataPageMatch[1].replace(/&quot;/g, '"'));
                    version = decodedJson.version;
                } catch (e) {}
            }
            
            // Prova 2: Cerca direttamente "version":"..."
            if (!version) {
                const versionMatch = html.match(/"version"\s*:\s*"([^"]+)"/);
                if (versionMatch) version = versionMatch[1];
            }

            if (version) {
                SC_INERTIA_VERSION = version;
                console.log(`[✅] Bypass riuscito! Dominio: ${SC_DOMAIN} | Inertia: ${SC_INERTIA_VERSION}`);
            } else {
                console.error('[⚠️] Impossibile trovare Inertia Version! Il 409 persisterà.');
            }
        }
    } catch (e) {
        console.error('[❌] Errore connessione FlareSolverr:', e.message);
    }
}

async function searchSC(query) {
    const q = cleanTitle(query);
    const url = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(q)}`;
    try {
        const { data } = await axios.get(url, { headers: getHeadersInertia(), timeout: 10000 });
        return data?.props?.titles?.data || data?.props?.data || [];
    } catch (e) {
        // Se riceviamo 409, forziamo un refresh della sessione per la prossima volta
        if (e.response?.status === 409) {
            console.warn(`[!] Rilevato 409 per "${q}". La versione Inertia è scaduta. Refresh in corso...`);
            refreshSession();
        } else {
            console.warn(`[⚠️] Errore ricerca "${q}": Status ${e.response?.status || e.message}`);
        }
        return [];
    }
}

async function getVixStream(videoId) {
    try {
        const { data: watchData } = await axios.get(`${SC_DOMAIN}/it/watch/${videoId}`, { 
            headers: getHeadersInertia() 
        });
        
        const embedUrl = watchData.props.embedUrl || `https://vixcloud.co/embed/${videoId}`;
        const { data: embedHtml } = await axios.get(embedUrl, { 
            headers: { 'User-Agent': SC_USERAGENT, 'Referer': SC_DOMAIN } 
        });

        const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
        const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
        const vixId = embedUrl.match(/embed\/(\d+)/)?.[1];

        if (token && expires && vixId) {
            return `https://vixcloud.co/playlist/${vixId}?type=video&rendition=1080p&token=${token}&expires=${expires}`;
        }
        return embedHtml.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/)?.[1] || null;
    } catch (e) { return null; }
}

const manifest = {
    id: 'org.meezie.stremio.sc',
    version: '1.6.3',
    name: 'Meezie SC (Bypass 409)',
    description: 'StreamingCommunity via Railway FlareSolverr',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    console.log(`[🔎] Richiesta: ${id}`);
    
    try {
        const tmdbUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
        const tmdbRes = await axios.get(tmdbUrl).catch(() => null);
        const info = tmdbRes?.data.movie_results?.[0] || tmdbRes?.data.tv_results?.[0];
        
        if (!info) return { streams: [] };

        const searchQueries = [info.title || info.name, info.original_title || info.original_name];
        let results = [];

        for (const query of searchQueries) {
            if (!query) continue;
            results = await searchSC(query);
            if (results.length > 0) break;
        }

        if (results.length === 0) return { streams: [] };

        const targetType = type === 'movie' ? 'movie' : 'tv';
        const match = results.find(r => r.type === targetType) || results[0];

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

        const streamUrl = videoId ? await getVixStream(videoId) : null;

        return {
            streams: streamUrl ? [{
                url: streamUrl,
                title: `StreamingCommunity 🚀\n1080p - VixCloud`,
                behaviorHints: { notWebReady: false }
            }] : []
        };
    } catch (e) {
        return { streams: [] };
    }
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });

refreshSession();
setInterval(refreshSession, 1000 * 60 * 60);
