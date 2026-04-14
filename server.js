const { addonBuilder } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");

const app = express();

// --- FIX: Aggiunto catalogs come array vuoto per evitare l'errore su Render ---
const manifest = {
    id: "org.vix.hybrid.pro",
    version: "2.0.1",
    name: "VIX Hybrid Pro 🤌",
    description: "Sorgenti VixFlix con Tecnologia Proxy SelfVix",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [] // <--- Questo risolve il crash!
};

const builder = new addonBuilder(manifest);

// Logica di Estrazione (Ispirata a KastroMugnaio)
async function getVixSource(imdbId) {
    // Costruiamo l'embed basato sull'ID
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
                    title: "🚀 Server: VixCloud (Kastro-Logic)\n🛡️ Proxy HLS: Attivo",
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

const addonInterface = builder.getInterface();

// Middleware per CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

// Rotte Stremio
app.get("/manifest.json", (req, res) => res.json(manifest));
app.get("/:resource/:type/:id.json", (req, res) => {
    addonInterface(req, res);
});

// Rotta Proxy generica
app.get("/proxy", async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).send("URL mancante");
    
    try {
        const response = await axios.get(videoUrl, {
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        response.data.pipe(res);
    } catch (e) {
        res.status(500).send("Errore Proxy");
    }
});

// Avvio del server
const port = process.env.PORT || 7000;
app.listen(port, () => {
    console.log(`Addon corretto e pronto!`);
});
