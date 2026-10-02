# Pocket Money Pal

A game-like chore and pocket-money app for kids. Read `docs/plan.md` for the full plan (architecture, process, roadmap). Build work runs in sessions listed in `docs/roadmap.md`: follow its standard session rules and write a handover note when you finish.

## Architecture in one breath

Server-first. `apps/server` (Fastify + SQLite/Drizzle + WebSocket) is the source of truth and serves the built React app. Every screen is just an HTTP/WS client: the kiosk window (Electron, `apps/desktop`), parents' phones on the LAN (`/parent`), and later Home Assistant. Never put business logic in Electron or only in the web client.

```
apps/server     Fastify API, WebSocket hub, scheduler, Drizzle schema + migrations
apps/web        React + Vite + Mantine. Routes: /kiosk, /parent
apps/desktop    Electron shell: forks the server, opens the kiosk window
packages/shared Zod schemas, domain types, points/money rules (pure functions)
prototypes/     GITIGNORED throwaway HTML/JS prototypes
docs/           plan.md, features/ (committed specs), decisions/ (ADRs)
```

## Commands

- `npm run dev`: server (http://localhost:4789) + Vite (http://localhost:5173, proxies /api and /ws). Both listen on the LAN.
- `npm run build`: builds shared → web → server. `npm start` then serves everything on :4789.
- `npm run desktop:dev`: builds, stages the server for Electron, launches the kiosk window.
- `npm test` / `npm run lint` / `npm run typecheck` / `npm run format`
- `npm run db:generate -w @pmp/server`: generate a migration after editing `apps/server/src/db/schema.ts`.

## Conventions

- TypeScript strict, ESM everywhere. Shared code imported as `@pmp/shared`.
- **Money is integer cents; points are integers.** Never floats for money. Conversion and scoring live in `packages/shared` as pure, unit-tested functions.
- The ledger is append-only; balances are derived from it.
- Validate every API input with the Zod schemas from `@pmp/shared`.
- After a state change, the server broadcasts a WS event; clients invalidate TanStack Query caches rather than patching state by hand.
- Branches `feat/…` / `fix/…`, conventional commits, PR to `main`; CI (lint, typecheck, test) must pass.
- Record notable decisions as short ADRs in `docs/decisions/NNNN-title.md`.

## Prototyping workflow (important)

Features are prototyped **before** they are built. When asked to prototype a feature (or via `/prototype`):

1. Create `prototypes/NNN-feature-name/` (next free number, kebab-case name).
2. Build **three genuinely different** approaches in `a/index.html`, `b/index.html` and `c/index.html`. Vary the interaction model or layout, not just the colours.
3. Plain HTML/CSS/JS only: no build step, openable by double-click. CDN scripts are fine (e.g. canvas-confetti). One file per prototype where practical.
4. Use `prototypes/_shared/mock-data.js` for data (Billy, Alice, chores, goals) so the options are comparable. Extend it if needed.
5. Start each prototype with a short comment/banner: the idea behind it and what to evaluate.
6. Add `prototypes/NNN-feature-name/index.html` linking the three options side by side.
7. Keep it fast and throwaway. No tests, no production polish.

`prototypes/` is gitignored. Once the user picks and refines a direction, write the committed spec in `docs/features/NNN-feature-name.md` (the chosen interaction, key screens, edge cases, what was rejected and why) **before** implementing in the real stack.

## Product context worth remembering

- Kiosk: a shared family PC, second monitor dedicated to the app, used by kids and almost never by adults. Readable from across the room; touch/mouse friendly; sounds and animations are core, not garnish.
- Parents act from their paired phones on the home Wi-Fi: approvals and every other parent action happen there, never on the kiosk. There's no kiosk PIN or parent mode (ADR 0008).
- Chores speak in **points**; goals/savings speak in **money**.
- Home Assistant is an optional integration, never a dependency.
- Open source is a long-term goal: keep things configurable, but don't sacrifice features for it.
