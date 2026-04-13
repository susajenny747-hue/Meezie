require('dotenv').config();

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const TMDB_KEY = process.env.TMDB_KEY || '';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';
const LISTA_URL = 'https://raw.githubusercontent.com/susajenny747-hue/Meezie/main/domini.txt';

let SC_DOMAIN = 'https://streamingcommunityz.moe';
let BROWSER = { ua: '', cookies: '', inertia: '' };
const CACHE = new Map();
const CACHE_TTL = 1000 * 60 * 10;

const api = axios.create({
  timeout: 15000,
  validateStatus: (status) => status >= 200 && status < 500
});

const slugify = (s) => (s ? s.toLowerCase().replace(/[^a-z0-9]/g, '') : '');

function getCache(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function setCache(key, value, ttl = CACHE_TTL) {
  CACHE.set(key, { value, expiresAt: Date.now() + ttl });
}

async function syncBrowser() {
  console.log('[📡] Sincronizzazione sessione...');
  try {
    const res = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'request.get',
      url: SC_DOMAIN,
      maxTimeout: 60000
    }, {
      timeout: 70000
    });

    if (res.data?.status === 'ok') {
      BROWSER.cookies = (res.data.solution.cookies || [])
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
      BROWSER.ua = res.data.solution.userAgent || 'Mozilla/5.0';
      const body = res.data.solution.response || '';
      const m = body.match(/version&quot;:&quot;([^&]+)&quot;/);
      if (m) BROWSER.inertia = m[1];
      console.log(`[✅] Sessione Pronta (V: ${BROWSER.inertia || 'n/d'})`);
      return true;
    }
  } catch (e) {
    console.error(`[❌] Errore FlareSolverr: ${e.message}`);
  }
  return false;
}

async function fetchSC(url, retry = true) {
  const res = await api.get(url, {
    headers: {
      'User-Agent': BROWSER.ua || 'Mozilla/5.0',
      'Cookie': BROWSER.cookies || '',
      'X-Inertia': 'true',
      'X-Inertia-Version': BROWSER.inertia || '',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/html;q=0.9,*/*;q=0.8',
      'Referer': `${SC_DOMAIN}/`
    }
  });

  if (res.status === 409 && retry) {
    const newVersion =
      res.headers['x-inertia-version'] ||
      res.headers['X-Inertia-Version'];

    if (newVersion) {
      BROWSER.inertia = newVersion;
      console.log(`[♻️] Inertia aggiornata: ${BROWSER.inertia}`);
      return fetchSC(url, false);
    }

    await syncBrowser();
    return fetchSC(url, false);
  }

  if (res.status >= 400) {
    throw new Error(`SC ${res.status} su ${url}`);
  }

  return res.data;
}

const builder = new addonBuilder({
  id: 'org.meezie.pro.v10',
  version: '10.0.2',
  name: 'Meezie Pro SC',
  description: 'Addon Stremio per stream http',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
  const cached = getCache(id);
  if (cached) return { streams: [cached] };

  const [imdbId, season, episode] = String(id).split(':');

  try {
    if (!TMDB_KEY) {
      console.error('[❌] TMDB_KEY mancante');
      return { streams: [] };
    }

    const tmdb = await axios.get(
      `https://api.themoviedb.org/3/find/${imdbId}`,
      {
        params: {
          api_key: TMDB_KEY,
          external_source: 'imdb_id',
          language: 'it-IT'
        },
        timeout: 15000
      }
    );

    const item = tmdb.data?.movie_results?.[0] || tmdb.data?.tv_results?.[0];
    if (!item) return { streams: [] };

    const title = item.title || item.name;
    const searchData = await fetchSC(`${SC_DOMAIN}/it/search?q=${encodeURIComponent(title)}`);
    const results = searchData?.props?.titles?.data || searchData?.props?.titles || [];

    const match = results.find(r => {
      const n = slugify(r.name || r.title);
      const t = slugify(title);
      return n === t || n.includes(t) || t.includes(n);
    });

    if (!match) return { streams: [] };

    let watchUrl = `${SC_DOMAIN}/it/watch/${match.id}`;

    if (type === 'series' && season && episode) {
      const sData = await fetchSC(`${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`);
      const epObj = (sData?.props?.loadedSeason?.episodes || [])
        .find(e => String(e.number) === String(episode));
      if (!epObj) return { streams: [] };
      watchUrl += `?e=${epObj.id}`;
    }

    const page = await fetchSC(watchUrl);
    const embedUrl = page?.props?.embedUrl;
    if (!embedUrl) return { streams: [] };

    const embedRes = await axios.get(embedUrl, {
      timeout: 15000,
      headers: { 'User-Agent': BROWSER.ua || 'Mozilla/5.0' }
    });

    const html = embedRes.data || '';
    const token = html.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
    const expires = html.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
    const vixId = embedUrl.split('/').filter(Boolean).pop();

    if (!token || !expires || !vixId) return { streams: [] };

    const stream = {
      url: `https://vixcloud.co/playlist/${vixId}?token=${token}&expires=${expires}&h=1`,
      title: 'Meezie 🚀 Vix-Master'
    };

    const ttl = Math.max(60000, Number(expires) * 1000 - Date.now() - 30000);
    setCache(id, stream, ttl);

    return { streams: [stream] };
  } catch (e) {
    console.error(`[💀] Errore stream handler: ${e.message}`);
    return { streams: [] };
  }
});

const PORT = process.env.PORT || 10000;
serveHTTP(builder.getInterface(), { port: PORT });

(async () => {
  try {
    const { data } = await axios.get(LISTA_URL, { timeout: 10000 });
    const live = String(data)
      .split('\n')
      .map(x => x.trim())
      .find(l => l && l.includes('streamingcommunity'));
    if (live) SC_DOMAIN = live.replace(/\/$/, '');
  } catch (e) {
    console.error(`[⚠️] domini.txt non letto: ${e.message}`);
  }

  console.log(`[🌐] Target: ${SC_DOMAIN}`);
  await syncBrowser();
  setInterval(syncBrowser, 25 * 60 * 1000);
})();
