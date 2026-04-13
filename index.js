const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const LISTA_URL = 'https://raw.githubusercontent.com/susajenny747-hue/Meezie/main/domini.txt';
const TMDB_KEY = process.env.TMDB_KEY || ''; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';

let SC_DOMAIN = 'https://streamingcommunityz.moe'; 
let SC_COOKIES = '';
let SC_USERAGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let SC_VERSION = ''; 

// Funzione di pulizia titoli migliorata
const cleanTitle = (t) => t.toLowerCase()
    .replace(/\(.*\)/g, '') // Rimuove parentesi
    .replace(/[^a-z0-9\s]/g, ' ') // Solo lettere e numeri
    .replace(/\s+/g, ' ')
    .trim();

async function refreshSession() {
    try {
        const { data: list } = await axios.get(LISTA_URL, { timeout: 5000 }).catch(() => ({ data: '' }));
        const liveDomain = list.split('\n').find(l => l.includes('streamingcommunity'))?.trim();
        if (liveDomain) SC_DOMAIN = liveDomain.replace(/\/$/, '');

        console.log(`[🚀] FlareSolverr: Check sessione su ${SC_DOMAIN}`);
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: `${SC_DOMAIN}/it`,
            maxTimeout: 60000
        }, { timeout: 100000 });

        if (response.data.status === 'ok') {
            SC_COOKIES = response.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            SC_USERAGENT = response.data.solution.userAgent;
            const html = response.data.solution.response;
            const versionMatch = html.match(/"version"\s*:\s*"([^"]+)"/) || html.match(/version&quot;:&quot;([^&]+)&quot;/);
            if (versionMatch) {
                SC_VERSION = versionMatch[1];
                console.log(`[✅] Bypass Cloudflare OK. Versione: ${SC_VERSION}`);
            }
        }
    } catch (e) {
        console.error('[❌] Errore Sessione:', e.message);
    }
}

async function searchSC(query) {
    const q = cleanTitle(query);
    const url = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(q)}`;
    
    const headers = {
        'User-Agent': SC_USERAGENT,
        'Cookie': SC_COOKIES,
        'X-Inertia': 'true',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
        'X-Inertia-Version': SC_VERSION
    };

    try {
        const { data } = await axios.get(url, { headers, timeout: 15000 });
        const results = data?.props?.titles?.data || data?.props?.data || [];
        console.log(`[🔎] Ricerca "${q}": Trovati ${results.length} risultati.`);
        return results;
    } catch (e) {
        if (e.response?.status === 409 && e.response.headers['x-inertia-version']) {
            SC_VERSION = e.response.headers['x-inertia-version'];
            headers['X-Inertia-Version'] = SC_VERSION;
            const { data } = await axios.get(url, { headers, timeout: 10000 });
            return data?.props?.titles?.data || data?.props?.data || [];
        }
        return [];
    }
}

async function getVixStream(videoId) {
    try {
        const { data: watchPage } = await axios.get(`${SC_DOMAIN}/it/watch/${videoId}`, {
            headers: { 'User-Agent': SC_USERAGENT, 'Cookie': SC_COOKIES, 'X-Inertia': 'true', 'X-Inertia-Version': SC_VERSION }
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

const builder = new addonBuilder({
    id: 'org.meezie.stremio.ultra',
    version: '2.1.0',
    name: 'Meezie SC Ultra',
    description: 'StreamingCommunity - Ricerca Ottimizzata',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    console.log(`[👤] Utente clicca su: ${id}`);
    
    try {
        const tmdbUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
        const tmdbRes = await axios.get(tmdbUrl).catch(() => null);
        
        // Proviamo prima il titolo italiano, poi quello originale se fallisce
        const movieInfo = tmdbRes?.data.movie_results?.[0];
        const tvInfo = tmdbRes?.data.tv_results?.[0];
        const info = movieInfo || tvInfo;

        if (!info) {
            console.log(`[❌] Nessuna info TMDB per ${imdbId}`);
            return { streams: [] };
        }

        let results = await searchSC(info.title || info.name);
        
        // Se non trova nulla col titolo ITA, prova il titolo originale
        if (results.length === 0 && (info.original_title || info.original_name)) {
            console.log(`[🔄] Riprovo con titolo originale...`);
            results = await searchSC(info.original_title || info.original_name);
        }

        if (results.length === 0) return { streams: [] };

        const match = results[0]; 
        console.log(`[🔗] Matching con: ${match.name} (ID: ${match.id})`);

        const titlePageUrl = type === 'movie' 
            ? `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}`
            : `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`;

        const { data: titleData } = await axios.get(titlePageUrl, {
            headers: { 'User-Agent': SC_USERAGENT, 'Cookie': SC_COOKIES, 'X-Inertia': 'true', 'X-Inertia-Version': SC_VERSION }
        });

        let videoId = null;
        if (type === 'movie') {
            videoId = titleData.props.title.videos[0]?.id;
        } else {
            const ep = titleData.props.loadedSeason.episodes.find(e => String(e.number) === String(episode));
            videoId = ep?.videos[0]?.id || ep?.id;
        }

        const streamUrl = videoId ? await getVixStream(videoId) : null;
        if (streamUrl) console.log(`[🚀] Link generato con successo!`);

        return {
            streams: streamUrl ? [{
                url: streamUrl,
                title: `SC 🚀 1080p\n(VixCloud)`,
                behaviorHints: { notWebReady: false }
            }] : []
        };
    } catch (e) {
        console.error(`[❌] Errore finale:`, e.message);
        return { streams: [] };
    }
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });
refreshSession();
setInterval(refreshSession, 1000 * 60 * 30);
