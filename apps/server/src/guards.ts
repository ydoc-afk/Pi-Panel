import type { FastifyInstance, FastifyRequest } from 'fastify';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Content-Security-Policy for the UI. Mantine injects <style> tags at runtime, hence the inline
 * styles; scripts, frames and everything else stay same-origin.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

/** Extra origins allowed to call the API, e.g. a reverse proxy that rewrites Host. */
function extraOrigins(): Set<string> {
  return new Set(
    (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );
}

/**
 * Whether a request's Origin matches the host it was sent to. SameSite=Strict cookies still go
 * along with requests from other ports on the same host (they are the same "site"), so a page
 * served by another app on this machine could otherwise drive the API with the user's session.
 * Requests without an Origin header (curl, server-to-server) carry no browser cookies to abuse.
 */
export function originAllowed(req: FastifyRequest, allowed = extraOrigins()): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowed.has(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function registerGuards(app: FastifyInstance) {
  const allowed = extraOrigins();

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // WebSocket upgrades are GETs, but browsers do not apply CORS to them, so check those too.
    const upgrade = req.headers.upgrade?.toLowerCase() === 'websocket';
    if (SAFE_METHODS.has(req.method) && !upgrade) return;
    if (!originAllowed(req, allowed)) {
      return reply.code(403).send({ error: 'Cross-origin request refused' });
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(k)) reply.header(k, v);
    }
    return payload;
  });
}
