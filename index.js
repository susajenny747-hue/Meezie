const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const LISTA_URL        = 'https://raw.githubusercontent.com/susajenny747-hue/sc-addon-stremio/main/domini.txt';
const TMDB_KEY         = process.env.TMDB_KEY || '';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || '';

let SC_DOMAIN    = 'https://streamingcommunityz.pet';
let SC_COOKIES   = '';
let SC_USERAGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

// ─── INIZIALIZZA SESSIONE SC VIA FLARESOLVERR ─────────────────────────────────
// FlareSolverr visita la homepage UNA volta e ci dà i cookie Cloudflare.
// Poi usiamo axios direttamente con quei cookie — molto più veloce.
async function inizializzaSessione() {
  try {
    console.log('[🔓 FlareSolverr] Inizializzazione sessione SC...');
    const { data } = await axios.post(
      `${FLARESOLVERR_URL}/v1`,
      {
        cmd      : 'request.get',
        url      : SC_DOMAIN,
        maxTimeout: 60000,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 70000
      }
    );

    if (data.status !== 'ok') {
      throw new Error(data.message);
    }

    // Estrai cookies e user-agent dalla risposta
    SC_COOKIES   = data.solution.cookies
                     .map(c => `${c.name}=${c.value}`)
                     .join('; ');
    SC_USERAGENT = data.solution.userAgent;

    console.log('[✅ Sessione SC ok] Cookies:', SC_COOKIES.substring(0, 80) + '...');
    console.log('[✅ User-Agent]', SC_USERAGENT);
  } catch (e) {
    console.warn('[⚠️ Sessione SC]', e.message);
  }
}

// Rinnova i cookie ogni 2 ore (Cloudflare challenge dura ~2h)
async function avvio() {
  await aggiornaDominio();
  await inizializzaSessione();
  setInterval(aggiornaDominio,    6 * 60 * 60 * 1000);
  setInterval(inizializzaSessione, 2 * 60 * 60 * 1000);
}
avvio();

// ─── AXIOS CON COOKIE CLOUDFLARE ─────────────────────────────────────────────
function getHeaders(extra = {}) {
  return {
    'User-Agent'     : SC_USERAGENT,
    'Cookie'         : SC_COOKIES,
    'Referer'        : SC_DOMAIN,
    'Accept-Language': 'it-IT,it;q=0.9',
    'Accept'         : 'application/json, text/html, */*',
    ...extra
  };
}

async function fetchSC(url, inertia = false) {
  console.log('[📡 Fetch]', url);
  const headers = getHeaders(
    inertia ? { 'X-Inertia': 'true', 'X-Requested-With': 'XMLHttpRequest' } : {}
  );
  const { data } = await axios.get(url, { headers, timeout: 15000 });
  return data;
}

// ─── TMDB: titolo italiano + originale ───────────────────────────────────────
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

// ─── SC: ricerca titolo ───────────────────────────────────────────────────────
async function cercaSuSC(query) {
  try {
    // Prova 1: /api/search con Inertia headers → risposta JSON
    try {
      const url  = `${SC_DOMAIN}/api/search?q=${encodeURIComponent(query)}`;
      const data = await fetchSC(url, true);
      const risultati = data?.data || data?.titles || data || [];
      if (Array.isArray(risultati) && risultati.length > 0) {
        console.log(`[✅ /api/search] ${risultati.length} risultati`);
        return risultati;
      }
    } catch (e1) {
      console.warn('[⚠️ /api/search]', e1.message);
    }

    // Prova 2: /search → HTML con data-page
    try {
      const url  = `${SC_DOMAIN}/search?q=${encodeURIComponent(query)}`;
      const html = await fetchSC(url, false);

      // Debug: mostra primi 500 char
      console.log('[🔍 /search HTML]', String(html).substring(0, 500));

      const str   = typeof html === 'string' ? html : JSON.stringify(html);
      const match = str.match(/data-page="([^"]+)"/)
                 || str.match(/data-page='([^']+)'/);

      if (match) {
        const json = JSON.parse(
          match[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'")
        );
        const risultati = json?.props?.titles?.data
                        || json?.props?.data
                        || json?.data
                        || [];
        if (Array.isArray(risultati) && risultati.length > 0) {
          console.log(`[✅ /search HTML] ${risultati.length} risultati`);
          return risultati;
        }
      }

      // Prova 3: se la risposta è già JSON (Inertia risponde JSON a volte)
      if (typeof html === 'object') {
        const risultati = html?.props?.titles?.data || html?.data || [];
        if (Array.isArray(risultati) && risultati.length > 0) {
          console.log(`[✅ /search JSON] ${risultati.length} risultati`);
          return risultati;
        }
      }

    } catch (e2) {
      console.warn('[⚠️ /search]', e2.message);
    }

    return [];
  } catch (e) {
    console.warn('[⚠️ cercaSuSC]', e.message);
    return [];
  }
}

// ─── SC: video_id film ────────────────────────────────────────────────────────
async function getVideoIdFilm(scTitoloId, slug) {
  try {
    const url  = `${SC_DOMAIN}/titles/${scTitoloId}-${slug}`;
    const html = await fetchSC(url);
    const str  = typeof html === 'string' ? html : JSON.stringify(html);

    // Se è già JSON (Inertia)
    if (typeof html === 'object') {
      const video = html?.props?.title?.videos?.[0];
      return video?.id || null;
    }

    const match = str.match(/data-page="([^"]+)"/)
               || str.match(/data-page='([^']+)'/);
    if (!match) return null;

    const json  = JSON.parse(
      match[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    );
    const video = json?.props?.title?.videos?.[0] || json?.props?.videos?.[0];
    console.log('[🎬 video_id film]', video?.id);
    return video?.id || null;
  } catch (e) {
    console.warn('[⚠️ VideoId Film]', e.message);
    return null;
  }
}

// ─── SC: video_id episodio ────────────────────────────────────────────────────
async function getVideoIdEpisodio(scTitoloId, slug, stagione, episodio) {
  try {
    const url  = `${SC_DOMAIN}/titles/${scTitoloId}-${slug}/seasons/${stagione}`;
    const html = await fetchSC(url);
    const str  = typeof html === 'string' ? html : JSON.stringify(html);

    let episodi = [];

    if (typeof html === 'object') {
      episodi = html?.props?.loadedSeason?.episodes
             || html?.props?.episodes
             || [];
    } else {
      const match = str.match(/data-page="([^"]+)"/)
                 || str.match(/data-page='([^']+)'/);
      if (match) {
        const json = JSON.parse(
          match[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'")
        );
        episodi = json?.props?.loadedSeason?.episodes
               || json?.props?.episodes
               || [];
      }
    }

    const ep = episodi.find(e => String(e.number) === String(episodio));
    if (!ep) {
      console.warn(`[⚠️] Ep S${stagione}E${episodio} non trovato`);
      return null;
    }
    const vid = ep.videos?.[0]?.id || ep.id;
    console.log(`[📺 Ep] S${stagione}E${episodio} → video_id: ${vid}`);
    return vid || null;
  } catch (e) {
    console.warn('[⚠️ VideoId Ep]', e.message);
    return null;
  }
}

// ─── SC: stream da Vixcloud ───────────────────────────────────────────────────
async function getStream(videoId) {
  try {
    const watchUrl  = `${SC_DOMAIN}/watch/${videoId}`;
    const htmlWatch = await fetchSC(watchUrl);
    const strWatch  = typeof htmlWatch === 'string' ? htmlWatch : JSON.stringify(htmlWatch);

    const iframeMatch = strWatch.match(/src=["'](https:\/\/vixcloud\.co\/embed\/[^"']+)["']/);
    if (!iframeMatch) {
      console.warn('[⚠️ Vixcloud] Iframe non trovato');
      return null;
    }
    const embedUrl = iframeMatch[1];
    console.log('[🎬 Embed]', embedUrl);

    // Vixcloud non usa Cloudflare, richiesta diretta
    const { data: htmlEmbed } = await axios.get(embedUrl, {
      headers: {
        'User-Agent': SC_USERAGENT,
        'Referer'   : SC_DOMAIN,
        'Origin'    : SC_DOMAIN,
      },
      timeout: 15000
    });

    const tokenMatch   = htmlEmbed.match(/"token"\s*:\s*"([^"]+)"/);
    const expiresMatch = htmlEmbed.match(/"expires"\s*:\s*"?(\d+)"?/);
    const vixIdMatch   = embedUrl.match(/embed\/(\d+)/);

    if (tokenMatch && expiresMatch && vixIdMatch) {
      const playlist = `https://vixcloud.co/playlist/${vixIdMatch[1]}?type=video&rendition=1080p&token=${tokenMatch[1]}&expires=${expiresMatch[1]}`;
      console.log('[✅ Playlist]', playlist);
      return playlist;
    }

    const m3u8Match = htmlEmbed.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
    if (m3u8Match) {
      console.log('[✅ m3u8]', m3u8Match[1]);
      return m3u8Match[1];
    }

    console.warn('[⚠️ Vixcloud] Nessun link trovato');
    return null;
  } catch (e) {
    console.warn('[⚠️ getStream]', e.message);
    return null;
  }
}

// ─── MANIFEST ────────────────────────────────────────────────────────────────
const manifest = {
  id         : 'org.myaddon.streamingcommunity',
  version    : '5.0.0',
  name       : '🇮🇹 StreamingCommunity',
  description: 'Film e Serie TV italiani da StreamingCommunity.',
  resources  : ['stream'],
  types      : ['movie', 'series'],
  idPrefixes : ['tt'],
  catalogs   : [],
};

const builder = new addonBuilder(manifest);

// ─── STREAM HANDLER ───────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`\n[🔍] type=${type} id=${id}`);
  const streams = [];

  try {
    const parti    = id.split(':');
    const imdbId   = parti[0];
    const stagione = parti[1];
    const episodio = parti[2];

    // 1. Titoli da TMDB
    const titoli = await getTitoli(type, imdbId);
    if (!titoli) {
      console.warn('[⚠️] Titolo non trovato su TMDB');
      return { streams: [] };
    }
    console.log(`[📋] IT="${titoli.italiano}" | ORIG="${titoli.originale}" | Anno=${titoli.anno}`);

    // 2. Cerca su SC — prima italiano poi originale
    let risultati = await cercaSuSC(titoli.italiano);
    if (risultati.length === 0 && titoli.originale !== titoli.italiano) {
      console.log('[🔄] Provo con titolo originale...');
      risultati = await cercaSuSC(titoli.originale);
    }
    if (risultati.length === 0) {
      console.warn('[⚠️] Nessun risultato su SC');
      return { streams: [] };
    }

    const scType = type === 'movie' ? 'movie' : 'tv';
    const titolo = risultati.find(r => r.type === scType) || risultati[0];
    console.log(`[🎯] "${titolo.name}" id=${titolo.id} slug=${titolo.slug}`);

    // 3. Ottieni video_id
    let videoId;
    if (type === 'movie') {
      videoId = await getVideoIdFilm(titolo.id, titolo.slug);
    } else {
      videoId = await getVideoIdEpisodio(titolo.id, titolo.slug, stagione, episodio);
    }

    if (!videoId) {
      console.warn('[⚠️] video_id non trovato');
      return { streams: [] };
    }
    console.log('[🎬 video_id]', videoId);

    // 4. Stream
    const streamUrl = await getStream(videoId);
    if (streamUrl) {
      streams.push({
        url  : streamUrl,
        title: `StreamingCommunity\n${titolo.name}`,
        behaviorHints: { notWebReady: false }
      });
      console.log('[✅ Stream ok!]');
    }

  } catch (e) {
    console.error('[❌]', e.message);
  }

  return { streams };
});

// ─── AVVIO ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n🚀 Avviato sulla porta ${PORT}`);
