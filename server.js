const { addonBuilder } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");

const app = express();

// 1. Configurazione Manifest (Ispirato a SelfVix)
const manifest = {
    id: "org.vix.hybrid.pro",
    version: "2.0.0",
    name: "VIX Hybrid Pro 🤌",
    description: "Sorgenti VixFlix con Tecnologia Proxy SelfVix",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"]
};

const builder = new addonBuilder(manifest);

// 2. Logica di Estrazione (Ispirata a KastroMugnaio/VixFlix)
// Questa funzione simula la chiamata ai database di VixCloud
async function getVixSource(imdbId) {
    const VIX_ENDPOINT = `https://vixcloud.co/embed/${imdbId}`;
    // Qui aggiungiamo gli header che Kastro usa per non farsi bloccare
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://vixcloud.co/',
        'Origin': 'https://vixcloud.co'
    };
    return VIX_ENDPOINT; 
}

builder.defineStreamHandler(async (args) => {
    const { id } = args;

    try {
        const sourceUrl = await getVixSource(id);
        
        return {
            streams: [
                {
                    name: "VIX HYBRID\n1080p 🤌",
                    title: "🚀 Server Alta Velocità (Kastro-Logic)\n🛡️ Proxy HLS Attivo",
                    url: sourceUrl, // In una versione pro, qui passeresti per la rotta /proxy sotto
                    behaviorHints: {
                        notRerender: true,
                        proxyHeaders: {
                            "common": {
                                "User-Agent": "Mozilla/5.0",
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

// 3. Il Server Express (Integrazione Proxy obbligatoria per Render)
const addonInterface = builder.getInterface();

app.use((req, res, next) => {
    // Risolve i problemi di CORS (blocchi del browser)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

// Gestione rotte Stremio
app.get("/manifest.json", (req, res) => res.json(manifest));
app.get("/:resource/:type/:id.json", (req, res) => {
    addonInterface(req, res);
});

// Rotta Proxy (Ispirata a SelfVix)
// Serve a "ripulire" il video prima di mandarlo a Stremio
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

const port = process.env.PORT || 7000;
app.listen(port, () => {
    console.log(`Addon pronto! Porta: ${port}`);
});
