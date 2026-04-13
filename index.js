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

        console.log(`[🌐] Dominio: ${SC_DOMAIN}`);
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get', url: `${SC_DOMAIN}/it`, maxTimeout: 60000
        }, { timeout: 100000 });

        if (response.data.status === 'ok') {
            SC_COOKIES = response.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            SC_USERAGENT = response.data.solution.userAgent;
            const html = response.data.solution.response;
            const versionMatch = html.match(/"version"\s*:\s*"([^"]+)"/) || html.match(/version&quot;:&quot;([^&]+)&quot;/);
            if (versionMatch) SC_VERSION = versionMatch[1];
            console.log(`[✅] Sessione OK. Versione Inertia: ${SC_VERSION}`);
        }
    } catch (e) { console.error('[❌] Errore Sessione:', e.message); }
}

async function searchSC(query) {
    const q = cleanTitle(query);
    const headers = { 
        'User-Agent': SC_USERAGENT, 
        'Cookie': SC_COOKIES, 
        'X-Inertia': 'true', 
        'X-Inertia-Version': SC_VERSION, 
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
    };
    try {
        console.log(`[🔎] Ricerca su SC: ${q}`);
        const { data } = await axios.get(`${SC_DOMAIN}/it/search?q=${encodeURIComponent(q)}`, { headers, timeout: 15000 });
        const results = data?.props?.titles?.data || data?.props?.data || [];
        console.log(`[📊] Risultati trovati: ${results.length}`);
        return results;
    } catch (e) {
        console.error(`[❌] Errore ricerca: ${e.response?.status || e.message}`);
        return [];
    }
}

async function getVixStream(scId, episodeId = null) {
    try {
        const watchUrl = episodeId ? `${SC_DOMAIN}/it/watch/${scId}?e=${episodeId}` : `${SC_DOMAIN}/it/watch/${scId}`;
        console.log(`[🛰️] Estrazione video da: ${watchUrl}`);
        const { data: watchPage } = await axios.get(watchUrl, {
            headers: { 'User-Agent': SC_USERAGENT, 'Cookie': SC_COOKIES, 'X-Inertia': 'true', 'X-Inertia-Version': SC_VERSION }
        });
        const embedUrl = watchPage.props.embedUrl;
        if (!embedUrl) return null;

        const { data: embedHtml } = await axios.get(embedUrl, { headers: { 'User-Agent': SC_USERAGENT, 'Referer': SC_DOMAIN } });
        const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
        const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
        if (token && expires) {
            return `https://vixcloud.co/playlist/${embedUrl.split('/').pop()}?type=video&rendition=1080p&token=${token}&expires=${expires}`;
        }
    } catch (e) { console.error(`[❌] Errore VixCloud: ${e.message}`); return null; }
}

const builder = new addonBuilder({
    id: 'org.meezie.sc.debug',
    version: '2.4.0',
    name: 'Meezie SC (Debug Mode)',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`[👤] Richiesta Stremio ID: ${id}`);
    const [imdbId, season, episode] = id.split(':');
    
    try {
        const tmdbUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
        const tmdbRes = await axios.get(tmdbUrl);
        const info = tmdbRes.data.movie_results?.[0] || tmdbRes.data.tv_results?.[0];
        
        if (!info) {
            console.log(`[❌] Titolo non trovato su TMDB`);
            return { streams: [] };
        }

        const title = info.title || info.name;
        console.log(`[🎬] Titolo TMDB: ${title}`);

        let results = await searchSC(title);
        if (results.length === 0 && (info.original_title || info.original_name)) {
            console.log(`[🔄] Riprovo con titolo originale...`);
            results = await searchSC(info.original_title || info.original_name);
        }

        if (results.length === 0) return { streams: [] };

        const match = results[0];
        console.log(`[🎯] Match trovato: ${match.name} (ID: ${match.id})`);

        let streamUrl = null;
        if (type === 'movie') {
            streamUrl = await getVixStream(match.id);
        } else {
            const seasonUrl = `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`;
            const { data: seasonData } = await axios.get(seasonUrl, {
                headers: { 'User-Agent': SC_USERAGENT, 'Cookie': SC_COOKIES, 'X-Inertia': 'true', 'X-Inertia-Version': SC_VERSION }
            });
            const epData = seasonData.props.loadedSeason.episodes.find(e => String(e.number) === String(episode));
            if (epData) {
                console.log(`[📺] Episodio trovato! ID Interno: ${epData.id}`);
                streamUrl = await getVixStream(match.id, epData.id);
            } else {
                console.log(`[❌] Episodio non trovato nella stagione`);
            }
        }

        if (streamUrl) console.log(`[🚀] STREAM PRONTO!`);
        return { streams: streamUrl ? [{ url: streamUrl, title: `SC 🚀 1080p` }] : [] };
    } catch (e) { 
        console.error(`[❌] Crash Handler: ${e.message}`);
        return { streams: [] }; 
    }
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });
refreshSession();
setInterval(refreshSession, 1000 * 60 * 30);
