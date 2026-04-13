async function flareRequest(url) {
    try {
        console.log(`[☁️] FlareSolverr sta risolvendo: ${url.split('?')[0]}`);
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url: url,
            maxTimeout: 30000 // Ridotto per non far morire Stremio
        }, { timeout: 35000 });

        if (response.data.status === 'ok') {
            return {
                html: response.data.solution.response,
                ua: response.data.solution.userAgent
            };
        }
    } catch (e) {
        console.error(`[❌] FlareSolverr Timeout o Errore: ${e.message}`);
    }
    return null;
}

async function searchSC(query) {
    const q = cleanTitle(query);
    const searchUrl = `${SC_DOMAIN}/it/search?q=${encodeURIComponent(q)}`;
    
    const sol = await flareRequest(searchUrl);
    if (!sol) return [];

    try {
        // Metodo di estrazione più robusto per il data-page
        const html = sol.html;
        const startMarker = 'data-page="';
        const startIdx = html.indexOf(startMarker);
        if (startIdx !== -1) {
            let content = html.substring(startIdx + startMarker.length);
            const endIdx = content.indexOf('"');
            content = content.substring(0, endIdx)
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, '&');
            
            const jsonData = JSON.parse(content);
            const results = jsonData.props.titles?.data || jsonData.props.data || [];
            console.log(`[📊] "${q}" -> Trovati: ${results.length}`);
            return results;
        }
    } catch (e) {
        console.error(`[❌] Errore estrazione dati: ${e.message}`);
    }
    return [];
}
