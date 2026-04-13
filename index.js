const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const TMDB_KEY = process.env.TMDB_KEY || ''; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';
let SC_DOMAIN = 'https://streamingcommunityz.pet';
let SC_COOKIES = '';
let SC_USERAGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const cleanTitle = (t) => t.replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ').trim();

// ─── SESSIONE CON TIMEOUT PIU' LUNGHI E GESTIONE ERRORI ──────────────────────
async function refreshSession() {
    try {
        console.log(`[🚀] FlareSolverr Start su ${SC_DOMAIN}`);
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: SC_DOMAIN,
            maxTimeout: 90000 // Aumentato a 90 secondi
        }, { timeout: 100000 });

        if (response.data.status === 'ok') {
            SC_COOKIES = response.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            SC_USERAGENT = response.data.solution.userAgent;
            console.log(`[✅] Sessione ottenuta correttamente.`);
        }
    } catch (e) {
        console.error('[❌] FlareSolverr non risponde in tempo. Uso cookie vecchi.');
    }
}

// ─── RICERCA STANDARD (Meno pignola sulla versione) ─────────────────────────
async function searchSC(query) {
    const q = cleanTitle(query);
    // Proviamo la ricerca senza header Inertia se questi falliscono
    try {
        const { data } = await axios.get(`${SC_DOMAIN}/api/search?q=${encodeURIComponent(q)}`, {
            headers: {
                'User-Agent': SC_USERAGENT,
                'Cookie': SC_COOKIES,
                'Accept': 'application/json'
            },
            timeout: 15000
        });
        return data.data || []; // StreamingCommunity API standard
    } catch (e) {
        console.warn(`[⚠️] Ricerca fallita per ${q}. Status: ${e.response?.status}`);
        return [];
    }
}

async function getVixStream(videoId) {
    try {
        const { data: embedHtml } = await axios.get(`${SC_DOMAIN}/iframe/${videoId}`, {
            headers: { 'User-Agent': SC_USERAGENT, 'Cookie': SC_COOKIES }
        });
        const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
        const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
        if (token && expires) {
            return `https://vixcloud.co/playlist/${videoId}?type=video&rendition=1080p&token=${token}&expires=${expires}`;
        }
        return embedHtml.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/)?.[1] || null;
    } catch (e) { return null; }
}

const builder = new addonBuilder({
    id: 'org.meezie.stremio.sc',
    version: '1.7.0',
    name: 'Meezie SC (Tank Mode)',
    description: 'StreamingCommunity - Versione ultra-stabile',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    console.log(`[🔎] Richiesta: ${id}`);
    
    try {
        const tmdbUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
        const tmdbRes = await axios.get(tmdbUrl).catch(() => null);
        const info = tmdbRes?.data.movie_results?.[0] || tmdbRes?.data.tv_results?.[0];
        if (!info) return { streams: [] };

        const results = await searchSC(info.title || info.name);
        if (!results.length) return { streams: [] };

        const match = results[0];
        // Per le serie SC usa un endpoint diverso
        let videoId = null;
        if (type === 'movie') {
            videoId = match.id;
        } else {
            const { data: tvData } = await axios.get(`${SC_DOMAIN}/api/titles/${match.id}/seasons/${season}`, {
                headers: { 'User-Agent': SC_USERAGENT, 'Cookie': SC_COOKIES }
            });
            const ep = tvData.episodes?.find(e => String(e.number) === String(episode));
            videoId = ep?.id;
        }

        const streamUrl = videoId ? await getVixStream(videoId) : null;
        return {
            streams: streamUrl ? [{
                url: streamUrl,
                title: `SC Tank 🚀\n1080p - VixCloud`,
                behaviorHints: { notWebReady: false }
            }] : []
        };
    } catch (e) { return { streams: [] }; }
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });
refreshSession();
setInterval(refreshSession, 1000 * 60 * 30); // Ogni 30 minuti
