# 0001: Server-first architecture, wrapped in Electron

**Status:** accepted · 2026-09-29

## Context

The app runs on a shared family PC (a dedicated second monitor acting as a kiosk), but parents rarely use that PC. They need to approve chores, trigger surprise tasks and change settings from their phones on the home network, and Home Assistant may integrate later.

## Decision

The Node server (`apps/server`) is the core of the app. It owns the SQLite database, all business rules, a REST API and a WebSocket event stream, and it serves the built React app on `0.0.0.0:4789`. Every screen is a client of it: the Electron kiosk window, parents' phone browsers and, later, Home Assistant.

Electron (`apps/desktop`) is a thin shell. It forks the bundled server in a `utilityProcess`, keeps the display awake, and shows `/kiosk` full screen on the chosen monitor. It holds no business logic.

## Consequences

- Remote access on the home network comes for free. Adding HA or other clients means adding API routes, not new architecture.
- The server can run on its own (`npm start`), for example on a Raspberry Pi, in Docker, or as an HA add-on, which helps the open-source goal.
- The LAN API needs real authentication (parent PINs, paired device tokens) before it exposes anything sensitive.
- better-sqlite3 (a native module) ships with the desktop app. From v13 it uses Node-API prebuilds, so no Electron-specific rebuild is needed.
