# Stremio StreamingCommunity Add-on

> AI agent context file. Read this first to understand the project before making changes.

## Overview

Unofficial Stremio add-on that scrapes **streaming-community.watch** (an Italian streaming site) and exposes film and TV series as Stremio catalogs with `m3u8` HLS streams proxied through **EasyProxy**.

- **What it does**: Lets Stremio browse and play Italian-dubbed/subbed movies and series from StreamingCommunity.
- **How it works**: Scrapes the public HTML of the site (via Cloudflare Worker proxy to bypass datacenter IP blocks), then delegates VidXgo embed resolution and HLS proxying to EasyProxy — which handles background token refresh and per-segment CDN auth.
- **Version**: 3.1.0
- **Key design principle**: VidXgo resolution + HLS proxying delegated to EasyProxy. The add-on itself only handles catalogs/search and builds the EasyProxy URL for streams.

## Tech Stack

| Layer            | Technology                         |
|------------------|------------------------------------|
| Runtime          | Node.js 20 (CommonJS modules)      |
| HTTP client      | `node-fetch` v2.7.0                |
| HTML parsing     | `cheerio` v1.2.0                   |
| Add-on framework | `stremio-addon-sdk` v1.6.10        |
| Server           | `serveHTTP` from stremio-addon-sdk |
| HLS proxy        | EasyProxy (external, Python)       |
| Catalog proxy    | Cloudflare Worker (external, JS)   |
| Default port     | 7000 (override via `PORT` env var) |

## Project Structure

```
ADD ON STREAMING COMMUNITY/
├── package.json          # Manifesto Node.js v3.1.0 (CommonJS)
├── package-lock.json     # Lockfile delle dipendenze
├── scraper.js            # Core scraping + VidXgo XOR decryption (374 righe)
├── server.js             # Stremio add-on server: catalog + stream handlers (200 righe)
├── worker.js             # Cloudflare Worker: reverse proxy per streaming-community.watch
├── Dockerfile            # Deploy su Render (node:20-alpine)
├── start.sh              # Bash launch script (porta configurabile, default 7000)
├── README.md             # Docs + frontmatter HF/Render
├── .gitignore            # Esclude node_modules/
├── node_modules/         # Dipendenze installate
└── AGENTS.md             # Questo file — contesto per agenti AI
```

Two source files matter for the add-on: `scraper.js` (data layer) and `server.js` (Stremio integration layer). `worker.js` is a separate Cloudflare Worker deployment.

## Deployment Architecture (v3.1)

```
┌─────────────────────────────────────────────────────────────┐
│  Render (stremio-sc.onrender.com) — Node.js add-on          │
│                                                              │
│  /manifest.json    → Stremio SDK                             │
│  /catalog/*        → scraper.js → Cloudflare Worker → SC     │
│  /stream/*         → builds EasyProxy URL (no VidXgo call)   │
│                     returns: {EASYPROXY_URL}/proxy/hls/...   │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────────┐    ┌──────────────────────────────────┐
│ Cloudflare Worker   │    │ HuggingFace Spaces               │
│ scproxy.leonardo-   │    │ leoo-q4-easyproxy2.hf.space      │
│ andreuzzi01.workers │    │                                  │
│ .dev                │    │  EasyProxy (Python, 2 vCPU)      │
│                     │    │  - Resolves VidXgo embed (XOR)   │
│ Proxy reverse per   │    │  - Background token refresh 60s  │
│ streaming-community │    │  - Per-segment URL rewrite       │
│ .watch (bypass IP   │    │  - Referer/Origin injection      │
│ block su Render)    │    │  - Returns m3u8 + .ts to player  │
└─────────────────────┘    └──────────────────────────────────┘
                                     │
                                     ▼
                           ┌──────────────────────┐
                           │ VidXgo CDN           │
                           │ media-XXX.d2b.you    │
                           │ (token: ?t=&e=&b=)   │
                           └──────────────────────┘
```

### Why this architecture

1. **Cloudflare Worker**: `streaming-community.watch` blocks Render's datacenter IPs. The Worker (Cloudflare edge IP) proxies catalog/search requests. VidXgo CDN is NOT blocked, so no proxy needed for streams.
2. **EasyProxy**: VidXgo m3u8 tokens (`?t=...&e=...`) expire after ~2 min. Direct playback freezes when the token expires. EasyProxy refreshes the token in background (async) and rewrites per-segment URLs at fetch time — zero freeze, zero black screen.
3. **HuggingFace Spaces**: 2 vCPU free (vs Render's 0.1 CPU). Segment download in 3-6s (vs 7-30s on Render free) — under the 6s threshold for smooth playback.

## Environment Variables

| Var                  | Required | Default                    | Purpose                                              |
|----------------------|----------|----------------------------|------------------------------------------------------|
| `PORT`               | No       | `7000`                     | Server port (Render sets this automatically)         |
| `PROXY_URL`          | No       | (empty)                    | Cloudflare Worker URL for SC catalog proxy           |
| `EASYPROXY_URL`      | **Yes**  | (empty)                    | EasyProxy base URL (without trailing slash)          |
| `EASYPROXY_PASSWORD` | No       | (empty)                    | EasyProxy API password                               |
| `STREAM_DELAY_MS`    | No       | `0`                        | Delay stream response (debrid priority). 5000 = 5s   |

**Without `EASYPROXY_URL`**: the stream handler returns `{ streams: [] }` — no streams are served.

## Architecture

### scraper.js — Data & Decryption Layer

**Constants**
- `BASE_URL` = `https://streaming-community.watch`
- `VIDXGO_DOMAIN` = `https://v.vidxgo.co`
- `PROXY_URL` = `process.env.PROXY_URL || ''` — optional Cloudflare Worker reverse proxy

**In-memory cache** (`scraper.js:8-28`)
- `Map`-based cache with TTL = 30 minutes (`CACHE_TTL`).
- `getCached(key)` / `setCache(key, data)`.
- Eviction: when cache grows beyond 500 entries, stale entries are purged.
- Keys: `page_<url>`, `catalog_<type>_<skip>`, `search_<query>`, `stream_<imdbId>_<type>_<season>_<episode>`.
- ⚠️ Cache is in-memory only — lost on every restart.

**`fetchPage(url, retries=3)`** (`scraper.js:33-70`)
- HTTP GET with Firefox-like headers (User-Agent, Sec-Fetch-*, DNT, Accept-Language).
- **PROXY_URL support**: when `PROXY_URL` is set AND `url` starts with `BASE_URL`, the request is routed through the Cloudflare Worker (`${PROXY_URL}${encodeURIComponent(url)}`). This bypasses datacenter IP blocks on `streaming-community.watch`. VidXgo requests are always direct (not proxied).
- Retries up to 3 times with exponential backoff (`2000 * attempt` ms).
- `follow: 10` redirects, `timeout: 20000` ms.
- Returns empty string on final failure (does NOT throw).
- Results cached under `page_<url>` (cache key uses original URL, not proxied URL).

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
- Returns `{ m3u8, playbackHeaders }` where `playbackHeaders` are Chrome-like headers with `Referer` and `Origin` set to `VIDXGO_DOMAIN`.
- ⚠️ **Note**: In v3.1, this function is NOT called by the stream handler (EasyProxy does VidXgo resolution internally). It remains exported for potential future use and testing.

**`resolveStream(imdbId, type, season, episode)`** (`scraper.js:291-326`)
- Strips `tt` prefix → `vidxgoId`.
- Builds embed URL:
  - Movies / default: `https://v.vidxgo.co/{vidxgoId}`
  - Series: `https://v.vidxgo.co/{vidxgoId}/{season}/{episode}`
- Calls `fetchAndExtractVidXgo()`.
- Returns `{ m3u8, playbackHeaders, imdbId }`. Result cached under `stream_<...>`.
- ⚠️ **Note**: In v3.1, this function is NOT called by the stream handler. The stream handler builds the embed URL directly and passes it to EasyProxy.

**`getCatalog(type, skip=0)`** (`scraper.js:334-345`)
- Fetches `${BASE_URL}/film/` or `${BASE_URL}/series/` (via Cloudflare Worker if `PROXY_URL` is set).
- Parses with `extractItems()` and tags each item with `type`.
- ⚠️ **Known limitation**: the `skip` parameter is accepted but **not used for pagination** — only the first page of the listing is fetched.

**`search(query)`** (`scraper.js:350-361`)
- Hits `${BASE_URL}/index.php?do=search&subaction=search&story=<query>` (via Cloudflare Worker if `PROXY_URL` is set).
- Returns items with `type: null` (caller assigns the type).

**Exports** (`scraper.js:363-367`): `BASE_URL, fetchPage, extractItems, getCatalog, search, resolveStream, decodeVidXgoHtml, fetchAndExtractVidXgo, imdbToScMapLocal`.

### server.js — Stremio Add-on Layer (v3.1, 200 righe)

**Manifest** (`server.js:6-40`)
- `id`: `community.streaming.addon`
- `version`: `3.1.0`
- `resources`: `['catalog', 'stream']`
- `types`: `['movie', 'series']`
- `idPrefixes`: `['tt']` — only IMDb IDs (`tt123456`) are handled.
- Two catalogs:
  - `sc_film` → type `movie`, name "Film (StreamingCommunity)"
  - `sc_series` → type `series`, name "Serie TV (StreamingCommunity)"
  - Both support `search` and `skip` extras.
- `behaviorHints`: `configurable: false`, `configurationRequired: false`.

**Constants** (`server.js:42-56`)
- `STREAM_DELAY_MS`: delay (ms) applied to stream responses for debrid priority. Default `0`.
- `EASYPROXY_URL`: EasyProxy base URL (from env, trailing slash stripped). **Required** for streams.
- `EASYPROXY_PASSWORD`: EasyProxy API password (from env).
- `VIDXGO_DOMAIN`: `https://v.vidxgo.co` — used to build embed URLs.

**`itemToMeta(item, type)`** (`server.js:62-72`)
- Converts a scraper item to a Stremio meta object: `{ id, type, name, poster }`.
- `id` = `item.imdbId` if available, else `sc{scId}` (fallback — these non-`tt` IDs will NOT be playable because `idPrefixes` is `['tt']`).

**Catalog handler** (`server.js:78-99`)
- If `extra.search` is set → calls `scraper.search()` and maps results.
- Else dispatches on catalog `id`: `sc_film` → `getCatalog('movie', skip)`, `sc_series` → `getCatalog('series', skip)`.
- Returns `{ metas: [...] }`. On error returns `{ metas: [] }`.

**Stream handler** (`server.js:106-160`) — ⭐ key change in v3.1
- Rejects IDs not starting with `tt`.
- **Requires `EASYPROXY_URL`** — if not set, returns `{ streams: [] }` with error log.
- Applies `STREAM_DELAY_MS` delay (if > 0) for debrid priority.
- Parses Stremio series ID format `tt<imdb>:<season>:<episode>`.
- **Builds the VidXgo embed URL directly** (does NOT call `scraper.resolveStream`):
  - Movies: `https://v.vidxgo.co/{vidxgoId}`
  - Series: `https://v.vidxgo.co/{vidxgoId}/{season}/{episode}`
- **Wraps the embed URL through EasyProxy**:
  ```
  {EASYPROXY_URL}/proxy/hls/manifest.m3u8?api_password={pwd}&d={embedUrl}
  ```
- Returns a single stream:
  - `title`: `StreamingCommunity ITA 🇮🇹` (+ ` S{season}E{episode}` for series)
  - `url`: the EasyProxy URL
  - `behaviorHints`: `notWebReady: true`, `bingeGroup: sc-{imdbId}`
- **No `proxyHeaders`** — EasyProxy handles CDN auth (Referer/Origin) and token refresh internally.
- On error returns `{ streams: [] }`.

**Server startup** (`server.js:165-200`)
- `PORT` from env, default `7000`. Binds to `0.0.0.0`.
- Uses `serveHTTP(addonInterface, { port, host })` from the SDK.
- Prints banner with manifest URL, EasyProxy URL status, and stream delay.

### worker.js — Cloudflare Worker (separate deployment)

Reverse proxy for `streaming-community.watch` to bypass datacenter IP blocks.

- **Endpoint**: `GET /?url=<encoded_target_url>`
- **Security**: only allows targets on `streaming-community.watch` hostname (403 otherwise).
- **Deploy**: Cloudflare Workers & Pages → Create Worker → paste `worker.js` → Deploy.
- **URL format**: `https://<worker-name>.<subdomain>.workers.dev/?url=`
- **Free tier**: 100,000 requests/day (the add-on uses ~4 req/day for catalogs).
- **Set on Render**: `PROXY_URL=https://<worker-name>.<subdomain>.workers.dev/?url=`

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
              → if PROXY_URL set: route through Cloudflare Worker
              → Worker fetches from streaming-community.watch (edge IP, not blocked)
              → returns HTML
        → extractItems(html)  [cheerio parse → posterMap + title links]
        → itemToMeta() per item  [imdbId as Stremio id]
        → { metas: [...] } → Stremio renders posters
```

### Stream flow (v3.1 — EasyProxy delegation)
```
Stremio → GET /stream/movie/tt123456.json
        (or /stream/series/tt123456:1:3.json for S1E3)
        → server.js StreamHandler
        → parse id → imdbId=tt123456, season=1, episode=3
        → build embed URL: https://v.vidxgo.co/123456/1/3
        → wrap through EasyProxy:
              {EASYPROXY_URL}/proxy/hls/manifest.m3u8?api_password={pwd}&d=https://v.vidxgo.co/123456/1/3
        → Stremio stream: { url: easyproxy_url, behaviorHints: { notWebReady: true, bingeGroup: 'sc-tt123456' } }

Stremio player → fetches easyproxy_url
        → EasyProxy resolves VidXgo embed (XOR decryption, same as MammaMia)
        → EasyProxy fetches m3u8 from VidXgo CDN (with Referer/Origin)
        → EasyProxy rewrites segment URLs to point back to itself
        → EasyProxy background-refreshes the CDN token every ~60s (before ~2min expiry)
        → EasyProxy serves each .ts segment with fresh token + correct headers
        → Player plays HLS seamlessly — no freeze, no black screen
```

## Key Technical Details

- **VidXgo token expiry**: VidXgo m3u8 URLs carry `?t=...&e=...&b=...` where `e=` is a Unix timestamp (ms) expiring after ~2 minutes. Direct playback or inline proxying causes freeze/black screen when the token expires. EasyProxy solves this with async background refresh.
- **EasyProxy delegation**: the add-on does NOT resolve VidXgo for streams. It builds the embed URL and passes it to EasyProxy, which handles: VidXgo XOR decryption, m3u8 fetch, background token refresh, per-segment URL rewrite, Referer/Origin injection.
- **Cloudflare Worker**: `streaming-community.watch` blocks Render datacenter IPs. The Worker proxies catalog/search requests through Cloudflare's edge network (not blocked). VidXgo CDN is NOT blocked, so no proxy needed for streams.
- **ID format**:
  - Movies: `tt<imdbId>` (e.g. `tt1234567`)
  - Series episode: `tt<imdbId>:<season>:<episode>` (e.g. `tt1234567:1:3`)
- **IMDb ID source**: extracted from poster image URLs of the form `posters/ttXXXX.webp` on the StreamingCommunity listing pages. Items without a poster matching this pattern get a fallback `sc{scId}` id and are effectively unplayable.
- **Cache TTL**: 30 min for everything (pages, catalogs, searches, stream resolutions).
- **`behaviorHints` on streams**: `notWebReady: true` (URL is on EasyProxy, not directly playable in browser), `bingeGroup: sc-{imdbId}` (groups episodes for binge/next-episode). No `proxyHeaders` — EasyProxy handles CDN auth.

## Running the Add-on

### Local development
```bash
# Install dependencies (first time only)
npm install

# Start on default port 7000
npm start
# or
./start.sh

# Start on a custom port
PORT=8080 node server.js
```

### With EasyProxy (required for streams)
```bash
EASYPROXY_URL=https://your-easyproxy-instance.example.com \
EASYPROXY_PASSWORD=your-password \
PROXY_URL=https://your-worker.workers.dev/?url= \
npm start
```

Once running, the manifest is served at `http://127.0.0.1:{PORT}/manifest.json`.

**Install in Stremio**: open Stremio → Add-ons → paste the manifest URL → click Install.

### Production deployment (Render + HuggingFace Spaces)

| Component  | Platform          | URL pattern                              | Env vars                          |
|------------|-------------------|------------------------------------------|-----------------------------------|
| Add-on     | Render (Docker)   | `https://stremio-sc.onrender.com`        | `PORT`, `PROXY_URL`, `EASYPROXY_URL`, `EASYPROXY_PASSWORD`, `STREAM_DELAY_MS` |
| EasyProxy  | HF Spaces (Docker)| `https://leoo-q4-easyproxy2.hf.space`    | `API_PASSWORD`, `PORT`            |
| CF Worker  | Cloudflare        | `https://scproxy.xxx.workers.dev`        | —                                 |

**Deploy add-on on Render**:
1. New → Web Service → connect GitHub repo `redd-create/stremio-sc`
2. Runtime: Docker, Instance: Free
3. Set env vars (see table above)
4. Manifest URL: `https://stremio-sc.onrender.com/manifest.json`

**Deploy EasyProxy on HuggingFace Spaces**:
1. New Space → SDK: Docker
2. Dockerfile: `FROM ghcr.io/realbestia1/easyproxy:latest` + `ENV PORT=7860`
3. Set `API_PASSWORD` as secret
4. URL: `https://<space-name>.hf.space`

**Deploy Cloudflare Worker**:
1. Cloudflare Dashboard → Workers & Pages → Create Worker
2. Paste `worker.js` → Deploy
3. Set `PROXY_URL` on Render to `https://<worker>.workers.dev/?url=`

## Code Conventions

- **Module system**: CommonJS (`require` / `module.exports`). `package.json` has `"type": "commonjs"`.
- **Comments**: in English; doc-comment style (`/** ... */`) on exported functions.
- **Logs**: `console.log` / `console.error` in English with prefixes like `[VidXgo]`, `Catalog:`, `Stream:`, `[Proxy]`.
- **No Puppeteer / headless browsers** — this is an explicit design goal. Decryption is done with `Buffer` + XOR (in EasyProxy, not in the add-on itself for streams).
- **Inspiration**: StreamViX / MammaMia projects (VidXgo XOR approach), EasyProxy (background token refresh).
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
| catalog  | `id=sc_film`, no search                              | `getCatalog('movie', skip)` → `/film/` via CF Worker        |
| catalog  | `id=sc_series`, no search                            | `getCatalog('series', skip)` → `/series/` via CF Worker     |
| catalog  | any `id`, `extra.search` set                         | `search(query)` → site search via CF Worker                 |
| stream   | `id=ttXXXX` (movie)                                  | Build embed URL → wrap in EasyProxy → return proxy URL       |
| stream   | `id=ttXXXX:S:E` (series)                             | Build embed URL with S/E → wrap in EasyProxy → return proxy  |
| stream   | `id` not starting with `tt`                          | Returns `{ streams: [] }`                                    |
| stream   | `EASYPROXY_URL` not set                              | Returns `{ streams: [] }` with error log                     |

## Known Limitations & Notes

- **EasyProxy required**: without `EASYPROXY_URL`, no streams are served. EasyProxy handles VidXgo resolution, token refresh, and HLS proxying.
- **Pagination not implemented**: `skip` is read by the server and passed to `getCatalog`, but `getCatalog` ignores it and always fetches page 1.
- **In-memory cache**: all caches (pages, catalogs, streams) are lost on restart and not shared across processes.
- **Fragile scraping**: selectors depend on the current HTML structure of streaming-community.watch. Changes to the site (class names, URL patterns, poster path format) will silently break item extraction.
- **IMDb ID dependency**: only items whose poster URL contains `posters/ttXXX.webp` get a real IMDb ID and become playable. Items missing this get `sc{scId}` ids that the stream handler refuses (idPrefixes = `['tt']`).
- **VidXgo decryption in scraper.js is unused for streams**: `resolveStream` and `fetchAndExtractVidXgo` remain in scraper.js but are NOT called by the stream handler in v3.1. EasyProxy performs VidXgo resolution internally. They remain for potential future use and testing.
- **HF Spaces sleep**: HuggingFace Spaces free tier sleeps after ~48h of inactivity. First request after sleep has cold start (~30-60s). Use a ping service (UptimeRobot) on the EasyProxy URL to prevent sleep.
- **Render free tier sleep**: Render free sleeps after ~15 min of inactivity. The add-on (manifest/catalog) wakes quickly; EasyProxy (on HF) is the critical path for playback.
- **Legal/ToS**: this add-on scrapes a third-party site; it is unofficial and not affiliated with StreamingCommunity. Use responsibly and in accordance with local law and the target site's terms of service.
- **No HTTPS on add-on**: the add-on itself serves plain HTTP when run locally. Render provides HTTPS automatically. For other deployments, use a reverse proxy.
- **`imdbToScMap` / `imdbToScMapLocal`**: two parallel maps are maintained (one in `server.js`, one in `scraper.js`) but they are not actually consulted by the stream handler. They exist for potential future lookups.

## Version History

| Version | Date       | Key changes                                                          |
|---------|------------|----------------------------------------------------------------------|
| 3.0.0   | 2026-06-17 | Initial: direct VidXgo resolution, proxyHeaders, in-add-on decrypt   |
| 3.1.0   | 2026-06-18 | EasyProxy delegation, Cloudflare Worker proxy, removed custom HLS proxy |
