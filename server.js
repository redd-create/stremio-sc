const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
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
 * 2. Find the 6th <script> tag, extract XOR key + base64 payload
 * 3. Decrypt to get the m3u8 URL
 * 4. Return the m3u8 with proxyHeaders for playback
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
            
            const stream = {
                title: `StreamingCommunity ITA 🇮🇹${titleSuffix}`,
                url: result.m3u8,
                behaviorHints: {
                    notWebReady: true,
                    bingeGroup: `sc-${imdbId}`,
                    proxyHeaders: result.playbackHeaders ? { request: result.playbackHeaders } : undefined,
                },
            };
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

const PORT = parseInt(process.env.PORT) || 7000;

async function start() {
    try {
        const addonInterface = builder.getInterface();
        await serveHTTP(addonInterface, { port: PORT, host: '0.0.0.0' });

        const localUrl = `http://127.0.0.1:${PORT}`;
        console.log('');
        console.log('='.repeat(60));
        console.log('  StreamingCommunity Stremio Add-on v3.0');
        console.log('  Decrittazione VidXgo - NO Puppeteer!');
        console.log('='.repeat(60));
        console.log(`  Manifest: ${localUrl}/manifest.json`);
        console.log(`  Stream delay: ${STREAM_DELAY_MS}ms ${STREAM_DELAY_MS > 0 ? '(debrid priority)' : '(disabled)'}`);
        console.log('='.repeat(60));
        console.log('');
        console.log('  Installa in Stremio:');
        console.log(`  1. Apri Stremio → Add-ons`);
        console.log(`  2. Incolla: ${localUrl}/manifest.json`);
        console.log(`  3. Per altri dispositivi: http://TUO_IP:${PORT}/manifest.json`);
        console.log('');
    } catch (error) {
        console.error('Failed to start:', error);
        process.exit(1);
    }
}

start();
