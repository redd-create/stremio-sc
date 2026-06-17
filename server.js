const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const http = require('http');
const fetch = require('node-fetch');
const scraper = require('./scraper');

const manifest = {
    id: 'community.streaming.addon',
    version: '3.0.0',
    name: 'Streaming Community',
    description: 'Add-on non ufficiale per StreamingCommunity - Film e Serie TV in streaming in italiano',
    logo: 'https://streaming-community.watch/templates/streaming-community/images/icons/apple-touch-icon.png',
    background: 'https://streaming-community.watch/uploads/backdrops/tt8772296.webp',
    resources: ['catalog', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [
        {
            type: 'movie',
            id: 'sc_film',
            name: 'Film (StreamingCommunity)',
            extra: [
                { name: 'search', isRequired: false },
                { name: 'skip', isRequired: false },
            ],
        },
        {
            type: 'series',
            id: 'sc_series',
            name: 'Serie TV (StreamingCommunity)',
            extra: [
                { name: 'search', isRequired: false },
                { name: 'skip', isRequired: false },
            ],
        },
    ],
    behaviorHints: {
        configurable: false,
        configurationRequired: false,
    },
};

const builder = new addonBuilder(manifest);
const imdbToScMap = new Map();

// Delay (ms) applied to every stream response so debrid add-ons (Torrentio etc.)
// can answer first and be picked by Stremio/Nuvio auto-play. 0 = disabled.
const STREAM_DELAY_MS = parseInt(process.env.STREAM_DELAY_MS) || 0;

// Public base URL of this add-on (used to build absolute proxy URLs).
// On Render set: SELF_URL=https://stremio-sc.onrender.com
const PORT = parseInt(process.env.PORT) || 7000;
const SELF_URL = (process.env.SELF_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');

// Headers required by the VidXgo CDN for every HLS request (m3u8 + segments).
// Must match scraper.js playbackHeaders. Sent by the proxy to the upstream CDN.
const VIDXGO_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://v.vidxgo.co/',
    'Origin': 'https://v.vidxgo.co',
    'Sec-GPC': '1',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'DNT': '1',
};

function encodeB64(str) { return Buffer.from(str).toString('base64url'); }
function decodeB64(b64) { return Buffer.from(b64, 'base64url').toString('utf8'); }

/**
 * HLS Proxy — bypasses the need for client-side proxyHeaders.
 *
 * The player (Stremio/Nuvio/AIOStreams) only sees URLs on our own server.
 * Our server fetches the real m3u8 and segments from the VidXgo CDN with
 * the correct Referer/Origin headers, so every client works without freeze.
 *
 *   /proxy/hls/<base64url>  → fetches m3u8, rewrites internal URLs, returns text
 *   /proxy/seg/<base64url>  → fetches a segment/key, returns raw bytes
 */

// Rewrite all URLs inside an m3u8 playlist to point through /proxy/seg or /proxy/hls
function rewriteM3u8(text, baseUrl) {
    const base = new URL(baseUrl);
    return text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // Rewrite URI="..." attributes inside #EXT-X-KEY, #EXT-X-MAP, etc.
        if (trimmed.startsWith('#') && trimmed.includes('URI="')) {
            return line.replace(/URI="([^"]+)"/g, (match, rawUri) => {
                try {
                    const abs = new URL(rawUri, base).toString();
                    const route = abs.includes('.m3u8') ? 'hls' : 'seg';
                    return `URI="${SELF_URL}/proxy/${route}/${encodeB64(abs)}"`;
                } catch { return match; }
            });
        }

        // Skip comment lines without URI
        if (trimmed.startsWith('#')) return line;

        // Non-comment line: treat as a segment or sub-playlist URL
        try {
            const abs = new URL(trimmed, base).toString();
            const route = abs.includes('.m3u8') ? 'hls' : 'seg';
            return `${SELF_URL}/proxy/${route}/${encodeB64(abs)}`;
        } catch { return line; }
    }).join('\n');
}

async function handleHls(req, res, parsedUrl) {
    const b64 = parsedUrl.pathname.replace('/proxy/hls/', '');
    let targetUrl;
    try { targetUrl = decodeB64(b64); } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Invalid base64');
    }

    try {
        const response = await fetch(targetUrl, { headers: VIDXGO_HEADERS, timeout: 15000, follow: 5 });
        if (!response.ok) {
            console.error(`[Proxy HLS] upstream ${response.status} for ${targetUrl.slice(0, 80)}`);
            res.writeHead(response.status, { 'Content-Type': 'text/plain' });
            return res.end(`Upstream error: ${response.status}`);
        }

        const text = await response.text();
        const rewritten = rewriteM3u8(text, targetUrl);

        res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
        });
        res.end(rewritten);
    } catch (e) {
        console.error('[Proxy HLS] error:', e.message);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy error: ' + e.message);
    }
}

async function handleSeg(req, res, parsedUrl) {
    const b64 = parsedUrl.pathname.replace('/proxy/seg/', '');
    let targetUrl;
    try { targetUrl = decodeB64(b64); } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Invalid base64');
    }

    try {
        const response = await fetch(targetUrl, { headers: VIDXGO_HEADERS, timeout: 30000, follow: 5 });
        if (!response.ok) {
            console.error(`[Proxy Seg] upstream ${response.status} for ${targetUrl.slice(0, 80)}`);
            res.writeHead(response.status, { 'Content-Type': 'text/plain' });
            return res.end(`Upstream error: ${response.status}`);
        }

        const contentType = response.headers.get('Content-Type') || 'video/mp2t';
        const buffer = await response.buffer();

        res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600',
        });
        res.end(buffer);
    } catch (e) {
        console.error('[Proxy Seg] error:', e.message);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy error: ' + e.message);
    }
}

function itemToMeta(item, type) {
    const meta = {
        id: item.imdbId || `sc${item.scId}`,
        type: type || item.type || 'movie',
        name: item.name,
        poster: item.poster || undefined,
    };
    if (item.imdbId) {
        imdbToScMap.set(item.imdbId, item);
        scraper.imdbToScMapLocal.set(item.imdbId, item);
    }
    return meta;
}

/**
 * CATALOG handler
 */
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    console.log(`Catalog: type=${type}, id=${id}, extra=${JSON.stringify(extra)}`);
    try {
        if (extra.search) {
            const results = await scraper.search(extra.search);
            return { metas: results.map(item => itemToMeta(item, type)) };
        }
        if (id === 'sc_film') {
            const items = await scraper.getCatalog('movie', parseInt(extra.skip) || 0);
            return { metas: items.map(item => itemToMeta(item, 'movie')) };
        }
        if (id === 'sc_series') {
            const items = await scraper.getCatalog('series', parseInt(extra.skip) || 0);
            return { metas: items.map(item => itemToMeta(item, 'series')) };
        }
        return { metas: [] };
    } catch (error) {
        console.error('Catalog error:', error);
        return { metas: [] };
    }
});

/**
 * STREAM handler
 * 
 * Uses the VidXgo JavaScript decryption approach (inspired by StreamViX/MammaMia):
 * 1. Fetch the embed page with Firefox UA + fake referer
 * 2. Find the encrypted <script>, extract XOR key + base64 payload
 * 3. Decrypt to get the m3u8 URL
 * 4. Return a proxied URL on our own server (/proxy/hls/<b64>) so every
 *    client (Stremio, Nuvio, AIOStreams) can play without needing proxyHeaders
 * 
 * NO Puppeteer needed! Pure HTTP + crypto.
 */
builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`Stream: type=${type}, id=${id}`);

    try {
        if (!id.startsWith('tt')) return { streams: [] };

        // Hold the response so debrid add-ons (Torrentio + RealDebrid etc.)
        // can return their higher-quality torrents first and win auto-play.
        if (STREAM_DELAY_MS > 0) {
            console.log(`Stream: holding ${STREAM_DELAY_MS}ms (debrid priority) for ${id}`);
            await new Promise(r => setTimeout(r, STREAM_DELAY_MS));
        }

        // Parse season/episode from Stremio ID (tt123:1:3)
        let imdbId = id;
        let season = null;
        let episode = null;

        if (id.includes(':')) {
            const parts = id.split(':');
            imdbId = parts[0];
            season = parseInt(parts[1]) || null;
            episode = parseInt(parts[2]) || null;
        }

        const result = await scraper.resolveStream(imdbId, type, season, episode);

        if (result.m3u8) {
            const titleSuffix = (type === 'series' && season && episode) 
                ? ` S${season}E${episode}` : '';
            
            // Wrap the m3u8 through our HLS proxy so the player never talks
            // directly to the VidXgo CDN (which requires Referer/Origin headers
            // that some clients like Nuvio don't send on segment requests).
            const proxyUrl = `${SELF_URL}/proxy/hls/${encodeB64(result.m3u8)}`;
            const stream = {
                title: `StreamingCommunity ITA 🇮🇹${titleSuffix}`,
                url: proxyUrl,
                behaviorHints: {
                    bingeGroup: `sc-${imdbId}`,
                },
            };
            console.log(`Stream: returning proxy URL for ${imdbId}`);
            return { streams: [stream] };
        }

        // Fallback: return the vidxgo embed URL
        console.log('No m3u8 found, returning fallback');
        const vidxgoId = imdbId.replace('tt', '');
        return {
            streams: [{
                title: 'StreamingCommunity (apri nel browser)',
                url: `https://v.vidxgo.co/${vidxgoId}`,
                behaviorHints: {
                    notWebReady: true,
                    bingeGroup: `sc-${imdbId}`,
                },
            }],
        };
    } catch (error) {
        console.error('Stream error:', error);
        return { streams: [] };
    }
});

async function start() {
    try {
        const addonInterface = builder.getInterface();
        const router = getRouter(addonInterface);

        const server = http.createServer((req, res) => {
            const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

            // HLS proxy routes — intercepted before the SDK router
            if (parsedUrl.pathname.startsWith('/proxy/hls/')) {
                return handleHls(req, res, parsedUrl);
            }
            if (parsedUrl.pathname.startsWith('/proxy/seg/')) {
                return handleSeg(req, res, parsedUrl);
            }

            // Landing page
            if (parsedUrl.pathname === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end(`<html><body><h2>StreamingCommunity Stremio Add-on</h2><p>Manifest: <a href="/manifest.json">/manifest.json</a></p></body></html>`);
            }

            // Everything else (manifest, catalog, stream) → Stremio SDK router
            router(req, res, () => {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not found');
            });
        });

        server.listen(PORT, '0.0.0.0', () => {
            const localUrl = `http://127.0.0.1:${PORT}`;
            console.log('');
            console.log('='.repeat(60));
            console.log('  StreamingCommunity Stremio Add-on v3.0');
            console.log('  HLS Proxy + VidXgo XOR decryption - NO Puppeteer!');
            console.log('='.repeat(60));
            console.log(`  Manifest:  ${localUrl}/manifest.json`);
            console.log(`  Self URL:   ${SELF_URL}`);
            console.log(`  HLS proxy:  ${SELF_URL}/proxy/hls/<b64>`);
            console.log(`  Seg proxy:  ${SELF_URL}/proxy/seg/<b64>`);
            console.log(`  Stream delay: ${STREAM_DELAY_MS}ms ${STREAM_DELAY_MS > 0 ? '(debrid priority)' : '(disabled)'}`);
            console.log('='.repeat(60));
            console.log('');
            console.log('  Installa in Stremio:');
            console.log(`  1. Apri Stremio → Add-ons`);
            console.log(`  2. Incolla: ${SELF_URL}/manifest.json`);
            console.log('');
        });
    } catch (error) {
        console.error('Failed to start:', error);
        process.exit(1);
    }
}

start();
