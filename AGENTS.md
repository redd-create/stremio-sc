# Stremio StreamingCommunity Add-on

> AI agent context file. Read this first to understand the project before making changes.

## Overview

Unofficial Stremio add-on that scrapes **streaming-community.watch** (an Italian streaming site) and exposes film and TV series as Stremio catalogs with direct `m3u8` HLS streams.

- **What it does**: Lets Stremio browse and play Italian-dubbed/subbed movies and series from StreamingCommunity.
- **How it works**: Scrapes the public HTML of the site, resolves the VidXgo embed, and **decrypts the stream URL in pure JavaScript** (XOR + base64) — no headless browser, no Puppeteer.
- **Version**: 3.0.0
- **Key design principle**: NO Puppeteer / NO headless browser. The VidXgo embed is decoded with a pure-JS XOR decryption inspired by the StreamViX/MammaMia approach.

## Tech Stack

| Layer            | Technology                         |
|------------------|------------------------------------|
| Runtime          | Node.js (CommonJS modules)         |
| HTTP client      | `node-fetch` v2.7.0                |
| HTML parsing     | `cheerio` v1.2.0                   |
| Add-on framework | `stremio-addon-sdk` v1.6.10        |
| Server           | `serveHTTP` from stremio-addon-sdk |
| Default port     | 7000 (override via `PORT` env var) |

## Project Structure

```
ADD ON STREAMING COMMUNITY/
├── package.json          # Manifesto Node.js v3.0.0 (CommonJS)
├── package-lock.json     # Lockfile delle dipendenze
├── scraper.js            # Core scraping + VidXgo XOR decryption (367 righe)
├── server.js             # Stremio add-on server: catalog + stream handlers (175 righe)
├── start.sh              # Bash launch script (porta configurabile, default 7000)
├── node_modules/         # Dipendenze installate
└── AGENTS.md             # Questo file — contesto per agenti AI
```

Only two source files matter: `scraper.js` (data layer) and `server.js` (Stremio integration layer).

## Architecture

### scraper.js — Data & Decryption Layer

**Constants**
- `BASE_URL` = `https://streaming-community.watch`
- `VIDXGO_DOMAIN` = `https://v.vidxgo.co`

**In-memory cache** (`scraper.js:8-28`)
- `Map`-based cache with TTL = 30 minutes (`CACHE_TTL`).
- `getCached(key)` / `setCache(key, data)`.
- Eviction: when cache grows beyond 500 entries, stale entries are purged.
- Keys: `page_<url>`, `catalog_<type>_<skip>`, `search_<query>`, `stream_<imdbId>_<type>_<season>_<episode>`.
- ⚠️ Cache is in-memory only — lost on every restart.

**`fetchPage(url, retries=3)`** (`scraper.js:33-70`)
- HTTP GET with Firefox-like headers (User-Agent, Sec-Fetch-*, DNT, Accept-Language).
- Retries up to 3 times with exponential backoff (`2000 * attempt` ms).
- `follow: 10` redirects, `timeout: 20000` ms.
- Returns empty string on final failure (does NOT throw).
- Results cached under `page_<url>`.

**`extractItems(html)`** (`scraper.js:75-142`)
- Parses a listing/search HTML page with cheerio.
- Builds a `posterMap` linking each StreamingCommunity ID (`scId`) → `{ imdbId, poster }`.
- IMDb ID is extracted from poster image URLs matching `posters/(tt\d+)\.webp`.
- Title links match regex `/titles/(\d+)-([^"'\?]+)\.html` → captures `scId` + `slug`.
- Name resolution order: `title` attr → nearby `.name/.title-2/h2/h3` → slug-derived fallback (strips `guarda-`, `-streaming`, `-community`, title-cases the rest).
- Returns array of `{ scId, slug, name, imdbId, poster, url }`. Dedupes by `scId`.

**`decodeVidXgoHtml(html)`** (`scraper.js:152-228`) — ⭐ core decryption
1. Collects all inline `<script>` tags (ignores external `src=` scripts).
2. Finds the script matching pattern: `var <name> = '<key>', d = atob('<base64>')`.
3. Base64-decodes the payload → `Buffer`.
4. XOR-decrypts cyclically with the key: `out[i] = decoded[i] ^ key.charCodeAt(i % key.length)`.
5. Searches the decrypted JS for the m3u8 URL using 4 regex patterns, in order:
   - `currentSrc..."(https:...m3u8...)"`
   - `"(https?://...m3u8...)"`
   - `(https?://...m3u8...)` (unquoted)
   - `(hlsSrc|src|url|file)\s*[=:]\s*["']?(https?://...m3u8...)`
6. Strips backslashes from the result. Returns `null` if nothing matches.

**`fetchAndExtractVidXgo(embedUrl)`** (`scraper.js:234-285`)
- Fetches the VidXgo embed page with Firefox UA + `Referer: https://altadefinizione.you/` (fake referer, StreamViX/MammaMia trick).
- Calls `decodeVidXgoHtml()` on the HTML.
- Returns `{ m3u8, playbackHeaders }` where `playbackHeaders` are Chrome-like headers with `Referer` and `Origin` set to `VIDXGO_DOMAIN` — these are meant for Stremio's `proxyHeaders` so the player can fetch the stream segments.

**`resolveStream(imdbId, type, season, episode)`** (`scraper.js:291-326`)
- Strips `tt` prefix → `vidxgoId`.
- Builds embed URL:
  - Movies / default: `https://v.vidxgo.co/{vidxgoId}`
  - Series: `https://v.vidxgo.co/{vidxgoId}/{season}/{episode}`
- Calls `fetchAndExtractVidXgo()`.
- Returns `{ m3u8, playbackHeaders, imdbId }`. Result cached under `stream_<...>`.

**`getCatalog(type, skip=0)`** (`scraper.js:334-345`)
- Fetches `${BASE_URL}/film/` or `${BASE_URL}/series/`.
- Parses with `extractItems()` and tags each item with `type`.
- ⚠️ **Known limitation**: the `skip` parameter is accepted but **not used for pagination** — only the first page of the listing is fetched. The Stremio `skip` extra will always return the same first page.

**`search(query)`** (`scraper.js:350-361`)
- Hits `${BASE_URL}/index.php?do=search&subaction=search&story=<query>`.
- Returns items with `type: null` (caller assigns the type).

**Exports** (`scraper.js:363-367`): `BASE_URL, fetchPage, extractItems, getCatalog, search, resolveStream, decodeVidXgoHtml, fetchAndExtractVidXgo, imdbToScMapLocal`.

### server.js — Stremio Add-on Layer

**Manifest** (`server.js:4-38`)
- `id`: `community.streaming.addon`
- `version`: `3.0.0`
- `resources`: `['catalog', 'stream']`
- `types`: `['movie', 'series']`
- `idPrefixes`: `['tt']` — only IMDb IDs (`tt123456`) are handled.
- Two catalogs:
  - `sc_film` → type `movie`, name "Film (StreamingCommunity)"
  - `sc_series` → type `series`, name "Serie TV (StreamingCommunity)"
  - Both support `search` and `skip` extras.
- `behaviorHints`: `configurable: false`, `configurationRequired: false`.

**`itemToMeta(item, type)`** (`server.js:43-55`)
- Converts a scraper item to a Stremio meta object: `{ id, type, name, poster }`.
- `id` = `item.imdbId` if available, else `sc{scId}` (fallback — these non-`tt` IDs will NOT be playable because `idPrefixes` is `['tt']`).
- Populates two maps linking `imdbId` → item: the local `imdbToScMap` and `scraper.imdbToScMapLocal`.

**Catalog handler** (`server.js:60-80`)
- If `extra.search` is set → calls `scraper.search()` and maps results.
- Else dispatches on catalog `id`: `sc_film` → `getCatalog('movie', skip)`, `sc_series` → `getCatalog('series', skip)`.
- Returns `{ metas: [...] }`. On error returns `{ metas: [] }`.

**Stream handler** (`server.js:93-146`)
- Rejects IDs not starting with `tt`.
- Parses Stremio series ID format `tt<imdb>:<season>:<episode>` (colon-separated).
- Calls `scraper.resolveStream(imdbId, type, season, episode)`.
- On success returns a single stream:
  - `title`: `StreamingCommunity ITA 🇮🇹` (+ ` S{season}E{episode}` for series)
  - `url`: the m3u8
  - `behaviorHints`: `notWebReady: true`, `bingeGroup: sc-{imdbId}`, `proxyHeaders: { request: playbackHeaders }`
- **Fallback** when no m3u8 is found: returns the raw VidXgo embed URL `https://v.vidxgo.co/{vidxgoId}` (titled "StreamingCommunity (apri nel browser)") — this is generally NOT playable by Stremio directly.
- On error returns `{ streams: [] }`.

**Server startup** (`server.js:148-175`)
- `PORT` from env, default `7000`. Binds to `0.0.0.0` (reachable from LAN).
- Uses `serveHTTP(addonInterface, { port, host })` from the SDK.
- Prints the local install URL: `http://127.0.0.1:{PORT}/manifest.json`.

### start.sh
- Bash launcher: `PORT=${1:-7000}; PORT=$PORT node server.js`.
- `cd`s to its own directory so it works from anywhere.
- Usage: `./start.sh` or `./start.sh 8080`.

## Data Flow

### Catalog flow
```
Stremio → GET /catalog/movie/sc_film.json?skip=0
        → server.js CatalogHandler
        → scraper.getCatalog('movie', 0)
        → fetchPage('https://streaming-community.watch/film/')
        → extractItems(html)  [cheerio parse → posterMap + title links]
        → itemToMeta() per item  [imdbId as Stremio id, fills imdbToScMap]
        → { metas: [...] } → Stremio renders posters
```

### Search flow
```
Stremio → GET /catalog/...?search=matrix
        → scraper.search('matrix')
        → fetchPage('.../index.php?do=search&subaction=search&story=matrix')
        → extractItems(html) → { metas: [...] }
```

### Stream flow
```
Stremio → GET /stream/movie/tt123456.json
        (or /stream/series/tt123456:1:3.json for S1E3)
        → server.js StreamHandler
        → parse id → imdbId=tt123456, season=1, episode=3
        → scraper.resolveStream('tt123456','series',1,3)
        → vidxgoId = 123456
        → fetchAndExtractVidXgo('https://v.vidxgo.co/123456/1/3')
              → fetch with Firefox UA + altadefinizione referer
              → decodeVidXgoHtml(html)
                    → find inline script with var K='key', d=atob('...')
                    → base64 decode → XOR decrypt with key
                    → regex extract m3u8 URL
              → returns { m3u8, playbackHeaders }
        → Stremio stream: { url: m3u8, proxyHeaders: { request: playbackHeaders } }
        → Stremio plays HLS via proxyHeaders (Referer/Origin = v.vidxgo.co)
```

## Key Technical Details

- **VidXgo decryption**: pure JS, no Puppeteer. XOR key is cyclic (`key[i % key.length]`). Payload is base64. The decrypted JS contains the m3u8 URL assigned to `currentSrc` / `hlsSrc` / `src`.
- **ID format**:
  - Movies: `tt<imdbId>` (e.g. `tt1234567`)
  - Series episode: `tt<imdbId>:<season>:<episode>` (e.g. `tt1234567:1:3`)
- **IMDb ID source**: extracted from poster image URLs of the form `posters/ttXXXX.webp` on the StreamingCommunity listing pages. Items without a poster matching this pattern get a fallback `sc{scId}` id and are effectively unplayable through the stream handler.
- **Headers strategy**:
  - Page scraping (`fetchPage`): Firefox UA, `Sec-Fetch-Site: none`, `DNT: 1`.
  - VidXgo embed fetch: Firefox UA + `Referer: https://altadefinizione.you/` (bypass trick).
  - Playback (`proxyHeaders.request`): Chrome UA + `Referer`/`Origin: https://v.vidxgo.co` so the HLS CDN accepts segment requests.
- **Cache TTL**: 30 min for everything (pages, catalogs, searches, stream resolutions).
- **`behaviorHints` on streams**: `notWebReady: true` (URL needs the proxy headers), `bingeGroup: sc-{imdbId}` (groups episodes for binge/next-episode).

## Running the Add-on

```bash
# Install dependencies (first time only)
npm install

# Start on default port 7000
npm start
# or
./start.sh

# Start on a custom port
./start.sh 8080
# or
PORT=8080 node server.js
```

Once running, the manifest is served at:
- Local: `http://127.0.0.1:7000/manifest.json`
- LAN (other devices): `http://<YOUR_LOCAL_IP>:7000/manifest.json`

**Install in Stremio**: open Stremio → Add-ons → paste the manifest URL → click Install.

The server binds to `0.0.0.0` so it is reachable from other machines on the same network (useful for Stremio on Android TV / Fire Stick / phones).

## Code Conventions

- **Module system**: CommonJS (`require` / `module.exports`). `package.json` has `"type": "commonjs"`.
- **Comments**: in English; doc-comment style (`/** ... */`) on exported functions.
- **Logs**: `console.log` / `console.error` in English with prefixes like `[VidXgo]`, `Catalog:`, `Stream:`.
- **No Puppeteer / headless browsers** — this is an explicit design goal. Decryption is done with `Buffer` + XOR.
- **Inspiration**: StreamViX / MammaMia projects (referenced in comments at `server.js:85-91` and `scraper.js:144-150`).
- **Error handling**: handlers catch errors and return empty results (`{ metas: [] }` / `{ streams: [] }`) rather than crashing.
- **No tests, no lint config, no TypeScript** currently in the project.

## Dependencies

| Package               | Version | Purpose                                          |
|-----------------------|---------|--------------------------------------------------|
| `cheerio`             | ^1.2.0  | jQuery-like HTML parsing for listing/search pages|
| `node-fetch`          | ^2.7.0  | HTTP client (v2 — CommonJS compatible, ESM in v3)|
| `stremio-addon-sdk`   | ^1.6.10 | `addonBuilder` + `serveHTTP` for the add-on API  |

## Handler & Endpoint Reference

| Handler  | Trigger                                              | Behavior                                                     |
|----------|------------------------------------------------------|--------------------------------------------------------------|
| catalog  | `id=sc_film`, no search                              | `getCatalog('movie', skip)` → first page of `/film/`         |
| catalog  | `id=sc_series`, no search                            | `getCatalog('series', skip)` → first page of `/series/`      |
| catalog  | any `id`, `extra.search` set                         | `search(query)` → site search                                |
| stream   | `id=ttXXXX` (movie)                                  | `resolveStream` → VidXgo decrypt → m3u8                      |
| stream   | `id=ttXXXX:S:E` (series)                             | `resolveStream` with season/episode → VidXgo `/id/S/E`       |
| stream   | `id` not starting with `tt`                          | Returns `{ streams: [] }`                                    |
| stream   | decryption fails                                     | Fallback: raw `https://v.vidxgo.co/{id}` embed URL           |

## Known Limitations & Notes

- **Pagination not implemented**: `skip` is read by the server and passed to `getCatalog`, but `getCatalog` ignores it and always fetches page 1. Infinite scroll / paged browsing in Stremio will keep returning the same items.
- **In-memory cache**: all caches (pages, catalogs, streams) are lost on restart and not shared across processes.
- **Fragile scraping**: selectors depend on the current HTML structure of streaming-community.watch. Changes to the site (class names, URL patterns, poster path format) will silently break item extraction.
- **IMDb ID dependency**: only items whose poster URL contains `posters/ttXXX.webp` get a real IMDb ID and become playable. Items missing this get `sc{scId}` ids that the stream handler refuses (idPrefixes = `['tt']`).
- **VidXgo decryption is brittle**: depends on the exact `var K='...',d=atob('...')` script shape and the 4 regex patterns. If VidXgo changes its obfuscation, `decodeVidXgoHtml` returns `null` and only the non-playable fallback is returned.
- **Legal/ToS**: this add-on scrapes a third-party site; it is unofficial and not affiliated with StreamingCommunity. Use responsibly and in accordance with local law and the target site's terms of service.
- **No HTTPS**: the add-on serves plain HTTP. For remote deployment behind HTTPS, put it behind a reverse proxy (nginx/Caddy) and point Stremio at the HTTPS manifest URL.
- **`imdbToScMap` / `imdbToScMapLocal`**: two parallel maps are maintained (one in `server.js`, one in `scraper.js`) but they are not actually consulted by `resolveStream`, which derives the VidXgo ID directly from the IMDb ID. They exist for potential future lookups.
