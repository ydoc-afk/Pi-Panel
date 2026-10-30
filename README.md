# Pi-Panel

A self-hosted web panel for running the [pi](https://pi.dev) coding agent in isolated, per-project Docker containers.

> Status: early scaffold (milestone 1, step 1). See the plan for scope.

## Development

Requires Node 22.19+.

```bash
npm install
npm run dev:server   # API on :3000
npm run dev:web      # UI on :5173, proxies /api to the server
npm run typecheck && npm test && npm run lint
```

## Layout

- `apps/server`: Fastify + TypeScript backend
- `apps/web`: React + Vite frontend
- `docker/base`: sandbox base image (Node 22 + pi)
- `docker-compose.yml`: one-command install
