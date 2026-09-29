# 🪙 Pocket Money Pal

Chores, pocket money, savings goals, and a good helping of game mechanics for kids.

Each child gets a column on a shared kiosk screen with today's chores. They tick chores off, earn points (with bonuses for being early or doing it without being asked), and watch their savings grow towards goals they choose, like a basketball or a PlayStation. Parents approve chores with a quick PIN, or from their phone on the home Wi-Fi, and can fire off surprise bounty tasks from anywhere in the house.

> **Status:** early development (Phase 0, foundations). See [docs/plan.md](docs/plan.md) for the architecture and roadmap.

## How it fits together

- **Server** (`apps/server`): Node + Fastify + SQLite. It holds all the data and rules and serves the app to every screen on the local network.
- **Web app** (`apps/web`): React + Mantine. `/kiosk` is the kids' dashboard and `/parent` is the phone-friendly parent view.
- **Desktop** (`apps/desktop`): Electron. It starts the server and shows the kiosk full screen on a chosen monitor.
- **Shared** (`packages/shared`): types, validation, and the points and money rules.

## Development

Requires Node 22+.

```bash
npm install
npm run dev            # server on :4789 + Vite on :5173 (both reachable on your LAN)
npm run desktop:dev    # build everything and open the Electron kiosk window
npm test               # unit + API tests
npm run lint && npm run typecheck
```

Open http://localhost:5173/kiosk, and on your phone go to `http://<this-pc-ip>:5173/parent`. Press "Ping all screens" on one device and watch it appear on the other.

Production-style run: `npm run build && npm start`, then open http://localhost:4789.

Desktop environment variables: `PMP_DISPLAY=<index>` picks the monitor, `PMP_KIOSK=1` locks the window into kiosk mode, and `PMP_SERVER_URL=http://localhost:5173` uses the dev server instead of the bundled one.

### Prototypes

New features start as three quick HTML prototypes in the gitignored `prototypes/` folder. See [CLAUDE.md](CLAUDE.md#prototyping-workflow-important).

## License

[MIT](LICENSE)
