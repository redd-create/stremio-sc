const cheerio = require('cheerio');
const fetch = require('node-fetch');

const BASE_URL = 'https://streaming-community.watch';
const VIDXGO_DOMAIN = 'https://v.vidxgo.co';

// Simple in-memory cache with TTL
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getCached(key) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
        return entry.data;
    }
    cache.delete(key);
    return null;
}

function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
    if (cache.size > 500) {
        const now = Date.now();
        for (const [k, v] of cache) {
            if (now - v.timestamp > CACHE_TTL) cache.delete(k);
        }
    }
}

/**
 * Fetch a page using node-fetch with browser-like headers
 */
async function fetchPage(url, retries = 3) {
    const cached = getCached(`page_${url}`);
    if (cached) return cached;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Sec-GPC': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'DNT': '1',
                },
                follow: 10,
                timeout: 20000,
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status} for ${url}`);
            }

            const html = await response.text();
            setCache(`page_${url}`, html);
            return html;
        } catch (error) {
            console.error(`fetchPage attempt ${attempt}/${retries} failed for ${url}: ${error.message}`);
            if (attempt === retries) return '';
            await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }
    return '';
}

/**
 * Extract items from a listing page
 */
function extractItems(html) {
    if (!html) return [];
    const $ = cheerio.load(html);
    const items = [];
    const seenIds = new Set();

    const posterMap = {};
    $('img[data-src*="posters/tt"], img[src*="posters/tt"], .tile-image[data-src*="posters/tt"]').each((_, el) => {
        const dataSrc = $(el).attr('data-src') || '';
        const src = $(el).attr('src') || '';
        const style = $(el).attr('style') || '';
        const combined = dataSrc + src + style;
        const imdbMatch = combined.match(/posters\/(tt\d+)\.webp/);
        if (imdbMatch) {
            const closestLink = $(el).closest('a[href*="/titles/"], div[data-id]');
            if (closestLink.length) {
                const href = closestLink.attr('href') || '';
                const idMatch = href.match(/\/titles\/(\d+)-/);
                const dataId = closestLink.attr('data-id');
                const scId = idMatch ? idMatch[1] : dataId;
                if (scId) {
                    posterMap[scId] = { imdbId: imdbMatch[1], poster: `${BASE_URL}/uploads/posters/${imdbMatch[1]}.webp` };
                }
            }
        }
    });

    $('[data-id]').each((_, el) => {
        const dataId = $(el).attr('data-id');
        if (!dataId) return;
        const nearbyImg = $(el).find('img[data-src*="posters/"], img[src*="posters/"], .tile-image[data-src*="posters/"]').first();
        if (nearbyImg.length) {
            const dataSrc = nearbyImg.attr('data-src') || '';
            const src = nearbyImg.attr('src') || '';
            const combined = dataSrc + src;
            const imdbMatch = combined.match(/posters\/(tt\d+)\.webp/);
            if (imdbMatch && !posterMap[dataId]) {
                posterMap[dataId] = { imdbId: imdbMatch[1], poster: `${BASE_URL}/uploads/posters/${imdbMatch[1]}.webp` };
            }
        }
    });

    $('a[href*="/titles/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const match = href.match(/\/titles\/(\d+)-([^"'\?]+)\.html/);
        if (!match) return;
        const scId = match[1];
        const slug = match[2];
        if (seenIds.has(scId)) return;
        seenIds.add(scId);

        let name = $(el).attr('title') || '';
        if (!name) {
            const parent = $(el).closest('.slider-tile, .slider-tile-inner');
            const nameEl = parent.find('.name, .title-2 span, h2, h3').first();
            name = nameEl.text().trim();
        }
        if (!name) {
            name = slug.replace(/^guarda-/, '').replace(/-streaming.*$/, '').replace(/-community.*$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        }

        let imdbId = posterMap[scId]?.imdbId || null;
        let poster = posterMap[scId]?.poster || null;
        items.push({ scId, slug, name, imdbId, poster, url: `${BASE_URL}/titles/${scId}-${slug}.html` });
    });

    return items;
}

/**
 * Decode VidXgo HTML to extract the m3u8 URL
 * Based on StreamViX/MammaMia approach:
 * 1. Find the 6th <script> tag
 * 2. Extract the XOR key and base64 payload
 * 3. Decrypt by XOR-ing with the key
 * 4. Find the m3u8 URL in the decrypted JavaScript
 */
function decodeVidXgoHtml(html) {
    try {
        // Find all <script> tags using regex
        const scriptRe = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
        const inlineScripts = [];
        let sm;
        while ((sm = scriptRe.exec(html)) !== null) {
            const attrs = sm[1] || '';
            const isExternal = /\bsrc\s*=/i.test(attrs);
            if (!isExternal) {
                inlineScripts.push(sm[2] || '');
            }
        }

        // Find the script that contains the XOR decryption pattern
        // Pattern: var K='key',d=atob('base64_payload')
        for (const scriptBody of inlineScripts) {
            const m = scriptBody.match(/var\s+\w+\s*=\s*'([^']*)'\s*,\s*d\s*=\s*atob\(\s*'([^']*)'/);
            if (!m) continue;

            const key = m[1];
            const b64 = m[2];
            if (!key || !b64) continue;

            console.log('[VidXgo] Found encrypted script, key length:', key.length, 'b64 length:', b64.length);

            // Base64 decode
            const decoded = Buffer.from(b64, 'base64');
            if (!decoded.length) continue;

            // XOR decrypt with key (cyclic)
            const out = Buffer.alloc(decoded.length);
            for (let i = 0; i < decoded.length; i++) {
                out[i] = decoded[i] ^ key.charCodeAt(i % key.length);
            }

            const decrypted = out.toString('utf8');

            // Find the m3u8 URL in the decrypted JavaScript
            // Try multiple patterns
            let urlMatch;

            // Pattern 1: currentSrc assignment
            urlMatch = decrypted.match(/currentSrc[^"]*"(https:[^";]+\.m3u8[^";]*)"/);
            if (urlMatch) {
                return urlMatch[1].replace(/\\/g, '');
            }

            // Pattern 2: any m3u8 URL
            urlMatch = decrypted.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
            if (urlMatch) {
                return urlMatch[1].replace(/\\/g, '');
            }

            // Pattern 3: m3u8 URL without quotes (assigned to variable)
            urlMatch = decrypted.match(/(https?:\/\/[^\s"';,]+\.m3u8[^\s"';,]*)/);
            if (urlMatch) {
                return urlMatch[1].replace(/\\/g, '');
            }

            // Pattern 4: look for hlsSrc or src assignment
            urlMatch = decrypted.match(/(?:hlsSrc|src|url|file)\s*[=:]\s*["']?(https?:\/\/[^"'\s;)]+\.m3u8[^"'\s;)]*)/);
            if (urlMatch) {
                return urlMatch[1].replace(/\\/g, '');
            }

            // Debug: show what we decrypted
            console.log('[VidXgo] Decrypted preview:', decrypted.substring(0, 500));
        }

        console.log('[VidXgo] No matching encrypted script found');
        return null;
    } catch (e) {
        console.error('[VidXgo] decode error:', e.message);
        return null;
    }
}

/**
 * Fetch the VidXgo embed page and extract the m3u8 URL
 * Uses a Firefox User-Agent and altadefinizione referer (like StreamViX/MammaMia)
 */
async function fetchAndExtractVidXgo(embedUrl) {
    try {
        const response = await fetch(embedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-GPC': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'iframe',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'DNT': '1',
                'Referer': 'https://altadefinizione.you/',
                'Priority': 'u=0, i',
            },
            follow: 5,
            timeout: 15000,
        });

        if (!response.ok) {
            console.log('[VidXgo] HTTP error:', response.status, 'url=', embedUrl);
            return null;
        }

        const html = await response.text();
        const m3u8 = decodeVidXgoHtml(html);

        if (!m3u8) return null;

        return {
            m3u8,
            playbackHeaders: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': VIDXGO_DOMAIN + '/',
                'Origin': VIDXGO_DOMAIN,
                'Sec-GPC': '1',
                'Connection': 'keep-alive',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'cross-site',
                'DNT': '1',
            },
        };
    } catch (e) {
        console.error('[VidXgo] fetch error:', e.message);
        return null;
    }
}

/**
 * Resolve the m3u8 stream URL for a title
 * No Puppeteer needed! Pure JavaScript decryption.
 */
async function resolveStream(imdbId, type, season, episode) {
    const cacheKey = `stream_${imdbId}_${type}_${season || 0}_${episode || 0}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const vidxgoId = imdbId.replace('tt', '');

    // Build the embed URL
    // Movies: v.vidxgo.co/{id}
    // Series: v.vidxgo.co/{id}/{season}/{episode}
    let embedUrl;
    if (type === 'series' && season && episode) {
        embedUrl = `${VIDXGO_DOMAIN}/${vidxgoId}/${season}/${episode}`;
    } else {
        embedUrl = `${VIDXGO_DOMAIN}/${vidxgoId}`;
    }

    console.log(`[VidXgo] Resolving: ${embedUrl}`);

    const result = await fetchAndExtractVidXgo(embedUrl);

    const streamResult = {
        m3u8: result?.m3u8 || null,
        playbackHeaders: result?.playbackHeaders || null,
        imdbId,
    };

    if (streamResult.m3u8) {
        console.log('[VidXgo] SUCCESS - m3u8 found!');
    } else {
        console.log('[VidXgo] FAILED - no m3u8 found');
    }

    setCache(cacheKey, streamResult);
    return streamResult;
}

// Local map for stream resolution (populated by catalog/search)
const imdbToScMapLocal = new Map();

/**
 * Get catalog items
 */
async function getCatalog(type, skip = 0) {
    const cacheKey = `catalog_${type}_${skip}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const url = type === 'series' ? `${BASE_URL}/series/` : `${BASE_URL}/film/`;
    const html = await fetchPage(url);
    const items = extractItems(html);
    const result = items.map(item => ({ ...item, type: type === 'series' ? 'series' : 'movie' }));
    setCache(cacheKey, result);
    return result;
}

/**
 * Search titles
 */
async function search(query) {
    const cacheKey = `search_${query}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const searchUrl = `${BASE_URL}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
    const html = await fetchPage(searchUrl);
    const items = extractItems(html);
    const result = items.map(item => ({ ...item, type: null }));
    setCache(cacheKey, result);
    return result;
}

module.exports = {
    BASE_URL, fetchPage, extractItems, getCatalog, search, resolveStream,
    decodeVidXgoHtml, fetchAndExtractVidXgo,
    imdbToScMapLocal,
};
