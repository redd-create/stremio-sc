const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const scraper = require('./scraper');

const manifest = {
    id: 'community.streaming.addon',
    version: '3.1.0',
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

// EasyProxy handles VidXgo resolution + HLS proxying + background token refresh.
// Without EasyProxy configured, streams are not returned (VidXgo tokens expire
// after ~2 min and direct/inline proxying causes black screen / freeze).
// Deploy: docker image ghcr.io/realbestia1/easyproxy:latest
const EASYPROXY_URL = (process.env.EASYPROXY_URL || '').replace(/\/+$/, '');
const EASYPROXY_PASSWORD = process.env.EASYPROXY_PASSWORD || '';

const VIDXGO_DOMAIN = 'https://v.vidxgo.co';

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
 * Delegates HLS proxying to EasyProxy, which handles:
 *   - VidXgo XOR decryption (same approach as MammaMia/StreamViX)
 *   - Background token refresh (VidXgo tokens expire after ~2 min)
 *   - Per-segment URL rewrite with fresh tokens at fetch time
 *   - Referer/Origin header injection toward the CDN
 *
 * The player only sees URLs on the EasyProxy server, so every client
 * (Stremio, Nuvio, AIOStreams, web) works without proxyHeaders or freeze.
 */
builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`Stream: type=${type}, id=${id}`);

    try {
        if (!id.startsWith('tt')) return { streams: [] };

        if (!EASYPROXY_URL) {
            console.error('Stream: EASYPROXY_URL not set — cannot serve VidXgo streams without EasyProxy');
            return { streams: [] };
        }

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

        // Build the VidXgo embed URL — EasyProxy resolves it internally
        const vidxgoId = imdbId.replace('tt', '');
        let embedUrl;
        if (type === 'series' && season && episode) {
            embedUrl = `${VIDXGO_DOMAIN}/${vidxgoId}/${season}/${episode}`;
        } else {
            embedUrl = `${VIDXGO_DOMAIN}/${vidxgoId}`;
        }

        // Wrap through EasyProxy: it does extraction + background token refresh
        const params = new URLSearchParams();
        if (EASYPROXY_PASSWORD) params.set('api_password', EASYPROXY_PASSWORD);
        params.set('d', embedUrl);
        const proxyUrl = `${EASYPROXY_URL}/proxy/hls/manifest.m3u8?${params.toString()}`;

        const titleSuffix = (type === 'series' && season && episode)
            ? ` S${season}E${episode}` : '';

        const stream = {
            title: `StreamingCommunity ITA 🇮🇹${titleSuffix}`,
            url: proxyUrl,
            behaviorHints: {
                notWebReady: true,
                bingeGroup: `sc-${imdbId}`,
            },
        };

        console.log(`Stream: returning EasyProxy URL for ${imdbId}`);
        return { streams: [stream] };
    } catch (error) {
        console.error('Stream error:', error);
        return { streams: [] };
    }
});

const PORT = parseInt(process.env.PORT) || 7000;

async function start() {
    try {
        const addonInterface = builder.getInterface();
        await serveHTTP(addonInterface, { port: PORT, host: '0.0.0.0' });

        const localUrl = `http://127.0.0.1:${PORT}`;
        console.log('');
        console.log('='.repeat(60));
        console.log('  StreamingCommunity Stremio Add-on v3.1');
        console.log('  VidXgo resolution delegated to EasyProxy');
        console.log('='.repeat(60));
        console.log(`  Manifest:      ${localUrl}/manifest.json`);
        console.log(`  EasyProxy URL: ${EASYPROXY_URL || '(NOT SET — streams disabled)'}`);
        console.log(`  Stream delay:  ${STREAM_DELAY_MS}ms ${STREAM_DELAY_MS > 0 ? '(debrid priority)' : '(disabled)'}`);
        console.log('='.repeat(60));
        console.log('');
        console.log('  Installa in Stremio:');
        console.log(`  1. Apri Stremio → Add-ons`);
        console.log(`  2. Incolla: ${localUrl}/manifest.json`);
        console.log('');
    } catch (error) {
        console.error('Failed to start:', error);
        process.exit(1);
    }
}

start();
