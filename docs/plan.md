# Pocket Money Pal: Project Plan

## Context

Pocket Money Pal is a game-like chore and pocket-money app for a family, open source later. The repo (`C:\Home\Projects\Apps\pocket-money-pal`) is empty: no commits yet, and Node 22 is installed.

What we know about the setup:

- One shared PC in a family area, used by the kids. One of its two monitors can show the app full time, like a kiosk.
- Parents almost never sit at that PC. They need to approve chores, trigger surprise tasks and change settings **from their phones on the home network**. Access from outside the home comes later.
- Home Assistant (HA) is on the network. It is an **optional add-on**, not a dependency.

The plan covers three things: architecture, development process, and features with a roadmap.

---

## 1. Architecture

### Key decision: a server-first app, wrapped in Electron

The remote-access requirement shapes everything else. The Node server is the core of the app, not a hidden detail inside Electron:

```
┌──────────────── Family PC ────────────────┐
│ Electron shell (apps/desktop)             │
│  ├─ starts the server (utilityProcess)    │      Parent phones (LAN)
│  └─ kiosk window on monitor 2  ──────┐    │      browser / home-screen web app
│                                      ▼    │             │
│ Node server (apps/server) 0.0.0.0:4789 ◄──┼─────────────┘
│  ├─ REST API + WebSocket (live updates)   │      Home Assistant (later)
│  ├─ serves the built React app            ◄──── REST + API token / webhooks out
│  ├─ scheduler (daily chores, alerts)      │
│  └─ SQLite file in the user data folder   │
└───────────────────────────────────────────┘
```

- Everything goes through the HTTP API, so the kiosk window, a parent's phone and HA are just different clients of the same server. Remote access is built in, not added on.
- A WebSocket pushes changes to every screen. When a parent triggers a surprise task on their phone, the kiosk shows it straight away, with animation and sound.
- The server can also run without Electron (`npm start`). This matters for open source later: it could run on a Raspberry Pi, in Docker, or as an HA add-on without being rewritten.

### Stack (builds on your suggestions, all TypeScript)

| Layer     | Choice                                                                          | Why                                                                              |
| --------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Monorepo  | npm workspaces                                                                  | Nothing extra to install; enough for 4 packages                                  |
| Server    | Node 22, **Fastify**, `@fastify/websocket`, `@fastify/static`                   | Fast, typed, built-in schema validation                                          |
| Database  | **SQLite** via `better-sqlite3` + **Drizzle ORM** (migrations)                  | One file, easy to back up; Drizzle gives typed queries and migrations            |
| Shared    | `packages/shared`: Zod schemas, types, **points and money rules**               | The same validation and scoring on server and client                             |
| Frontend  | React + Vite + **Mantine**, TanStack Query, React Router                        | As you suggested; TanStack Query handles caching and refresh on WebSocket events |
| Game feel | Framer Motion (animation), `canvas-confetti` (party popper), Howler.js (sounds) | Light and well-known libraries                                                   |
| Desktop   | Electron + electron-builder (NSIS installer)                                    | Kiosk window, start at login, stops the screen sleeping, allows auto-play sounds |
| Testing   | Vitest (unit and API), Playwright (end-to-end against the web app)              |                                                                                  |
| Tooling   | ESLint, Prettier, TypeScript strict mode, GitHub Actions CI                     |                                                                                  |

**Note:** `better-sqlite3` is a native module, but from v13 it ships Node-API prebuilds, so the same binary works in Node and in Electron with no `electron-rebuild`. The desktop build copies it next to the bundled server (`apps/desktop/scripts/stage-server.mjs`).

### Repo layout

```
apps/server     Fastify API, WebSocket, scheduler, Drizzle schema and migrations
apps/web        React app: routes /kiosk, /parent, /setup
apps/desktop    Electron main process: starts the server, kiosk window, tray icon
packages/shared Zod schemas, domain types, scoring and money functions (pure, fully tested)
prototypes/     GITIGNORED: throwaway HTML/JS prototypes
docs/           Feature specs, decision records, user guide
CLAUDE.md       Project conventions and the prototyping workflow, for the LLM
```

### Data model (first draft)

- **family_settings**: currency, points-to-money rate, timezone, sound volume, quiet hours
- **users**: `role` (parent or child), name, avatar and colour, PIN hash, column order
- **chores** (templates): title and icon, base points, recurrence (daily or chosen weekdays), `due_by`, `bonus_before`, `late_after`, penalty, whether it needs approval, and whether it is shared and how points split between kids
- **chore_assignments**: chore ↔ child (many-to-many, which covers shared chores)
- **chore_instances**: one row per chore per child per day, created by the scheduler. State goes `open → claimed → approved | rejected`, plus `claimed_at`, the child's "did it without being asked" flag, and the bonuses the parent confirmed
- **ledger** (append-only; every balance is calculated from it): child, kind (`chore_points`, `bonus`, `penalty`, `conversion`, `extra_income`, `goal_allocation`, `spend`, `adjustment`), points and/or money **stored as whole cents**, note, and who made the entry
- **goals**: child, name, target in cents, term (short, medium or long), image path, shop URL, priority, and `achieved_at`
- **surprise_tasks**: title, reward, who can claim it (a named child or first to claim), expiry, and trigger source (parent, schedule or HA)
- **devices / api_tokens**: paired parent phones and HA tokens (stored hashed)
- **events** (audit and activity feed): drives the "what happened today" view and later badges

### Accounts and security

- **Kids** on the kiosk: they tap their column or avatar. A PIN is optional, since siblings share the screen.
- **Parents on the kiosk**: a PIN opens a **short elevated session** (about 60 seconds, a visible countdown, restarts on each action, and an "End" button). Failed attempts are rate-limited.
- **Parents on a phone**: pair once by scanning a **QR code** shown on the kiosk during a parent session. The phone gets a long-lived device token, and each device can be revoked. After that, opening the page on the phone logs the parent straight in.
- Access is limited to the home network at first. Plain HTTP on the network means the phone can't install it as a full app with offline support (browsers require HTTPS for that), but a bookmarked page or home-screen shortcut works fine. HTTPS comes for free later through Tailscale or HA remote access.

### Remote access and Home Assistant (in stages)

1. **Home network (MVP)**: the server listens on the network at `http://<pc-ip>:4789/parent`. It also announces itself as `pocketmoneypal.local` (mDNS) so nobody has to remember the IP. The installer adds the Windows firewall rule.
2. **HA add-on (later)**: HA uses long-lived API tokens to call the REST API (create a surprise task, read balances). The app sends webhooks to HA (chore overdue, goal reached), so HA can announce them on speakers, flash lights or notify parents' phones through the HA app. After that, possibly MQTT discovery so kids' points show up as HA sensors.
3. **Away from home (later)**: Tailscale on the PC, or HA's remote access. No port forwarding.

---

## 2. Development Process

### Prototype, pick, spec, build

For each substantial feature:

1. **Brief**: you describe the goal in a sentence or two.
2. **Three prototypes**: the LLM builds 3 _different_ takes in `prototypes/NNN-feature-name/{a,b,c}/index.html`. They are plain HTML, CSS and JS, open straight in a browser, with no build step. A small `index.html` compares them side by side. They share a mock-data file (`prototypes/_shared/mock-data.js`, with Billy, Alice and sample chores) so the options are easy to compare.
3. **Refine**: you pick one, or combine parts of several, and iterate in the prototype.
4. **Spec**: because prototypes are gitignored, whatever we learn gets written into a **committed** `docs/features/NNN-feature-name.md`. It covers the chosen interaction, screenshots and edge cases, and is what the build step works from.
5. **Implement** on a feature branch in the real stack, with tests, then open a PR to `main` with CI passing.

The prototyping rules go in `CLAUDE.md`: 3 genuinely different approaches, one file each where possible, mock data only, and a short note at the top of each prototype describing its idea. We can also add a `/prototype` slash command (a project skill) so a round starts with one line.

### Conventions

- `.gitignore`: `node_modules`, `dist`, `out`, `*.db`, `prototypes/`, `.env`
- Branches `feat/...` and `fix/...`, conventional commits, PRs to `main`, and a small CI run on each PR (lint, typecheck, tests)
- Scoring and money logic lives in `packages/shared` as pure functions with thorough unit tests. The bonus, penalty and conversion rules are where bugs would cause the most arguments at home.
- `docs/decisions/` holds short records of decisions (for example, "why server-first").
- `npm run dev` runs the server and Vite together. The web app works in any browser during development, so Electron is only needed to test kiosk-specific behaviour.

---

## 3. Features and Roadmap

### Feature list (tidied up from your brain dump)

**Family and accounts**: 2 parents and any number of children; the screen and permissions change with the role; kiosk PIN session with countdown; phone pairing.

**Kiosk dashboard**: one column per child, side by side (Billy | Alice), in each child's colour and avatar. Each column shows today's chores, points today and this week, the top goal's progress bar, and alerts. Shared chores show in both columns and are marked as shared. Designed to be read from across the room on the second monitor.

**Chores**

- The child ticks a chore as claimed and can mark "I did it without being asked". A parent then approves it, or rejects it with a note.
- Points tiers: **base** points; **early bonus** if claimed before `bonus_before`; **unprompted bonus** (the parent confirms it); **late penalty** after `late_after`. Parents can override any of these when approving.
- Recurrence: daily, chosen weekdays, or one-off.
- Batch approval: approve all claimed chores in one go at the end of the day.

**Alerts and timers**: "Bonus ends in 15 minutes" countdowns, a ticking-clock sound in the final minutes, an overdue state, and quiet hours.

**Points and money**: chore screens show **points**; savings and goal screens show **money**. The conversion rate is set per family. _Still to decide (a good first prototype): does conversion happen automatically, or on a weekly "payday" that the kids watch happen?_

**Savings and extra income**: a child or parent adds money from other sources (for example, £20 from Grandma), which adds to savings and brings goal dates forward. The ledger history shows each child's full money story.

**Goals**: set by the child, with a name, price, term (short, medium or long), an image (upload or paste), and a shop link. The app can fetch the product image from the link automatically. Stats include: amount still needed, **chores still needed** (based on the child's recent average points), and an **estimated date**, for example "2 weeks or 5 chores to go!". A celebration plays when a goal is reached.

**Game layer**: party popper on early completion, sounds for claim, approve, goal progress and level-up, a daily streak counter, badges (first unprompted chore, 7-day streak, first goal reached), and possibly weekly XP levels.

**Surprise tasks and bounties**: a parent triggers one from their phone, or it appears at a random time within a window. It pops up on the kiosk with an alarm-style animation, has an expiry countdown, and is either first-to-claim or assigned to one child.

**Parent phone app (/parent)**: approval queue, trigger a surprise task, manage chores, children, goals and rates, make balance adjustments, and view the activity feed.

**Open source readiness**: a first-run setup wizard, currency and locale settings, backup and restore of the database file, a Windows installer with auto-update, an LLM-friendly README and user guide, and a licence (MIT suggested).

### Roadmap

| Phase                     | Goal                                                                                                                                                                                                                         | Prototype rounds                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **0. Foundations**        | `CLAUDE.md`, `.gitignore`, `prototypes/` with shared mock data, monorepo scaffold, Fastify + SQLite + Drizzle with one migration, React + Mantine shell, WebSocket "ping" shown live, Electron window loading the server, CI | none                                                                |
| **1. Look and feel**      | Choose the visual style and kiosk layout                                                                                                                                                                                     | **Kiosk column dashboard** (3 styles); **parent PIN approval flow** |
| **2. Core loop (MVP)**    | Family setup, chores and daily instances, child claims, parent PIN approval, points ledger, live kiosk                                                                                                                       | Chore claim interaction                                             |
| **3. Parent phone**       | Home network access, QR pairing, approval queue, chore management on the phone                                                                                                                                               | Phone approval screen                                               |
| **4. Money and goals**    | Conversion and payday, savings, extra income, goals with images and links, stats and estimated date                                                                                                                          | **Payday model**; goal card and progress                            |
| **5. Game layer**         | Bonus and penalty tiers, alerts and timers, sounds, confetti, streaks, badges                                                                                                                                                | Celebration and alert styles                                        |
| **6. Surprise tasks**     | Bounties triggered from the phone, random scheduling                                                                                                                                                                         | Surprise pop-up                                                     |
| **7. Home Assistant**     | API tokens, webhooks out, example HA automations                                                                                                                                                                             | none                                                                |
| **8. Open source polish** | Setup wizard, installer and auto-update, backup, docs, locale                                                                                                                                                                | Setup wizard                                                        |

Phase 3 comes early on purpose. With the server-first design it costs little, and it removes the "walk to the PC" problem while you are still testing the MVP.

---

## First steps once this plan is approved (Phase 0)

1. Create `.gitignore`, `CLAUDE.md` (conventions and prototype workflow), `README.md`, `LICENSE`, and `docs/` (this plan copied to `docs/plan.md` so it's in the repo).
2. Create `prototypes/_shared/mock-data.js` and `prototypes/README.md`. The folder is gitignored, so it stays local.
3. Scaffold the workspaces: `packages/shared`, `apps/server`, `apps/web`, `apps/desktop`, with root scripts `dev`, `build`, `test`, `lint`, `typecheck`.
4. Server: Fastify with `/api/health`, a WebSocket hub, the Drizzle schema for `users` and `family_settings` with its first migration, and a database path set by env var or the Electron user data folder.
5. Web: Mantine provider and theme, routes `/kiosk` and `/parent` showing placeholders plus the live WebSocket status.
6. Desktop: Electron starts the server, opens a fullscreen window on the chosen display, stages the bundled server with its native module, and has an installer build script.
7. GitHub Actions workflow and the first commit.

## Verification (Phase 0)

- `npm run dev`: http://localhost:4789/kiosk loads, and `/api/health` returns ok.
- From a phone on home Wi-Fi, `http://<pc-ip>:4789/parent` loads. Changing something on one device updates the other through the WebSocket.
- `npm run desktop:dev` opens the Electron kiosk window on monitor 2, and the database file appears in the user data folder.
- `npm test`, `npm run lint` and `npm run typecheck` pass locally and in CI.
- `git status` shows nothing from `prototypes/`.

After Phase 0, the first prototype round is the **kiosk column dashboard (3 visual styles)**, because it sets the look for everything else.
