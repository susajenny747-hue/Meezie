const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const LISTA_URL = 'https://raw.githubusercontent.com/susajenny747-hue/Meezie/main/domini.txt';
const TMDB_KEY = process.env.TMDB_KEY || ''; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';

let SC_DOMAIN = 'https://streamingcommunityz.moe'; 
let SC_USERAGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const cleanTitle = (t) => t.toLowerCase().replace(/\(.*\)/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

async function getLiveDomain() {
    try {
        const { data: list } = await axios.get(LISTA_URL);
        const liveDomain = list.split('\n').find(l => l.includes('streamingcommunity'))?.trim();
        if (liveDomain) SC_DOMAIN = liveDomain.replace(/\/$/, '');
        console.log(`[🌐] Target: ${SC_DOMAIN}`);
    } catch (e) { console.error('[⚠️] Impossibile aggiornare dominio'); }
}

async function flareRequest(url) {
    try {
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: url,
            maxTimeout: 60000
        }, { timeout: 120000 });

        if (response.data.status === 'ok') {
            return {
                html: response.data.solution.response,
                cookies: response.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; '),
                ua: response.data.solution.userAgent
            };
        }
    } catch (e) {
        console.error(`[❌] FlareSolverr Error: ${e.message}`);
    }
    return null;
}

async function searchSC(query) {
    const q = cleanTitle(query);
    const searchUrl = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(q)}`;
    console.log(`[🔎] Ricerca Profonda: ${q}`);

    const sol = await flareRequest(searchUrl);
    if (!sol) return [];

    try {
        // Estraiamo i dati direttamente dal codice HTML della pagina (Inertia data-page)
        const match = sol.html.match(/data-page="([^"]+)"/);
        if (match) {
            const jsonData = JSON.parse(match[1].replace(/&quot;/g, '"'));
            const results = jsonData.props.titles?.data || jsonData.props.data || [];
            console.log(`[📊] Trovati: ${results.length}`);
            return results;
        }
    } catch (e) {
        console.error(`[❌] Errore Parsing HTML: ${e.message}`);
    }
    return [];
}

async function getVixStream(scId, episodeId = null) {
    const watchUrl = episodeId ? `${SC_DOMAIN}/it/watch/${scId}?e=${episodeId}` : `${SC_DOMAIN}/it/watch/${scId}`;
    console.log(`[🛰️] Estrazione video...`);
    
    const sol = await flareRequest(watchUrl);
    if (!sol) return null;

    try {
        const match = sol.html.match(/data-page="([^"]+)"/);
        if (match) {
            const jsonData = JSON.parse(match[1].replace(/&quot;/g, '"'));
            const embedUrl = jsonData.props.embedUrl;
            if (!embedUrl) return null;

            // Richiesta finale per il token VixCloud
            const { data: embedHtml } = await axios.get(embedUrl, { 
                headers: { 'User-Agent': sol.ua, 'Referer': SC_DOMAIN } 
            });
            
            const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
            const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
            
            if (token && expires) {
                return `https://vixcloud.co/playlist/${embedUrl.split('/').pop()}?type=video&rendition=1080p&token=${token}&expires=${expires}`;
            }
        }
    } catch (e) { return null; }
}

const builder = new addonBuilder({
    id: 'org.meezie.sc.flare',
    version: '5.0.0',
    name: 'Meezie SC (Anti-Block)',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    console.log(`[👤] Richiesta: ${id}`);
    
    try {
        const tmdbUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
        const { data: tmdbRes } = await axios.get(tmdbUrl);
        const info = tmdbRes.movie_results?.[0] || tmdbRes.tv_results?.[0];
        if (!info) return { streams: [] };

        const title = info.title || info.name;
        const results = await searchSC(title);

        if (results.length > 0) {
            const match = results[0];
            let streamUrl = null;

            if (type === 'movie') {
                streamUrl = await getVixStream(match.id);
            } else {
                // Per le serie, passiamo per la pagina della stagione per l'ID episodio
                const sUrl = `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`;
                const sol = await flareRequest(sUrl);
                if (sol) {
                    const m = sol.html.match(/data-page="([^"]+)"/);
                    const sData = JSON.parse(m[1].replace(/&quot;/g, '"'));
                    const ep = sData.props.loadedSeason.episodes.find(e => String(e.number) === String(episode));
                    if (ep) streamUrl = await getVixStream(match.id, ep.id);
                }
            }

            return { streams: streamUrl ? [{ url: streamUrl, title: `SC 🚀 1080p` }] : [] };
        }
    } catch (e) { console.error(`[💀] Crash: ${e.message}`); }
    return { streams: [] };
});

getLiveDomain();
serveHTTP(builder.getInterface(), { port: process.env.PORT || 10000 });
