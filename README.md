---
title: Stremio StreamingCommunity
emoji: 🎬
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Stremio StreamingCommunity Add-on

Add-on Stremio non ufficiale per **streaming-community.watch** (film e serie TV in streaming ITA con m3u8 diretto).

- Decrittazione VidXgo in JS puro (XOR + base64) — niente Puppeteer/headless browser.
- Cataloghi `sc_film` (movie) e `sc_series` (series) + ricerca.
- Stream HLS con `proxyHeaders` (Referer/Origin `v.vidxgo.co`).

## Manifest URL (dopo il deploy su HF Spaces)

```
https://<tuo-username>-stremio-sc.hf.space/manifest.json
```

## Install in Stremio

Apri Stremio → Add-ons → incolla l'URL del manifest → Install.

## Variabili d'ambiente

| Var              | Default | Note                                            |
|------------------|---------|-------------------------------------------------|
| `PORT`           | 7860    | Forzata a 7860 da Dockerfile (richiesta da HF)  |
| `STREAM_DELAY_MS`| 0       | Ritardo stream (debrid priority) — opzionale    |

## Sviluppo locale

```bash
npm install
npm start          # porta 7000
# oppure
PORT=8080 node server.js
```
