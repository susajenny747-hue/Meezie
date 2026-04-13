require('dotenv').config();

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const TMDB_KEY = process.env.TMDB_KEY || '';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-b7ab.up.railway.app';
const LISTA_URL = 'https://raw.githubusercontent.com/susajenny747-hue/Meezie/main/domini.txt';

let SC_DOMAIN = 'https://streamingcommunityz.moe';
let BROWSER = { ua: '', cookies: '', inertia: '' };
const CACHE = new Map();

const api = axios.create({
  timeout: 20000,
  maxRedirects: 0,
  validateStatus: () => true
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

function setCache(key, value, ttlMs) {
  CACHE.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function absoluteUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return new URL(u, SC_DOMAIN).toString();
}

async function syncBrowser() {
  console.log('[📡] Sincronizzazione sessione...');
  try {
    const res = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'request.get',
      url: SC_DOMAIN,
      maxTimeout: 60000
    }, { timeout: 70000 });

    if (res.data?.status === 'ok') {
      BROWSER.cookies = (res.data.solution.cookies || [])
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
      BROWSER.ua = res.data.solution.userAgent || 'Mozilla/5.0';

      const html = res.data.solution.response || '';
      const versionMatch = html.match(/version&quot;:&quot;([^&]+)&quot;/);
      if (versionMatch) BROWSER.inertia = versionMatch[1];

      console.log(`[✅] Sessione Pronta (V: ${BROWSER.inertia || 'n/d'})`);
      return true;
    }
  } catch (e) {
    console.error(`[❌] Errore FlareSolverr: ${e.message}`);
  }
  return false;
}

function buildHeaders(isInertia = true, referer = `${SC_DOMAIN}/`) {
  const headers = {
    'User-Agent': BROWSER.ua || 'Mozilla/5.0',
    'Cookie': BROWSER.cookies || '',
    'Referer': referer,
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7'
  };

  if (isInertia) {
    headers['X-Inertia'] = 'true';
    headers['X-Requested-With'] = 'XMLHttpRequest';
    headers['Accept'] = 'application/json, text/plain, */*';
    if (BROWSER.inertia) headers['X-Inertia-Version'] = BROWSER.inertia;
  } else {
    headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  }

  return headers;
}

async function requestWithRecovery(url, mode = 'inertia', depth = 0) {
  if (depth > 4) throw new Error(`Troppi redirect/retry su ${url}`);

  const isInertia = mode === 'inertia';
  const res = await api.get(url, {
    headers: buildHeaders(isInertia, `${SC_DOMAIN}/`)
  });

  if (res.status >= 300 && res.status < 400 && res.headers.location) {
    const nextUrl = absoluteUrl(res.headers.location);
    return requestWithRecovery(nextUrl, mode, depth + 1);
  }

  if (res.status === 409) {
    const loc = res.headers['x-inertia-location'] || res.headers['X-Inertia-Location'];
    const ver = res.headers['x-inertia-version'] || res.headers['X-Inertia-Version'];

    if (ver) {
      BROWSER.inertia = ver;
      console.log(`[♻️] Nuova versione Inertia: ${BROWSER.inertia}`);
    }

    if (loc) {
      const nextUrl = absoluteUrl(loc);
      console.log(`[↪️] Redirect Inertia verso: ${nextUrl}`);
      return requestWithRecovery(nextUrl, 'html', depth + 1);
    }

    if (isInertia) {
      await syncBrowser();
      return requestWithRecovery(url, 'html', depth + 1);
    }
  }

  if (res.status >= 200 && res.status < 300) return res;

  throw new Error(`SC ${res.status} su ${url}`);
}

async function fetchSCJson(url) {
  const res = await requestWithRecovery(url, 'inertia');
  if (typeof res.data === 'object') return res.data;

  try {
    return JSON.parse(res.data);
  } catch {
    throw new Error(`Risposta non JSON su ${url}`);
  }
}

async function fetchSCHtml(url) {
  const res = await requestWithRecovery(url, 'html');
  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
}

function extractEmbedUrlFromHtml(html) {
  if (!html) return null;

  const patterns = [
    /"embedUrl":"([^"]+)"/,
    /embedUrl&quot;:&quot;([^&]+)&quot;/,
    /data-embed-url="([^"]+)"/,
    /src="(https?:\/\/[^"]*vix[^"]*)"/i,
    /src="(https?:\/\/[^"]*embed[^"]*)"/i
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) {
      return m[1]
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&');
    }
  }

  return null;
}

async function searchTitleOnSC(title) {
  const searchUrl = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(title)}`;

  try {
    const searchData = await fetchSCJson(searchUrl);
    const results = searchData?.props?.titles?.data || searchData?.props?.titles || [];
    if (Array.isArray(results) && results.length) return results;
  } catch (e) {
    console.log(`[⚠️] Search JSON fallita: ${e.message}`);
  }

  const html = await fetchSCHtml(searchUrl);
  const matches = [...html.matchAll(/\/it\/titles\/(\d+)-([^"'\/\s<]+)/g)]
    .map(m => ({ id: m[1], slug: m[2], name: m[2].replace(/-/g, ' ') }));

  return matches;
}

async function getWatchPage(match, type, season, episode) {
  if (type === 'series' && season && episode) {
    try {
      const sData = await fetchSCJson(`${SC_DOMAIN}/it/titles/${match.id}-${match.slug}/seasons/${season}`);
      const epObj = (sData?.props?.loadedSeason?.episodes || [])
        .find(e => String(e.number) === String(episode));

      if (epObj) {
        return `${SC_DOMAIN}/it/watch/${match.id}?e=${epObj.id}`;
      }
    } catch (e) {
      console.log(`[⚠️] Episodi JSON falliti: ${e.message}`);
    }
  }

  return `${SC_DOMAIN}/it/watch/${match.id}`;
}

const builder = new addonBuilder({
  id: 'org.meezie.pro.v10',
  version: '10.0.3',
  name: 'Meezie Pro SC',
  description: 'Addon Stremio per stream http',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
});

builder.defineStreamHandler(async ({ type, id }) => {
  const cached = getCache(id);
  if (cached) {
    return { streams: [cached], cacheMaxAge: 60 };
  }

  const [imdbId, season, episode] = String(id).split(':');

  try {
    if (!TMDB_KEY) {
      console.error('[❌] TMDB_KEY mancante');
      return { streams: [] };
    }

    const tmdb = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
      params: {
        api_key: TMDB_KEY,
        external_source: 'imdb_id',
        language: 'it-IT'
      },
      timeout: 15000
    });

    const item = tmdb.data?.movie_results?.[0] || tmdb.data?.tv_results?.[0];
    if (!item) return { streams: [] };

    const title = item.title || item.name;
    const results = await searchTitleOnSC(title);
    if (!results.length) return { streams: [] };

    const wanted = slugify(title);
    const match = results.find(r => {
      const name = slugify(r.name || r.title || r.slug || '');
      return name === wanted || name.includes(wanted) || wanted.includes(name);
    }) || results[0];

    const watchUrl = await getWatchPage(match, type, season, episode);

    let embedUrl = null;

    try {
      const pageJson = await fetchSCJson(watchUrl);
      embedUrl = pageJson?.props?.embedUrl || null;
    } catch (e) {
      console.log(`[⚠️] Watch JSON fallita: ${e.message}`);
    }

    if (!embedUrl) {
      const watchHtml = await fetchSCHtml(watchUrl);
      embedUrl = extractEmbedUrlFromHtml(watchHtml);
    }

    if (!embedUrl) return { streams: [] };

    const {  html } = await axios.get(embedUrl, {
      timeout: 15000,
      headers: { 'User-Agent': BROWSER.ua || 'Mozilla/5.0' }
    });

    const token = html.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
    const expires = html.match(/"expires"\s*:\s*"(\d+)"/)?.[1];
    const vixId = embedUrl.split('/').filter(Boolean).pop();

    if (!token || !expires || !vixId) return { streams: [] };

    const stream = {
      url: `https://vixcloud.co/playlist/${vixId}?token=${token}&expires=${expires}&h=1`,
      title: 'Meezie 🚀 Vix-Master'
    };

    const ttl = Math.max(60000, (Number(expires) * 1000) - Date.now() - 30000);
    setCache(id, stream, ttl);

    return {
      streams: [stream],
      cacheMaxAge: 60,
      staleRevalidate: 120,
      staleError: 300
    };
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
