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

// ─── HEADERS ─────────────────────────────────────────────────────────────────
function getHeaders(extra = {}) {
  return {
    'User-Agent'       : SC_USERAGENT,
    'Cookie'           : SC_COOKIES,
    'Referer'          : SC_DOMAIN,
    'Accept-Language'  : 'it-IT,it;q=0.9',
    'Accept'           : 'application/json, text/html, */*',
    'X-Inertia'        : 'true',
    'X-Inertia-Version': SC_INERTIA_VERSION,
    'X-Requested-With' : 'XMLHttpRequest',
    ...extra
  };
}

// ─── AGGIORNAMENTO DOMINIO ────────────────────────────────────────────────────
async function aggiornaDominio() {
  try {
    const { data } = await axios.get(LISTA_URL, { timeout: 5000 });
    const righe = data.split('\n').map(r => r.trim()).filter(Boolean);
    const trovato = righe.find(r => r.toLowerCase().includes('streamingcommunity'));
    if (trovato) {
      SC_DOMAIN = trovato.replace(/\/$/, '');
      console.log('[✅ Dominio]', SC_DOMAIN);
    }
  } catch (e) {
    console.warn('[⚠️ Dominio] Uso fallback:', SC_DOMAIN);
  }
}

// ─── SESSIONE SC VIA FLARESOLVERR ─────────────────────────────────────────────
async function inizializzaSessione() {
  try {
    console.log('[🔓 FlareSolverr] Inizializzazione...');

    const { data } = await axios.post(
      `${FLARESOLVERR_URL}/v1`,
      { cmd: 'request.get', url: `${SC_DOMAIN}/it`, maxTimeout: 60000 },
      { headers: { 'Content-Type': 'application/json' }, timeout: 70000 }
    );

    if (data.status !== 'ok') throw new Error(data.message);

    SC_COOKIES   = data.solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    SC_USERAGENT = data.solution.userAgent;

    const html = data.solution.response;

    // Prova 1: data-fp con regex permissivo
    const fpMatch = html.match(/data-fp=["']?([a-z0-9]+)["']?/i);

    // Prova 2: formato classico Inertia
    const versionMatch = html.match(/"version"\s*:\s*"([^"]+)"/)
                      || html.match(/X-Inertia-Version['":\s]+([a-zA-Z0-9]+)/);

    // Prova 3: dentro data-page JSON
    const pageMatch = html.match(/data-page='([^']+)'/)
                   || html.match(/data-page="([^"]+)"/);

    if (fpMatch) {
      SC_INERTIA_VERSION = fpMatch[1];
      console.log('[✅ Inertia version da data-fp]', SC_INERTIA_VERSION);
    } else if (versionMatch) {
      SC_INERTIA_VERSION = versionMatch[1];
      console.log('[✅ Inertia version classica]', SC_INERTIA_VERSION);
    } else if (pageMatch) {
      try {
        const pageJson = JSON.parse(
          pageMatch[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'")
        );
        SC_INERTIA_VERSION = pageJson?.version || '';
        console.log('[✅ Inertia version da data-page]', SC_INERTIA_VERSION);
      } catch (e) {
        console.warn('[⚠️] Parse data-page fallito');
      }
    }

    if (!SC_INERTIA_VERSION) {
      console.warn('[⚠️] Nessuna version trovata, uso stringa vuota');
    }

    console.log('[✅ Sessione ok] Cookies:', SC_COOKIES.substring(0, 80) + '...');
    console.log('[✅ UserAgent]', SC_USERAGENT);
  } catch (e) {
    console.warn('[⚠️ Sessione]', e.message);
  }
}

// ─── TMDB ─────────────────────────────────────────────────────────────────────
async function getTitoli(type, imdbId) {
  try {
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
    const { data } = await axios.get(url, { timeout: 8000 });
    const risultati = data[`${tmdbType}_results`];
    if (!risultati || risultati.length === 0) return null;
    const item = risultati[0];
    return {
      italiano : item.title || item.name,
      originale: item.original_title || item.original_name,
      anno     : (item.release_date || item.first_air_date || '').substring(0, 4),
    };
  } catch (e) {
    console.warn('[⚠️ TMDB]', e.message);
    return null;
  }
}

// ─── SC: ricerca ─────────────────────────────────────────────────────────────
async function cercaSuSC(query) {
  const url = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(query)}`;
  try {
    console.log('[🔎 Ricerca]', url);
    console.log('[🔎 Inertia Version usata]', SC_INERTIA_VERSION);

    const { data } = await axios.get(url, {
      headers: getHeaders(),
      timeout: 10000
    });

    // Risposta JSON (Inertia)
    if (typeof data === 'object') {
      const risultati = data?.props?.titles?.data
                      || data?.props?.data
                      || data?.data
                      || data?.titles
                      || [];
      if (Array.isArray(risultati) && risultati.length > 0) {
        console.log(`[✅ Trovati] ${risultati.length} risultati`);
        return risultati;
      }
      console.log('[🔍 JSON risposta]', JSON.stringify(data).substring(0, 500));
    }

    // HTML con data-page
    if (typeof data === 'string') {
      const match = data.match(/data-page="([^"]+)"/)
                 || data.match(/data-page='([^']+)'/);
      if (match) {
        const json = JSON.parse(
          match[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'")
        );
        const risultati = json?.props?.titles?.data
                        || json?.props?.data
                        || json?.data
                        || [];
        if (Array.isArray(risultati) && risultati.length > 0) {
          console.log(`[✅ Trovati HTML] ${risultati.length}`);
          return risultati;
        }
      }
      console.log('[🔍 HTML risposta]', data.substring(0, 500));
    }
  } catch (e) {
    console.warn('[⚠️ Ricerca]', e.message);
    if (e.response) {
      console.warn('[⚠️ Status]', e.response.status);
      console.warn('[⚠️ Response]', JSON.stringify(e.response.data).substring(0, 300));
    }
  }
  return [];
}

// ─── SC: video_id film ────────────────────────────────────────────────────────
async function getVideoIdFilm(scTitoloId, slug) {
  try {
    const url = `${SC_DOMAIN}/it/titles/${scTitoloId}-${slug}`;
    console.log('[📡 Titolo film]', url);
    const { data } = await axios.get(url, { headers: getHeaders(), timeout: 15000 });

    if (typeof data === 'object') {
      const vid = data?.props?.title?.videos?.[0]?.id;
      console.log('[🎬 video_id film]', vid);
      return vid ||
