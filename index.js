const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const TMDB_KEY = process.env.TMDB_KEY || '';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';
const LISTA_URL = 'https://raw.githubusercontent.com/susajenny747-hue/Meezie/main/domini.txt';

let SC_DOMAIN = 'https://streamingcommunityz.moe';
let BROWSER_DATA = {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    cookies: '',
    inertiaVersion: ''
};

// Configura un'istanza axios che "sembra" un browser vero
const browser = axios.create({
    timeout: 15000,
    validateStatus: false
});

async function updateBrowserPersona() {
    console.log(`[🎭] Aggiorno l'identità browser via FlareSolverr...`);
    try {
        const res = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: SC_DOMAIN,
            maxTimeout: 60000
        });

        if (res.data.status === 'ok') {
            BROWSER_DATA.cookies = res.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            BROWSER_DATA.ua = res.data.solution.userAgent;
            
            // Estrazione chirurgica della versione Inertia
            const html = res.data.solution.response;
            const versionMatch = html.match(/version&quot;:&quot;([^&]+)&quot;/);
            if (versionMatch) {
                BROWSER_DATA.inertiaVersion = versionMatch[1];
                console.log(`[✅] Identità pronta! Versione Inertia: ${BROWSER_DATA.inertiaVersion}`);
            }
        }
    } catch (e) {
        console.error(`[❌] Impossibile ottenere identità browser: ${e.message}`);
    }
}

async function getJson(url) {
    const res = await browser.get(url, {
        headers: {
            'User-Agent': BROWSER_DATA.ua,
            'Cookie': BROWSER_DATA.cookies,
            'X-Inertia': 'true',
            'X-Inertia-Version': BROWSER_DATA.inertiaVersion,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/plain, */*',
            'Referer': SC_DOMAIN + '/'
        }
    });

    // Se Cloudflare ci ha bloccato o la versione è scaduta (409), proviamo a recuperare la nuova versione dagli header
    if (res.status === 409) {
        const newV = res.headers['x-inertia-version'];
        if (newV) {
            BROWSER_DATA.inertiaVersion = newV;
            return getJson(url); // Riprova istantaneamente
        }
    }
    return res.data;
}

const builder = new addonBuilder({
    id: 'org.meezie.veezie.style',
    version: '7.0.0',
    name: 'Meezie Browser-Mode',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    console.log(`[🔎] Ricerca per: ${imdbId}`);

    try {
        // Step 1: TMDB per il titolo italiano
        const { data: tmdb } = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`);
        const item = tmdb.movie_results?.[0] || tmdb.tv_results?.[0];
        if (!item) return { streams: [] };

        const title = item.title || item.name;
        
        // Step 2: Ricerca JSON (come fa l'app di SC o Veezie)
        const searchData = await getJson(`${SC_DOMAIN}/it/search?q=${encodeURIComponent(title)}`);
        const match = searchData.props?.titles?.data?.[0] || searchData.props?.data?.[0];

        if (match) {
            // Step 3: Ottieni l'embed URL
            const watchUrl = type === 'movie' ? 
                `${SC_DOMAIN}/it/watch/${match.id}` : 
                `${SC_DOMAIN}/it/watch/${match.id}?e=${episode}`;
            
            const pageData = await getJson(watchUrl);
            const embedUrl = pageData.props?.embedUrl;

            if (embedUrl) {
                // Step 4: Estrazione Token VixCloud
                const { data: embedHtml } = await axios.get(embedUrl, { headers: { 'User-Agent': BROWSER_DATA.ua } });
                const token = embedHtml.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
                const expires = embedHtml.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
                
                if (token) {
                    const finalUrl = `https://vixcloud.co/playlist/${embedUrl.split('/').pop()}?type=video&rendition=1080p&token=${token}&expires=${expires}`;
                    console.log(`[🚀] Link catturato!`);
                    return { streams: [{ url: finalUrl, title: `SC BROWSER-MODE 1080p` }] };
                }
            }
        }
    } catch (e) { console.error(`[💀] Errore nell'emulazione browser.`); }
    return { streams: [] };
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });

// Ciclo di vita: aggiorna il dominio e ruba l'identità all'avvio
(async () => {
    try {
        const { data } = await axios.get(LISTA_URL);
        const live = data.split('\n').find(l => l.includes('streamingcommunity'))?.trim();
        if (live) SC_DOMAIN = live.replace(/\/$/, '');
    } catch(e) {}
    
    await updateBrowserPersona();
    // Aggiorna l'identità ogni 30 minuti per evitare scadenze cookie
    setInterval(updateBrowserPersona, 30 * 60 * 1000);
})();
