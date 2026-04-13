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

    // Cerca data-fp (fingerprint usato come Inertia version)
    const fpMatch = html.match(/data-fp="([^"]+)"/);
    // Cerca anche nel formato classico Inertia
    const versionMatch = html.match(/"version"\s*:\s*"([^"]+)"/)
                      || html.match(/X-Inertia-Version['":\s]+([a-zA-Z0-9]+)/);

    if (fpMatch) {
      SC_INERTIA_VERSION = fpMatch[1];
      console.log('[✅ Inertia version da data-fp]', SC_INERTIA_VERSION);
    } else if (versionMatch) {
      SC_INERTIA_VERSION = versionMatch[1];
      console.log('[✅ Inertia version]', SC_INERTIA_VERSION);
    } else {
      // Ultimo tentativo: cerca data-page nell'HTML completo
      const pageMatch = html.match(/data-page='([^']+)'/)
                     || html.match(/data-page="([^"]+)"/);
      if (pageMatch) {
        try {
          const pageJson = JSON.parse(
            pageMatch[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'")
          );
          SC_INERTIA_VERSION = pageJson?.version || '';
          console.log('[✅ Inertia version da data-page]', SC_INERTIA_VERSION);
        } catch(e) {}
      }
      if (!SC_INERTIA_VERSION) {
        console.warn('[⚠️] Nessuna version trovata, uso stringa vuota');
        SC_INERTIA_VERSION = '';
      }
    }

    console.log('[✅ Sessione ok] Cookies:', SC_COOKIES.substring(0, 80) + '...');
    console.log('[✅ UserAgent]', SC_USERAGENT);
  } catch (e) {
    console.warn('[⚠️ Sessione]', e.message);
  }
}
