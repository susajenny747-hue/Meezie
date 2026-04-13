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

// ─── HEADERS BASE (senza Inertia) ────────────────────────────────────────────
function getHeadersHTML() {
  return {
    'User-Agent'     : SC_USERAGENT,
    'Cookie'         : SC_COOKIES,
    'Referer'        : SC_DOMAIN,
    'Accept-Language': 'it-IT,it;q=0.9',
    'Accept'         : 'text/html,application/xhtml+xml,*/*',
  };
}

// ─── HEADERS INERTIA (per richieste JSON) ────────────────────────────────────
function getHeadersInertia() {
  return {
    'User-Agent'       : SC_USERAGENT,
    'Cookie'           : SC_COOKIES,
    'Referer'          : SC_DOMAIN,
    'Accept-Language'  : 'it-IT,it;q=0.9',
    'Accept'           : 'application/json, text/html, */*',
    'X-Inertia'        : 'true',
    'X-Inertia-Version': SC_INERTIA_VERSION,
    'X-Requested-With' : 'XMLHttpRequest',
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

    // Prova 1: data-fp
    const fpMatch = html.match(/data-fp=["']?([a-z0-9]+)["']?/i);
    // Prova 2: version classica Inertia
    const versionMatch = html.match(/"version"\s*:\s*"([^"]+)"/)
                      || html.match(/X-Inertia-Version['":\s]+([a-zA-Z0-9]+)/);
    // Prova 3: data-page JSON
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
      console.warn('[⚠️] Nessuna version trovata');
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

// ─── SC: ricerca (HTML puro, senza Inertia) ───────────────────────────────────
async function cercaSuSC(query) {
  const url = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(query)}`;
  try {
    console.log('[🔎 Ricerca]', url);

    const { data } = await axios.get(url, {
      headers: getHeadersHTML(),
      timeout: 10000
    });

    if (typeof data === 'string') {
      console.log('[🔍 HTML primi 300]', data.substring(0, 300));

      const match = data.match(/data-page="([^"]+)"/)
                 || data.match(/data-page='([^']+)'/);
      if (match) {
        const json = JSON.parse(
          match[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'")
        );
        console.log('[🔍 Props keys]', Object.keys(json?.props || {}));
        const risultati = json?.props?.titles?.data
                        || json?.props?.data
                        || json?.data
                        || [];
        if (Array.isArray(risultati) && risultati.length > 0) {
          console.log(`[✅ Trovati] ${risultati.length} risultati`);
          return risultati;
        }
        console.log('[🔍 Props completo]', JSON.stringify(json?.props).substring(0, 500));
      } else {
        console.warn('[⚠️] data-page non trovato');
        console.log('[🔍 HTML completo]', data.substring(0, 800));
      }
    }

    if (typeof data === 'object') {
      console.log('[🔍 JSON risposta]', JSON.stringify(data).substring(0, 500));
      const risultati = data?.props?.titles?.data
                      || data?.data
                      || data?.titles
                      || [];
      if (Array.isArray(risultati) && risultati.length > 0) {
        console.log(`[✅ Trovati JSON] ${risultati.length}`);
        return risultati;
      }
    }

  } catch (e) {
    console.warn('[⚠️ Ricerca]', e.message);
    if (e.response) {
      console.warn('[⚠️ Status]', e.response.status);
      console.warn('[⚠️ Response]', String(e.response.data).substring(0, 300));
    }
  }
  return [];
}

// ─── SC: video_id film ────────────────────────────────────────────────────────
async function getVideoIdFilm(scTitoloId, slug) {
  try {
    const url = `${SC_DOMAIN}/it/titles/${scTitoloId}-${slug}`;
    console.log('[📡 Titolo film]', url);
    const { data } = await axios.get(url, {
      headers: getHeadersHTML(),
      timeout: 15000
    });

    if (typeof data === 'object') {
      const vid = data?.props?.title?.videos?.[0]?.id;
      console.log('[🎬 video_id film]', vid);
      return vid || null;
    }

    const match = data.match(/data-page="([^"]+)"/)
               || data.match(/data-page='([^']+)'/);
    if (!match) {
      console.warn('[⚠️] data-page non trovato nel film');
      return null;
    }
    const json = JSON.parse(
      match[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    );
    const vid = json?.props?.title?.videos?.[0]?.id
             || json?.props?.videos?.[0]?.id;
    console.log('[🎬 video_id film]', vid);
    return vid || null;
  } catch (e) {
    console.warn('[⚠️ VideoId Film]', e.message);
    return null;
  }
}

// ─── SC: video_id episodio ────────────────────────────────────────────────────
async function getVideoIdEpisodio(scTitoloId, slug, stagione, episodio) {
  try {
    const url = `${SC_DOMAIN}/it/titles/${scTitoloId}-${slug}/seasons/${stagione}`;
    console.log('[📡 Stagione]', url);
    const { data } = await axios.get(url, {
      headers: getHeadersHTML(),
      timeout: 15000
    });

    let episodi = [];

    if (typeof data === 'object') {
      episodi = data?.props?.loadedSeason?.episodes
             || data?.props?.episodes
             || [];
    } else {
      const match = data.match(/data-page="([^"]+)"/)
                 || data.match(/data-page='([^']+)'/);
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
    console.log(`[📺] S${stagione}E${episodio} → video_id: ${vid}`);
    return vid || null;
  } catch (e) {
    console.warn('[⚠️ VideoId Ep]', e.message);
    return null;
  }
}

// ─── SC: stream Vixcloud ──────────────────────────────────────────────────────
async function getStream(videoId) {
  try {
    const watchUrl = `${SC_DOMAIN}/it/watch/${videoId}`;
    console.log('[📡 Watch]', watchUrl);

    const { data: htmlWatch } = await axios.get(watchUrl, {
      headers: getHeadersHTML(),
      timeout: 15000
    });
    const strWatch = typeof htmlWatch === 'string' ? htmlWatch : JSON.stringify(htmlWatch);

    const iframeMatch = strWatch.match(/src=["'](https:\/\/vixcloud\.co\/embed\/[^"']+)["']/);
    if (!iframeMatch) {
      console.warn('[⚠️] Iframe Vixcloud non trovato');
      return null;
    }

    const embedUrl = iframeMatch[1];
    console.log('[🎬 Embed]', embedUrl);

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

    const m3u8 = htmlEmbed.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
    if (m3u8) {
      console.log('[✅ m3u8]', m3u8[1]);
      return m3u8[1];
    }

    console.warn('[⚠️] Nessun link stream trovato');
    return null;
  } catch (e) {
    console.warn('[⚠️ getStream]', e.message);
    return null;
  }
}

// ─── MANIFEST ────────────────────────────────────────────────────────────────
const manifest = {
  id         : 'org.myaddon.streamingcommunity',
  version    : '11.0.0',
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

    const titoli = await getTitoli(type, imdbId);
    if (!titoli) {
      console.warn('[⚠️] TMDB fail');
      return { streams: [] };
    }
    console.log(`[📋] IT="${titoli.italiano}" ORIG="${titoli.originale}" ${titoli.anno}`);

    let risultati = await cercaSuSC(titoli.italiano);
    if (!risultati.length && titoli.originale !== titoli.italiano) {
      console.log('[🔄] Provo originale...');
      risultati = await cercaSuSC(titoli.originale);
    }
    if (!risultati.length) {
      console.warn('[⚠️] Nessun risultato SC');
      return { streams: [] };
    }

    const scType = type === 'movie' ? 'movie' : 'tv';
    const titolo = risultati.find(r => r.type === scType) || risultati[0];
    console.log(`[🎯] "${titolo.name}" id=${titolo.id} slug=${titolo.slug}`);

    const videoId = type === 'movie'
      ? await getVideoIdFilm(titolo.id, titolo.slug)
      : await getVideoIdEpisodio(titolo.id, titolo.slug, stagione, episodio);

    if (!videoId) {
      console.warn('[⚠️] video_id non trovato');
      return { streams: [] };
    }
    console.log('[🎬 video_id]', videoId);

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

// ─── SERVER ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n🚀 Avviato sulla porta ${PORT}`);

aggiornaDominio()
  .then(() => inizializzaSessione())
  .then(() => {
    setInterval(aggiornaDominio,     6 * 60 * 60 * 1000);
    setInterval(inizializzaSessione, 2 * 60 * 60 * 1000);
  })
  .catch(e => console.error('[❌ Avvio]', e.message));
