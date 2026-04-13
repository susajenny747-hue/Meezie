const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// ─── DOMINIO AUTO-AGGIORNANTE ─────────────────────────────────────────────────
// Legge il dominio di SC dal tuo file domini.txt su GitHub
// Per aggiornare il dominio: modifica domini.txt nel tuo repo
// L'addon si aggiorna da solo entro 6 ore

let SC_DOMAIN = 'https://streamingcommunityz.pet';
const LISTA_URL = 'https://raw.githubusercontent.com/TUO_USERNAME/sc-addon-stremio/main/domini.txt';

async function aggiornaDominio() {
  try {
    const { data } = await axios.get(LISTA_URL, { timeout: 5000 });
    const righe = data.split('\n').map(r => r.trim()).filter(Boolean);
    const trovato = righe.find(r => r.toLowerCase().includes('streamingcommunity'));
    if (trovato) {
      SC_DOMAIN = trovato.replace(/\/$/, '');
      console.log('[✅ Dominio aggiornato]', SC_DOMAIN);
    }
  } catch (e) {
    console.warn('[⚠️ Dominio] Uso dominio precedente:', SC_DOMAIN);
  }
}

// Aggiorna subito all'avvio, poi ogni 6 ore
aggiornaDominio();
setInterval(aggiornaDominio, 6 * 60 * 60 * 1000);

// ─── HEADERS BROWSER ─────────────────────────────────────────────────────────
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'it-IT,it;q=0.9',
  'Accept': 'application/json, text/html, */*',
};

// ─── FUNZIONI SC ──────────────────────────────────────────────────────────────

// 1. Cerca un titolo per nome su StreamingCommunity
async function cercaTitolo(nome) {
  const url = `${SC_DOMAIN}/api/search?q=${encodeURIComponent(nome)}`;
  const { data } = await axios.get(url, {
    headers: { ...HEADERS, Referer: SC_DOMAIN },
    timeout: 10000
  });
  return data?.data || [];
}

// 2. Dato l'ID del video su SC, recupera il link m3u8 per riprodurlo
async function recuperaStream(videoId) {
  // Step A: Apri la pagina /watch/ID
  const watchUrl = `${SC_DOMAIN}/watch/${videoId}`;
  const { data: paginaHtml } = await axios.get(watchUrl, {
    headers: { ...HEADERS, Referer: SC_DOMAIN },
    timeout: 10000
  });

  // Step B: Trova l'URL dell'iframe (player Vixcloud)
  const iframeMatch = paginaHtml.match(/src=["'](https:\/\/vixcloud\.co\/embed\/[^"']+)["']/);
  if (!iframeMatch) {
    console.warn('[⚠️ Stream] Iframe Vixcloud non trovato per videoId:', videoId);
    return null;
  }

  const embedUrl = iframeMatch[1];
  console.log('[🎬 Embed]', embedUrl);

  // Step C: Apri la pagina dell'embed per trovare token e playlist
  const { data: embedHtml } = await axios.get(embedUrl, {
    headers: { ...HEADERS, Referer: SC_DOMAIN },
    timeout: 10000
  });

  // Step D: Estrai token, expires e id video dal JS dell'embed
  const tokenMatch = embedHtml.match(/"token"\s*:\s*"([^"]+)"/);
  const expiresMatch = embedHtml.match(/"expires"\s*:\s*"?(\d+)"?/);
  const vixIdMatch = embedUrl.match(/embed\/(\d+)/);

  if (tokenMatch && expiresMatch && vixIdMatch) {
    const playlistUrl = `https://vixcloud.co/playlist/${vixIdMatch[1]}?type=video&rendition=1080p&token=${tokenMatch[1]}&expires=${expiresMatch[1]}`;
    console.log('[✅ Playlist]', playlistUrl);
    return playlistUrl;
  }

  // Fallback: cerca direttamente un .m3u8 nell'HTML dell'embed
  const m3u8Match = embedHtml.match(/(https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*)/);
  if (m3u8Match) {
    console.log('[✅ m3u8 diretto]', m3u8Match[1]);
    return m3u8Match[1];
  }

  console.warn('[⚠️ Stream] Nessun link trovato nell\'embed');
  return null;
}

// 3. Per le serie: recupera gli episodi di una stagione
async function recuperaEpisodi(scId, slug, numeroStagione) {
  const url = `${SC_DOMAIN}/titles/${scId}-${slug}/seasons/${numeroStagione}`;
  const { data } = await axios.get(url, {
    headers: { ...HEADERS, Referer: SC_DOMAIN },
    timeout: 10000
  });
  return data?.episodes || [];
}

// ─── MANIFEST STREMIO ────────────────────────────────────────────────────────
const manifest = {
  id: 'org.myaddon.streamingcommunity',
  version: '1.0.0',
  name: '🇮🇹 StreamingCommunity',
  description: 'Film e Serie TV da StreamingCommunity. Dominio aggiornato dal tuo domini.txt su GitHub.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

const builder = new addonBuilder(manifest);

// ─── HANDLER STREAM ───────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`\n[🔍 Richiesta] type: ${type} | id: ${id}`);
  const streams = [];

  try {
    // Stremio manda:
    //   Film:  "tt1234567"
    //   Serie: "tt1234567:2:5"  (stagione 2, episodio 5)
    const parti = id.split(':');
    const imdbId = parti[0];
    const stagione = parti[1];
    const episodio = parti[2];

    // Step 1: Ottieni il nome del titolo da Cinemeta (catalogo ufficiale Stremio)
    const cinemeta = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
      { timeout: 8000 }
    );
    const nomeTitolo = cinemeta.data?.meta?.name;
    if (!nomeTitolo) {
      console.warn('[⚠️] Nome non trovato su Cinemeta per', imdbId);
      return { streams: [] };
    }
    console.log('[📋 Titolo]', nomeTitolo);

    // Step 2: Cerca quel titolo su StreamingCommunity
    const risultati = await cercaTitolo(nomeTitolo);
    if (risultati.length === 0) {
      console.warn('[⚠️] Nessun risultato su SC per:', nomeTitolo);
      return { streams: [] };
    }

    const titolo = risultati[0];
    console.log(`[🎯 Match SC] ${titolo.name} (id: ${titolo.id})`);

    let videoId;

    if (type === 'movie') {
      videoId = titolo.id;
    } else {
      // Per le serie: trova l'episodio giusto nella stagione
      const episodi = await recuperaEpisodi(titolo.id, titolo.slug, stagione);
      const ep = episodi.find(e => String(e.number) === String(episodio));
      if (!ep) {
        console.warn(`[⚠️] Episodio S${stagione}E${episodio} non trovato`);
        return { streams: [] };
      }
      videoId = ep.id;
      console.log(`[📺 Episodio] S${stagione}E${episodio} → id: ${videoId}`);
    }

    // Step 3: Recupera il link dello stream
    const streamUrl = await recuperaStream(videoId);

    if (streamUrl) {
      streams.push({
        url: streamUrl,
        title: `StreamingCommunity\n${titolo.name}`,
        behaviorHints: { notWebReady: false }
      });
      console.log('[✅ Stream trovato!]');
    } else {
      console.warn('[⚠️] Stream non trovato');
    }

  } catch (e) {
    console.error('[❌ Errore]', e.message);
  }

  return { streams };
});

// ─── AVVIO SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n🚀 Addon avviato sulla porta ${PORT}`);
console.log(`📡 Manifest: http://localhost:${PORT}/manifest.json\n`);
