const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const LISTA_URL        = 'https://raw.githubusercontent.com/susajenny747-hue/sc-addon-stremio/main/domini.txt';
const TMDB_KEY         = process.env.TMDB_KEY || '';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || '';

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

// ─── FLARESOLVERR: richiesta bypass Cloudflare ────────────────────────────────
// Tutte le richieste a SC passano da qui
async function fetchSC(url) {
  if (!FLARESOLVERR_URL) throw new Error('FLARESOLVERR_URL non impostato');

  console.log('[🔓 FlareSolverr] Richiesta:', url);

  const { data } = await axios.post(`${FLARESOLVERR_URL}/v1`, {
    cmd    : 'request.get',
    url    : url,
    maxTimeout: 60000,
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 70000
  });

  if (data.status !== 'ok') {
    throw new Error(`FlareSolverr errore: ${data.message}`);
  }

  console.log('[✅ FlareSolverr] Risposta ok');
  return data.solution.response; // HTML della pagina
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
    };
  } catch (e) {
    console.warn('[⚠️ TMDB]', e.message);
    return null;
  }
}

// ─── SC: ricerca titolo ───────────────────────────────────────────────────────
async function cercaSuSC(query) {
  try {
    const url  = `${SC_DOMAIN}/search?q=${encodeURIComponent(query)}`;
    const html = await fetchSC(url);

    // SC risponde con JSON Inertia dentro un tag <div id="app" data-page="...">
    const match = html.match(/data-page="([^"]+)"/);
    if (!match) {
      console.warn('[⚠️ SC] data-page non trovato');
      return [];
    }

    const json     = JSON.parse(match[1].replace(/&quot;/g, '"'));
    const risultati = json?.props?.titles?.data
                    || json?.props?.data
                    || json?.data
                    || [];

    console.log(`[✅ Ricerca SC] ${risultati.length} risultati per "${query}"`);
    return Array.isArray(risultati) ? risultati : [];
  } catch (e) {
    console.warn('[⚠️ Ricerca SC]', e.message);
    return [];
  }
}

// ─── SC: video_id film ────────────────────────────────────────────────────────
async function getVideoIdFilm(scTitoloId, slug) {
  try {
    const url  = `${SC_DOMAIN}/titles/${scTitoloId}-${slug}`;
    const html = await fetchSC(url);

    const match = html.match(/data-page="([^"]+)"/);
    if (!match) return null;

    const json  = JSON.parse(match[1].replace(/&quot;/g, '"'));
    const props = json?.props || {};
    const video = props?.title?.videos?.[0] || props?.videos?.[0];
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

    const match = html.match(/data-page="([^"]+)"/);
    if (!match) return null;

    const json    = JSON.parse(match[1].replace(/&quot;/g, '"'));
    const props   = json?.props || {};
    const episodi = props?.loadedSeason?.episodes || props?.episodes || [];

    const ep = episodi.find(e => String(e.number) === String(episodio));
    if (!ep) {
      console.warn(`[⚠️] Episodio S${stagione}E${episodio} non trovato`);
      return null;
    }
    console.log(`[📺 Ep trovato] S${stagione}E${episodio} → id: ${ep.videos?.[0]?.id}`);
    return ep.videos?.[0]?.id || ep.id || null;
  } catch (e) {
    console.warn('[⚠️ VideoId Ep]', e.message);
    return null;
  }
}

// ─── SC: stream da Vixcloud ───────────────────────────────────────────────────
async function getStream(videoId) {
  try {
    // Watch page tramite FlareSolverr
    const watchUrl  = `${SC_DOMAIN}/watch/${videoId}`;
    const htmlWatch = await fetchSC(watchUrl);

    const iframeMatch = htmlWatch.match(/src=["'](https:\/\/vixcloud\.co\/embed\/[^"']+)["']/);
    if (!iframeMatch) {
      console.warn('[⚠️ Vixcloud] Iframe non trovato');
      return null;
    }
    const embedUrl = iframeMatch[1];
    console.log('[🎬 Embed]', embedUrl);

    // Embed page tramite FlareSolverr
    const htmlEmbed = await fetchSC(embedUrl);

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
  version    : '3.0.0',
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
    console.log(`[📋 Titoli] IT="${titoli.italiano}" | ORIG="${titoli.originale}"`);

    // 2. Cerca su SC
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
