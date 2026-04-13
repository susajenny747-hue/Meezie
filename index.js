const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const LISTA_URL        = 'https://raw.githubusercontent.com/susajenny747-hue/sc-addon-stremio/main/domini.txt';
const TMDB_KEY         = process.env.TMDB_KEY || ''; 
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || '';

let SC_DOMAIN          = 'https://streamingcommunityz.pet';
let SC_COOKIES         = '';
let SC_USERAGENT       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let SC_INERTIA_VERSION = '';

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getHeadersInertia() {
  return {
    'User-Agent': SC_USERAGENT,
    'Cookie': SC_COOKIES,
    'Referer': `${SC_DOMAIN}/`,
    'X-Inertia': 'true',
    'X-Inertia-Version': SC_INERTIA_VERSION,
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json, text/plain, */*'
  };
}

function pulisciTitolo(titolo) {
  return titolo
    .replace(/[^\w\s]/gi, ' ') // Rimuove punteggiatura come ":" o "-" che rompono la ricerca su SC
    .replace(/\s+/g, ' ')      // Rimuove spazi doppi
    .trim();
}

// ─── AGGIORNAMENTO DOMINIO ────────────────────────────────────────────────────
async function aggiornaDominio() {
  try {
    const { data } = await axios.get(LISTA_URL, { timeout: 5000 });
    const trovato = data.split('\n').find(r => r.includes('streamingcommunity'));
    if (trovato) {
      SC_DOMAIN = trovato.trim().replace(/\/$/, '');
      console.log('[✅ Dominio Aggiornato]', SC_DOMAIN);
    }
  } catch (e) {
    console.warn('[⚠️ Dominio Fallback]', SC_DOMAIN);
  }
}

// ─── SESSIONE FLARESOLVERR ───────────────────────────────────────────────────
async function inizializzaSessione() {
  try {
    console.log('[🔓 FlareSolverr] Richiesta sessione...');
    const { data } = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'request.get',
      url: `${SC_DOMAIN}/it`,
      maxTimeout: 60000
    }, { timeout: 70000 });

    if (data.status !== 'ok') throw new Error(data.message);

    SC_COOKIES = data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    SC_USERAGENT = data.solution.userAgent;

    const html = data.solution.response;
    const versionMatch = html.match(/"version"\s*:\s*"([^"]+)"/) || html.match(/data-page='({.*})'/);
    
    if (versionMatch) {
        if (versionMatch[1].startsWith('{')) {
            const pageJson = JSON.parse(versionMatch[1].replace(/&quot;/g, '"'));
            SC_INERTIA_VERSION = pageJson.version;
        } else {
            SC_INERTIA_VERSION = versionMatch[1];
        }
        console.log('[✅ Inertia Version]', SC_INERTIA_VERSION);
    }
  } catch (e) {
    console.error('[❌ Errore Sessione]', e.message);
  }
}

// ─── RICERCA SU STREAMINGCOMMUNITY ──────────────────────────────────────────
async function cercaSuSC(query) {
  const queryPulita = pulisciTitolo(query);
  const url = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(queryPulita)}`;
  
  try {
    console.log(`[🔎 Ricerca SC] "${queryPulita}"`);
    const { data } = await axios.get(url, {
      headers: getHeadersInertia(),
      timeout: 10000
    });

    // SC con X-Inertia restituisce direttamente i risultati in props.titles.data
    return data?.props?.titles?.data || data?.props?.data || [];
  } catch (e) {
    console.warn('[⚠️ Errore Ricerca]', e.message);
    return [];
  }
}

// ─── LOGICA VIDEO ID & STREAM ────────────────────────────────────────────────
async function getVideoId(scItem, type, stagione, episodio) {
  try {
    const url = type === 'movie' 
      ? `${SC_DOMAIN}/it/titles/${scItem.id}-${scItem.slug}`
      : `${SC_DOMAIN}/it/titles/${scItem.id}-${scItem.slug}/seasons/${stagione}`;

    const { data } = await axios.get(url, { headers: getHeadersInertia() });
    
    if (type === 'movie') {
      return data.props.title.videos[0]?.id;
    } else {
      const ep = data.props.loadedSeason.episodes.find(e => String(e.number) === String(episodio));
      return ep?.videos[0]?.id;
    }
  } catch (e) {
    return null;
  }
}

async function getStreamLink(videoId) {
  try {
    const { data } = await axios.get(`${SC_DOMAIN}/it/watch/${videoId}`, { headers: getHeadersInertia() });
    const embedUrl = data.props.embedUrl || data.props.video.embedUrl;
    
    // Logica semplificata per ottenere il m3u8 (Nota: Vixcloud spesso richiede token)
    const { data: embedHtml } = await axios.get(embedUrl, { 
        headers: { 'User-Agent': SC_USERAGENT, 'Referer': SC_DOMAIN } 
    });
    
    const m3u8Match = embedHtml.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/);
    return m3u8Match ? m3u8Match[1] : null;
  } catch (e) {
    return null;
  }
}

// ─── STREMIO ADDON CONFIG ────────────────────────────────────────────────────
const manifest = {
  id: 'org.stremio.meezie.sc',
  version: '1.2.0',
  name: 'Meezie SC Addon',
  description: 'Addon per StreamingCommunity con supporto Inertia',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  const [imdbId, stagione, episodio] = id.split(':');
  
  // 1. Ottieni info da TMDB
  const tmdbUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
  const { data: tmdbData } = await axios.get(tmdbUrl).catch(() => ({ data: {} }));
  const info = tmdbData.movie_results?.[0] || tmdbData.tv_results?.[0];

  if (!info) return { streams: [] };

  const titoloIt = info.title || info.name;
  const titoloOr = info.original_title || info.original_name;

  // 2. Cerca su SC (Prima ITA, poi Originale come fallback)
  let risultati = await cercaSuSC(titoloIt);
  if (risultati.length === 0 && titoloOr !== titoloIt) {
    risultati = await cercaSuSC(titoloOr);
  }

  if (risultati.length === 0) return { streams: [] };

  const scType = type === 'movie' ? 'movie' : 'tv';
  const match = risultati.find(r => r.type === scType) || risultati[0];

  // 3. Ottieni ID Video e Link finale
  const videoId = await getVideoId(match, type, stagione, episodio);
  if (!videoId) return { streams: [] };

  const streamUrl = await getStreamLink(videoId);

  return {
    streams: streamUrl ? [{
      url: streamUrl,
      title: `StreamingCommunity\n1080p - VixCloud`,
    }] : []
  };
});

// ─── SERVER START ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });

aggiornaDominio().then(() => inizializzaSessione());
