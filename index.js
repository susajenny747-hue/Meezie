const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const LISTA_URL = 'https://raw.githubusercontent.com/susajenny747-hue/sc-addon-stremio/main/domini.txt';
const TMDB_KEY  = process.env.TMDB_KEY || '';   // mettila su Render come variabile d'ambiente

let SC_DOMAIN = 'https://streamingcommunityz.pet';

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
aggiornaDominio();
setInterval(aggiornaDominio, 6 * 60 * 60 * 1000);

// ─── HEADERS ─────────────────────────────────────────────────────────────────
const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'it-IT,it;q=0.9',
  'Accept'         : 'application/json, text/html, */*',
  'X-Inertia'      : 'true',
};

// ─── TMDB: ottieni titolo italiano + titolo originale ────────────────────────
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
    };
  } catch (e) {
    console.warn('[⚠️ TMDB]', e.message);
    return null;
  }
}

// ─── SC: ricerca titolo ───────────────────────────────────────────────────────
async function cercaSuSC(query) {
  try {
    const url = `${SC_DOMAIN}/api/search?q=${encodeURIComponent(query)}`;
    const { data } = await axios.get(url, {
      headers: { ...HEADERS, Referer: SC_DOMAIN },
      timeout: 10000
    });
    // L'API può restituire { data: [...] } oppure direttamente un array
    return data?.data || data || [];
  } catch (e) {
    console.warn('[⚠️ Ricerca SC]', e.message);
    return [];
  }
}

// ─── SC: trova il video_id del film ──────────────────────────────────────────
// Per i film SC ha un campo "videos" nel dettaglio del titolo
async function getVideoIdFilm(scTitoloId, slug) {
  try {
    const url = `${SC_DOMAIN}/titles/${scTitoloId}-${slug}`;
    const { data } = await axios.get(url, {
      headers: { ...HEADERS, Referer: SC_DOMAIN },
      timeout: 10000
    });
    // L'API Inertia restituisce i dati dentro props
    const props = data?.props || data;
    const video = props?.title?.videos?.[0] || props?.videos?.[0];
    return video?.id || null;
  } catch (e) {
    console.warn('[⚠️ VideoId Film]', e.message);
    return null;
  }
}

// ─── SC: trova il video_id di un episodio ────────────────────────────────────
async function getVideoIdEpisodio(scTitoloId, slug, stagione, episodio) {
  try {
    // Prima ottieni le stagioni
    const urlStagioni = `${SC_DOMAIN}/titles/${scTitoloId}-${slug}/seasons`;
    const { data: dStagioni } = await axios.get(urlStagioni, {
      headers: { ...HEADERS, Referer: SC_DOMAIN },
      timeout: 10000
    });
    const props = dStagioni?.props || dStagioni;
    const stagioni = props?.loadedSeason || props?.seasons || [];

    // Poi ottieni gli episodi della stagione richiesta
    const urlEpisodi = `${SC_DOMAIN}/titles/${scTitoloId}-${slug}/seasons/${stagione}`;
    const { data: dEpisodi } = await axios.get(urlEpisodi, {
      headers: { ...HEADERS, Referer: SC_DOMAIN },
      timeout: 10000
    });
    const propsEp = dEpisodi?.props || dEpisodi;
    const episodi = propsEp?.loadedSeason?.episodes || propsEp?.episodes || [];

    const ep = episodi.find(e => String(e.number) === String(episodio));
    if (!ep) {
      console.warn(`[⚠️] Episodio S${stagione}E${episodio} non trovato`);
      return null;
    }
    console.log(`[📺 Episodio trovato] S${stagione}E${episodio} → video_id: ${ep.videos?.[0]?.id}`);
    return ep.videos?.[0]?.id || ep.id || null;
  } catch (e) {
    console.warn('[⚠️ VideoId Episodio]', e.message);
    return null;
  }
}

// ─── SC: estrai stream da Vixcloud ───────────────────────────────────────────
async function getStream(videoId) {
  try {
    // Step 1: pagina /watch/ID
    const watchUrl = `${SC_DOMAIN}/watch/${videoId}`;
    const { data: htmlWatch } = await axios.get(watchUrl, {
      headers: { ...HEADERS, Referer: SC_DOMAIN },
      timeout: 10000
    });

    // Step 2: trova iframe Vixcloud
    const iframeMatch = htmlWatch.match(/src=["'](https:\/\/vixcloud\.co\/embed\/[^"']+)["']/);
    if (!iframeMatch) {
      console.warn('[⚠️ Vixcloud] Iframe non trovato');
      return null;
    }
    const embedUrl = iframeMatch[1];
    console.log('[🎬 Embed URL]', embedUrl);

    // Step 3: apri embed
    const { data: htmlEmbed } = await axios.get(embedUrl, {
      headers: {
        ...HEADERS,
        Referer : SC_DOMAIN,
        Origin  : SC_DOMAIN,
      },
      timeout: 10000
    });

    // Step 4: cerca parametri playlist nel JS inline
    const tokenMatch   = htmlEmbed.match(/"token"\s*:\s*"([^"]+)"/);
    const expiresMatch = htmlEmbed.match(/"expires"\s*:\s*"?(\d+)"?/);
    const vixIdMatch   = embedUrl.match(/embed\/(\d+)/);

    if (tokenMatch && expiresMatch && vixIdMatch) {
      const playlist = `https://vixcloud.co/playlist/${vixIdMatch[1]}?type=video&rendition=1080p&token=${tokenMatch[1]}&expires=${expiresMatch[1]}`;
      console.log('[✅ Playlist m3u8]', playlist);
      return playlist;
    }

    // Fallback: cerca m3u8 diretto nell'HTML
    const m3u8Match = htmlEmbed.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
    if (m3u8Match) {
      console.log('[✅ m3u8 diretto]', m3u8Match[1]);
      return m3u8Match[1];
    }

    console.warn('[⚠️ Vixcloud] Nessun link trovato nell\'embed');
    return null;
  } catch (e) {
    console.warn('[⚠️ getStream]', e.message);
    return null;
  }
}

// ─── MANIFEST ────────────────────────────────────────────────────────────────
const manifest = {
  id         : 'org.myaddon.streamingcommunity',
  version    : '2.0.0',
  name       : '🇮🇹 StreamingCommunity',
  description: 'Film e Serie TV italiani da StreamingCommunity con titoli in italiano.',
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

    // 1. Titoli da TMDB (italiano + originale)
    const titoli = await getTitoli(type, imdbId);
    if (!titoli) {
      console.warn('[⚠️] Titolo non trovato su TMDB');
      return { streams: [] };
    }
    console.log(`[📋 Titoli] IT="${titoli.italiano}" | ORIG="${titoli.originale}"`);

    // 2. Cerca su SC — prima in italiano, poi in originale se non trova
    let risultati = await cercaSuSC(titoli.italiano);
    if (risultati.length === 0 && titoli.originale !== titoli.italiano) {
      console.log('[🔄] Provo con titolo originale...');
      risultati = await cercaSuSC(titoli.originale);
    }
    if (risultati.length === 0) {
      console.warn('[⚠️] Nessun risultato su SC');
      return { streams: [] };
    }

    // Prendi il primo risultato del tipo corretto (movie/tv)
    const scType  = type === 'movie' ? 'movie' : 'tv';
    const titolo  = risultati.find(r => r.type === scType) || risultati[0];
    console.log(`[🎯 Match SC] "${titolo.name}" id=${titolo.id} slug=${titolo.slug}`);

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

    // 4. Ottieni stream
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
    console.error('[❌ Errore handler]', e.message);
  }

  return { streams };
});

// ─── AVVIO ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n🚀 Avviato sulla porta ${PORT}`);
