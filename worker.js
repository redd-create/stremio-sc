/**
 * Cloudflare Worker — reverse proxy per streaming-community.watch
 *
 * Serve a bypassare il blocco IP che streaming-community.watch applica
 * agli IP datacenter di Render. I Worker Cloudflare girano su IP che
 * non vengono bloccati.
 *
 * Deploy (gratis, 100k req/giorno):
 *   1. https://dash.cloudflare.com → Workers & Pages → Create Worker
 *   2. Incolla questo file → Save and Deploy
 *   3. Ottieni l'URL: https://<nome>.<subdomain>.workers.dev
 *   4. Su Render imposta la env var:
 *        PROXY_URL=https://<nome>.<subdomain>.workers.dev/?url=
 *
 * Utilizzo:
 *   GET https://<worker>/?url=https%3A%2F%2Fstreaming-community.watch%2Ffilm%2F
 */

export default {
    async fetch(request) {
        const url = new URL(request.url);
        const target = url.searchParams.get('url');

        if (!target) {
            return new Response('Missing ?url= parameter', { status: 400 });
        }

        // Sanity check: allow only streaming-community.watch targets
        try {
            const parsed = new URL(target);
            if (!parsed.hostname.endsWith('streaming-community.watch')) {
                return new Response('Forbidden host', { status: 403 });
            }
        } catch (e) {
            return new Response('Invalid url', { status: 400 });
        }

        try {
            const response = await fetch(target, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Sec-GPC': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'DNT': '1',
                },
                redirect: 'follow',
            });

            const contentType = response.headers.get('Content-Type') || 'text/html; charset=utf-8';

            return new Response(response.body, {
                status: response.status,
                headers: {
                    'Content-Type': contentType,
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                },
            });
        } catch (e) {
            return new Response(`Proxy error: ${e.message}`, { status: 502 });
        }
    },
};
