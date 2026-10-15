import { createRemoteJWKSet, jwtVerify } from 'jose';
import { githubConfigured, readLimited, readOperationalStatus, REPOSITORY } from './github.mjs';

const securityHeaders = {
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

function secured(response) {
  const copy = new Response(response.body, response);
  for (const [key, value] of Object.entries(securityHeaders)) copy.headers.set(key, value);
  return copy;
}

function deny(message, status) {
  return secured(new Response(message, {
    status, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  }));
}

function json(body, status = 200, head = false) {
  return secured(new Response(head ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
}

export function createWorker({ resolveKeys } = {}) {
  let cachedIssuer;
  let cachedKeys;
  const keysFor = resolveKeys ?? ((issuer) => {
    if (cachedIssuer !== issuer) {
      cachedKeys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      cachedIssuer = issuer;
    }
    return cachedKeys;
  });

  return {
    async fetch(request, env) {
      const issuer = env.ACCESS_TEAM_DOMAIN;
      const allowed = (env.ACCESS_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
      if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer ?? '') || !env.ACCESS_AUD || !allowed.length) {
        return deny('Panel is locked until Cloudflare Access is configured.', 503);
      }

      // Run before EVERY asset; a spoofed identity header is not authentication.
      const token = request.headers.get('cf-access-jwt-assertion');
      if (!token) return deny('Sign in through Cloudflare Access.', 401);
      let email;
      try {
        const { payload } = await jwtVerify(token, keysFor(issuer), {
          issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'],
          requiredClaims: ['exp', 'iat', 'sub', 'email'],
        });
        email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
        if (payload.type !== 'app' || !allowed.includes(email)) return deny('Access denied.', 403);
      } catch {
        return deny('Access denied.', 403);
      }

      const url = new URL(request.url);
      const connected = env.PANEL_WRITES_ENABLED === 'true' && githubConfigured(env) && Boolean(env.RULES_WORKSPACE);
      const action = { '/api/workspace': 'workspace', '/api/draft': 'draft', '/api/preview': 'preview', '/api/publish': 'publish', '/api/rollback': 'rollback' }[url.pathname];
      if (action) {
        if ((action === 'workspace' && !['GET', 'HEAD'].includes(request.method)) || (action !== 'workspace' && request.method !== 'POST')) return deny('Method not allowed.', 405);
        if (action !== 'workspace') {
          if (request.headers.get('origin') !== url.origin || request.headers.get('x-panel-request') !== '1'
            || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json'
            || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'Niedozwolone zrodlo zadania.' }, 403);
        }
        if (!connected) {
          if (action !== 'workspace') return json({ error: 'Zapis na GitHub nie jest jeszcze aktywny.' }, 503);
          try {
            const snapshot = await (await env.ASSETS.fetch(new Request(new URL('/policy-snapshot.json', url)))).json();
            return json({ snapshot, draft: null, preview: null, history: [], status: await readOperationalStatus(snapshot.baseline),
              capabilities: { sharedDraft: false, publish: false, preview: false, reason: 'Prywatny podglad. Integracja zapisu GitHub nie jest aktywna.' } }, 200, request.method === 'HEAD');
          } catch { return json({ error: 'Nie mozna odczytac stanu panelu.' }, 503); }
        }
        let input = {};
        if (request.method === 'POST') {
          let bytes;
          try { bytes = await readLimited(new Response(request.body, { headers: request.headers }), 256 * 1024); }
          catch { return json({ error: 'Zadanie jest zbyt duze.' }, 413); }
          try { input = JSON.parse(new TextDecoder().decode(bytes)); }
          catch { return json({ error: 'Nieprawidlowy JSON.' }, 400); }
          if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'Nieprawidlowe dane.' }, 400);
        }
        try {
          const result = await env.RULES_WORKSPACE.getByName(REPOSITORY).handle(action, input, email);
          return json(result.body, result.status, request.method === 'HEAD');
        } catch {
          console.error(JSON.stringify({ event: 'workspace_unavailable', action }));
          return json({ error: 'Nie potwierdzono operacji. Odswiez stan przed ponowieniem.' }, 503);
        }
      }

      if (!['GET', 'HEAD'].includes(request.method)) {
        const response = deny('Publishing is not connected. Read-only server.', 405);
        response.headers.set('Allow', 'GET, HEAD');
        return response;
      }
      if (url.pathname === '/api/session') {
        return secured(new Response(request.method === 'HEAD' ? null : JSON.stringify({ email, publish: connected }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }));
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'Nieznana operacja.' }, 404);
      try {
        return secured(await env.ASSETS.fetch(request));
      } catch {
        console.error(JSON.stringify({ event: 'assets_unavailable' }));
        return deny('Panel temporarily unavailable.', 503);
      }
    },
  };
}

export default createWorker();
