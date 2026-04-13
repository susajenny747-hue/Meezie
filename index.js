const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const TMDB_KEY = process.env.TMDB_KEY || ''; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';
const LISTA_URL = 'https://raw.githubusercontent.com/susajenny747-hue/Meezie/main/domini.txt';

let SC_DOMAIN = 'https://streamingcommunityz.moe';
let INERTIA_VERSION = '';
let SESSION_COOKIES = '';
let USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// 1. FUNZIONE SNIFFER: Recupera la versione Inertia una volta sola
async function refreshSession() {
    try {
        console.log(`[📡] Sniffer: Recupero nuova sessione da ${SC_DOMAIN}...`);
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: SC_DOMAIN,
            maxTimeout: 60000
        });

        if (response.data.status === 'ok') {
            const html = response.data.solution.response;
            // Estraiamo la versione Inertia dall'attributo data-page
            const versionMatch = html.match(/data-page="[^"]+version&quot;:&quot;([^&]+)&quot;/);
            if (versionMatch) {
                INERTIA_VERSION = versionMatch[1];
                SESSION_COOKIES = response.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
                console.log(`[✅] Sessione Pronta! Versione: ${INERTIA_VERSION}`);
            }
        }
    } catch (e) {
        console.error(`[❌] Errore Sniffer: ${e.message}`);
    }
}

// 2. RICERCA TURBO: Usa axios puro con gli header giusti (0.5 secondi)
async function turboSearch(query) {
    const q = query.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    try {
        const res = await axios.get(`${SC_DOMAIN}/it/search?q=${encodeURIComponent(q)}`, {
            headers: {
                'X-Inertia': 'true',
                'X-Inertia-Version': INERTIA_VERSION,
                'X-Requested-With': 'XMLHttpRequest',
                'User-Agent': USER_AGENT,
                'Cookie': SESSION_COOKIES,
                'Referer': SC_DOMAIN
            }
        });

        // Se ricevi 409, la versione è scaduta: refresha e riprova una volta
        if (res.status === 409) {
            await refreshSession();
            return turboSearch(query);
        }

        const titles = res.data.props.titles?.data || [];
        console.log(`[📊] TurboSearch: Trovati ${titles.length} risultati.`);
        return titles;
    } catch (e) {
        if (e.response?.status === 409) {
            await refreshSession();
            return [];
        }
        console.error(`[❌] Errore TurboSearch`);
        return [];
    }
}

// 3. ESTRATTORE VIDEO (VixCloud)
async function getVixToken(scId, epId = null) {
    const url = epId ? `${SC_DOMAIN}/it/watch/${scId}?e=${epId}` : `${SC_DOMAIN}/it/watch/${scId}`;
    try {
        const res = await axios.get(url, {
            headers: {
                'X-Inertia': 'true',
                'X-Inertia-Version': INERTIA_VERSION,
                'User-Agent': USER_AGENT,
                'Cookie': SESSION_COOKIES
            }
        });

        const embedUrl = res.data.props.embedUrl;
        if (!embedUrl) return null;

        const { data: embedHtml } = await axios.get(embedUrl, { 
            headers: { 'User-Agent': USER_AGENT, 'Referer': SC_DOMAIN } 
        });
        
        const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
        const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
        
        if (token) {
            return `https://vixcloud.co/playlist/${embedUrl.split('/').pop()}?type=video&rendition=1080p&token=${token}&expires=${expires}`;
        }
    } catch (e) { return null; }
}

const builder = new addonBuilder({
    id: 'org.meezie.turbo',
    version: '6.0.0',
    name: 'Meezie Turbo SC',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    console.log(`[👤] Richiesta: ${imdbId}`);

    try {
        const tmdb = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`);
        const item = tmdb.data.movie_results?.[0] || tmdb.data.tv_results?.[0];
        if (!item) return { streams: [] };

        const results = await turboSearch(item.title || item.name);
        if (results.length > 0) {
            const match = results[0];
            let finalUrl = null;

            if (type === 'movie') {
                finalUrl = await getVixToken(match.id);
            } else {
                // Per le serie prendiamo l'ID episodio dalla pagina stagione
                const sUrl = `${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`;
                const sRes = await axios.get(sUrl, { headers: { 'X-Inertia': 'true', 'X-Inertia-Version': INERTIA_VERSION, 'Cookie': SESSION_COOKIES } });
                const ep = sRes.data.props.loadedSeason.episodes.find(e => String(e.number) === String(episode));
                if (ep) finalUrl = await getVixToken(match.id, ep.id);
            }

            if (finalUrl) {
                console.log(`[🚀] Link Generato con successo!`);
                return { streams: [{ url: finalUrl, title: 'SC Turbo 1080p' }] };
            }
        }
    } catch (e) { console.error(`[💀] Errore Stream`); }
    return { streams: [] };
});

// Avvio
(async () => {
    try {
        const { data } = await axios.get(LISTA_URL);
        const live = data.split('\n').find(l => l.includes('streamingcommunity'))?.trim();
        if (live) SC_DOMAIN = live.replace(/\/$/, '');
    } catch(e) {}
    
    await refreshSession(); // Esegue lo sniffer all'avvio
    serveHTTP(builder.getInterface(), { port: process.env.PORT || 10000 });
})();
