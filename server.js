const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");

const app = express();

// 1. Configurazione Manifest
const manifest = {
    id: "org.vix.hybrid.pro",
    version: "2.0.1",
    name: "VIX Hybrid Pro 🤌",
    description: "Sorgenti VixFlix con Tecnologia Proxy SelfVix",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"]
};

const builder = new addonBuilder(manifest);

// 2. Logica di Estrazione
async function getVixSource(imdbId) {
    // Simulazione link Vix
    return `https://vixcloud.co/embed/${imdbId}`; 
}

builder.defineStreamHandler(async (args) => {
    const { id } = args;
    try {
        const sourceUrl = await getVixSource(id);
        return {
            streams: [
                {
                    name: "VIX HYBRID\n1080p 🤌",
                    title: "🚀 Server: VixCloud\n🛡️ Proxy HLS Attivo",
                    url: sourceUrl,
                    behaviorHints: {
                        notRerender: true,
                        proxyHeaders: {
                            "common": {
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                                "Referer": "https://vixcloud.co/"
                            }
                        }
                    }
                }
            ]
        };
    } catch (e) {
        return { streams: [] };
    }
});

// --- FIX ERRORE: Gestione corretta dell'interfaccia ---
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

// Usiamo il router ufficiale di Stremio su Express
app.use(router);

// Rotta Proxy opzionale (se vuoi far passare il video dal tuo server)
app.get("/proxy", async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send("No URL provided");
    try {
        const response = await axios.get(videoUrl, {
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        response.data.pipe(res);
    } catch (e) {
        res.status(500).send("Proxy error");
    }
});

// Porta per Render
const port = process.env.PORT || 7000;
app.listen(port, () => {
    console.log(`Addon corretto e pronto su porta: ${port}`);
    console.log(`Installa su Stremio: https://meezie.onrender.com/manifest.json`);
});
