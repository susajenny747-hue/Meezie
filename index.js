const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const LISTA_URL = 'https://raw.githubusercontent.com/susajenny747-hue/Meezie/main/domini.txt';
const TMDB_KEY = process.env.TMDB_KEY || ''; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';

let SC_DOMAIN = 'https://streamingcommunityz.moe'; 
let SC_USERAGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const cleanTitle = (t) => t.toLowerCase().replace(/\(.*\)/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

async function flareRequest(url) {
    try {
        console.log(`[☁️] FlareSolverr sta risolvendo: ${url.split('?')[0]}`);
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: url,
            maxTimeout: 30000 
        }, { timeout: 40000 });

        if (response.data.status === 'ok') {
            return {
                html: response.data.solution.response,
                ua: response.data.solution.userAgent
            };
        }
    } catch (e) {
        console.error(`[❌] FlareSolverr Errore: ${e.message}`);
    }
    return null;
}

async function searchSC(query) {
    const q = cleanTitle(query);
    const searchUrl = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(q)}`;
    const sol = await flareRequest(searchUrl);
    if (!sol) return [];

    try {
        const html = sol.html;
        const marker = 'data-page="';
        const startIdx = html.indexOf(marker);
        if (startIdx !== -1) {
            let content = html.substring(startIdx + marker.length);
            const endIdx = content.indexOf('"');
            content = content.substring(0, endIdx).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
            const jsonData = JSON.parse(content);
            const results = jsonData.props.titles?.data || jsonData.props.data || [];
            console.log(`[📊] Risultati per "${q}": ${results.length}`);
            return results;
        }
    } catch (e) {
        console.error(`[❌] Parsing fallito: ${e.message}`);
    }
    return [];
}

async function getVixStream(scId, episodeId = null) {
    const watchUrl = episodeId ? `${SC_DOMAIN}/it/watch/${scId}?e=${episodeId}` : `${SC_DOMAIN}/it/watch/${scId}`;
    const sol = await flareRequest(watchUrl);
    if (!sol) return null;

    try {
        const html = sol.html;
        const marker = 'data-page="';
        const startIdx = html.indexOf(marker);
        if (startIdx !== -1) {
            let content = html.substring(startIdx + marker.length);
            const endIdx = content.indexOf('"');
            content = content.substring(0, endIdx).replace(/&quot;/g, '"');
            const jsonData = JSON.parse(content);
            const embedUrl = jsonData.props.embedUrl;
            
            if (embedUrl) {
                const { data: embedHtml } = await axios.get(embedUrl, { 
                    headers: { 'User-Agent': sol.ua, 'Referer': SC_DOMAIN } 
                });
                const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
                const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
                if (token && expires) {
                    return `https://vixcloud.co/playlist/${embedUrl.split('/').pop()}?type=video&rendition=1080p&token=${token}&expires=${expires}`;
                }
            }
        }
    } catch (e) { console.error(`[❌] Stream error: ${e.message}`); }
    return null;
}

const builder = new addonBuilder({
    id: 'org.meezie.sc.final',
    version: '5.2.0',
    name: 'Meezie SC Gladiator',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
});

builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`[👤] Richiesta Stremio: ${id}`);
    const [imdbId, season, episode] = id.split(':');
    
    try {
        const tmdbUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
        const { data: tmdbRes } = await axios.get(tmdbUrl);
        const info = tmdbRes.movie_results?.[0] || tmdbRes.tv_results?.[0];
        if (!info) return { streams: [] };

        const results = await searchSC(info.title || info.name);
        if (results.length > 0) {
            const match = results[0];
            let streamUrl = null;

            if (type === 'movie') {
                streamUrl = await getVixStream(match.id);
            } else {
                const sUrl = `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`;
                const sol = await flareRequest(sUrl);
                if (sol) {
                    const m = sol.html.match(/data-page="([^"]+)"/);
                    const sData = JSON.parse(m[1].replace(/&quot;/g, '"'));
                    const ep = sData.props.loadedSeason.episodes.find(e => String(e.number) === String(episode));
                    if (ep) streamUrl = await getVixStream(match.id, ep.id);
                }
            }
            if (streamUrl) console.log(`[🚀] STREAM INVIATO!`);
            return { streams: streamUrl ? [{ url: streamUrl, title: `SC 🎥 1080p` }] : [] };
        }
    } catch (e) { console.error(`[💀] Handler Crash`); }
    return { streams: [] };
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });

// Aggiorna dominio all'avvio
(async () => {
    try {
        const { data } = await axios.get(LISTA_URL);
        const live = data.split('\n').find(l => l.includes('streamingcommunity'))?.trim();
        if (live) SC_DOMAIN = live.replace(/\/$/, '');
        console.log(`[🌐] Dominio attivo: ${SC_DOMAIN}`);
    } catch(e) {}
})();
