# Fork Runner

Fork Runner is a responsive endless-runner browser game where players jump over approaching fork hazards and chase a high score.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/fork-runner run dev` — run the game preview
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/fork-runner/src/App.tsx` — game state, requestAnimationFrame loop, physics, collision detection, controls, and canvas rendering
- `artifacts/fork-runner/src/index.css` — responsive full-viewport game shell, HUD, overlays, buttons, and motion

## Architecture decisions

- The game runs entirely in the browser with no backend, database, auth, or external runtime dependencies.
- Canvas is used for the active scene so parallax, particles, obstacles, and character motion stay lightweight.
- React owns overlay/HUD state while mutable frame-by-frame game data stays in refs to avoid rerendering every animation frame.
- Best distance is persisted locally so the game remains personal without requiring accounts.

## Product

- Start instantly with a button, Space, click, or touch.
- Jump over original fork-shaped hazards with responsive keyboard and touch controls.
- Survive an accelerating run, see live distance, and retry immediately after a collision.
- Responsive layout prevents page scrolling and works across desktop, tablet, and mobile.

## User preferences

- Keep the game original and lightweight; do not copy Chrome Dinosaur artwork, branding, or UI.

## Gotchas

- The game workflow provides `PORT` and `BASE_PATH`; run it through the managed workflow or use the artifact preview rather than starting Vite without those variables.
- `body` and `.runner-app` intentionally hide overflow and set `touch-action: none` so mobile play does not scroll the page.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
