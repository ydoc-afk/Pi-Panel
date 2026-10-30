import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  app.get('/api/health', async () => ({ status: 'ok' }));
  return app;
}
