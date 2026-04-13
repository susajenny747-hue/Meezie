// ─── DEBUG: analizza homepage per trovare endpoint search ────────────────────
async function debugHomepage() {
  try {
    console.log('[🔍 Debug] Fetching homepage...');
    const { data: html } = await axios.get(SC_DOMAIN, {
      headers: getHeaders(),
      timeout: 15000
    });

    const str = typeof html === 'string' ? html : JSON.stringify(html);

    // Cerca form di ricerca
    const formMatch   = str.match(/<form[^>]*action=["']([^"']+)["'][^>]*>/g);
    const searchMatch = str.match(/search[^"'<>]{0,50}/gi);
    const apiMatch    = str.match(/["'](\/api\/[^"'<>]+)["']/g);
    const routeMatch  = str.match(/["'](\/[a-z-]+\/[a-z-]+)["']/g);

    console.log('[🏠 Form actions]', formMatch?.slice(0,5));
    console.log('[🏠 Search refs]', searchMatch?.slice(0,10));
    console.log('[🏠 API routes]', apiMatch?.slice(0,10));
    console.log('[🏠 Routes]', routeMatch?.slice(0,10));
    console.log('[🏠 Primi 1000 char]', str.substring(0, 1000));

  } catch (e) {
    console.warn('[⚠️ Debug homepage]', e.message);
  }
}

async function avvio() {
  await aggiornaDominio();
  await inizializzaSessione();
  await debugHomepage(); // ← aggiunto
  setInterval(aggiornaDominio,     6 * 60 * 60 * 1000);
  setInterval(inizializzaSessione,  2 * 60 * 60 * 1000);
}
