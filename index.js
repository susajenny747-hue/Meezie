const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const TMDB_KEY = process.env.TMDB_KEY || '';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || '';

let SC_DOMAIN = 'https://streamingcommunityz.moe';
let BROWSER = { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36', cookies: '' };

const api = axios.create({ timeout: 10000 });

// Sincronizzazione minima necessaria (Cookie e UA)
async function sync() {
    if (!FLARESOLVERR_URL) return;
    try {
        const res = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get', url: SC_DOMAIN, maxTimeout: 60000
        });
        if (res.data.status === 'ok') {
            BROWSER.cookies = res.data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
            BROWSER.ua = res.data.solution.userAgent;
            console.log(`[🔋] Motore SelfVix pronto.`);
        }
    } catch (e) { console.error(`[⚠️] Errore Sync`); }
}

const builder = new addonBuilder({
    id: 'org.meezie.selfvix',
    version: '13.0.0',
    name: 'Meezie SelfVix',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
    const [imdbId, season, episode] = id.split(':');
    
    try {
        // 1. TMDB per il titolo
        const tmdb = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`);
        const item = tmdb.data.movie_results?.[0] || tmdb.data.tv_results?.[0];
        if (!item) return { streams: [] };
        
        const query = item.title || item.name;
        console.log(`[🚀] SelfVix Search: ${query}`);

        // 2. Ricerca ignorando i redirect (usiamo l'API interna come SelfVix)
        const searchRes = await api.get(`${SC_DOMAIN}/api/search?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': BROWSER.ua, 'Cookie': BROWSER.cookies }
        });

        // Prendiamo il primo match utile
        const match = (searchRes.data.data || []).find(r => r.name.toLowerCase().includes(query.toLowerCase()));
        if (!match) return { streams: [] };

        // 3. Costruzione URL Embed diretta
        // SelfVix insegna: non passare dalla pagina 'watch', vai dritto all'iframe se possibile
        let videoId = match.id;
        let finalUrl = `${SC_DOMAIN}/iframe/${videoId}`;
        
        if (type === 'series') {
            // Per le serie dobbiamo comunque trovare l'ID episodio
            const slug = match.slug;
            const sRes = await api.get(`${SC_DOMAIN}/api/titles/${videoId}-${slug}/seasons/${season}`, {
                headers: { 'User-Agent': BROWSER.ua, 'Cookie': BROWSER.cookies }
            });
            const ep = (sRes.data.episodes || []).find(e => String(e.number) === String(episode));
            if (ep) finalUrl += `?episode=${ep.id}`;
        }

        // 4. Estrazione Master Playlist (Metodo Vix-Direct)
        const embedPage = await api.get(finalUrl, {
            headers: { 'User-Agent': BROWSER.ua, 'Cookie': BROWSER.cookies, 'Referer': SC_DOMAIN }
        });

        // Cerchiamo i parametri VixCloud nel sorgente dell'iframe
        const vixMatch = embedPage.data.match(/https:\/\/vixcloud\.co\/embed\/([^"? \n]+)/);
        if (vixMatch) {
            const vixId = vixMatch[1];
            // Richiediamo il token come fa SelfVix
            const vixRes = await axios.get(`https://vixcloud.co/api/source/${vixId}`, {
                headers: { 'Referer': 'https://vixcloud.co/', 'User-Agent': BROWSER.ua }
            });

            if (vixRes.data && vixRes.data.url) {
                return { streams: [{
                    url: vixRes.data.url, // URL Master .m3u8
                    title: `SelfVix 🎥 Multi-Res`,
                    behaviorHints: { notWebReady: true }
                }]};
            }
        }
    } catch (e) { console.error(`[💀] Errore: ${e.message}`); }
    return { streams: [] };
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });

(async () => {
    await sync();
    setInterval(sync, 20 * 60 * 1000);
})();
