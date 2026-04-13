const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const LISTA_URL        = 'https://raw.githubusercontent.com/susajenny747-hue/sc-addon-stremio/main/domini.txt';
const TMDB_KEY         = process.env.TMDB_KEY || ''; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';

let SC_DOMAIN          = 'https://streamingcommunityz.pet';
let SC_COOKIES         = '';
let SC_USERAGENT       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let SC_INERTIA_VERSION = '';

const getHeadersInertia = () => {
    const h = {
        'User-Agent': SC_USERAGENT,
        'Cookie': SC_COOKIES,
        'Referer': `${SC_DOMAIN}/`,
        'X-Inertia': 'true',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/plain, */*'
    };
    if (SC_INERTIA_VERSION) h['X-Inertia-Version'] = SC_INERTIA_VERSION;
    return h;
};

const cleanTitle = (t) => t.replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ').trim();

async function refreshSession() {
    try {
        console.log(`[🚀] FlareSolverr: Chiedo nuova sessione a ${SC_DOMAIN}`);
        
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: SC_DOMAIN, // Puntiamo alla home radice
            maxTimeout: 60000
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 70000 });

        if (response.data.status === 'ok') {
            SC_COOKIES = response.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            SC_USERAGENT = response.data.solution.userAgent;
            const html = response.data.solution.response;

            // Estrazione potenziata
            const versionMatch = html.match(/"version"\s*:\s*"([^"]+)"/) || html.match(/data-page='.*"version":"([^"]+)"/);
            if (versionMatch) {
                SC_INERTIA_VERSION = versionMatch[1];
                console.log(`[✅] Sessione Aggiornata! Versione: ${SC_INERTIA_VERSION}`);
            } else {
                console.log(`[⚠️] Versione non trovata, proverò senza X-Inertia-Version`);
                SC_INERTIA_VERSION = ''; 
            }
        }
    } catch (e) {
        console.error('[❌] Errore FlareSolverr:', e.message);
    }
}

async function searchSC(query) {
    const q = cleanTitle(query);
    const url = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(q)}`;
    try {
        const { data } = await axios.get(url, { headers: getHeadersInertia(), timeout: 10000 });
        return data?.props?.titles?.data || data?.props?.data || [];
    } catch (e) {
        if (e.response?.status === 409) {
            // Se fallisce col 409, proviamo a resettare la versione e riprovare una volta
            SC_INERTIA_VERSION = e.response.headers['x-inertia-version'] || '';
            console.log(`[🔄] 409 intercettato. Provo nuova versione: ${SC_INERTIA_VERSION}`);
            try {
                const { data } = await axios.get(url, { headers: getHeadersInertia(), timeout: 5000 });
                return data?.props?.titles?.data || data?.props?.data || [];
            } catch (err) { return []; }
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

const builder = new addonBuilder({
    id: 'org.meezie.stremio.sc',
    version: '1.6.5',
    name: 'Meezie SC (Fix 409)',
    description: 'StreamingCommunity via Railway FlareSolverr',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    try {
        const tmdbUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
        const tmdbRes = await axios.get(tmdbUrl).catch(() => null);
        const info = tmdbRes?.data.movie_results?.[0] || tmdbRes?.data.tv_results?.[0];
        if (!info) return { streams: [] };
        const titles = [info.title || info.name, info.original_title || info.original_name];
        let results = [];
        for (const t of titles) {
            if (!t) continue;
            results = await searchSC(t);
            if (results.length > 0) break;
        }
        if (results.length === 0) return { streams: [] };
        const match = results.find(r => r.type === (type === 'movie' ? 'movie' : 'tv')) || results[0];
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
    } catch (e) { return { streams: [] }; }
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });
refreshSession();
setInterval(refreshSession, 1000 * 60 * 60);
