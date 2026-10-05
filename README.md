# Pocket Money Pal

Pocket Money Pal turns chores and pocket money into a game for kids. A screen on the family PC shows each child's quests for the day and how long they have left to finish them, parents approve finished chores from their phones, and once a week the points become money that the kids save in jars for the things they want. It runs on your home network, with no accounts or cloud service needed.

<table>
  <tr>
    <td width="72%"><img src="screenshots/kiosk.png" alt="The kids' screen: a column per child with today's quests"></td>
    <td width="28%"><img src="screenshots/phone-tray.png" alt="A parent's phone approving chores"></td>
  </tr>
</table>

## What it does

- Shows a column per child on the kids' screen, with each quest's time window (early bonus, on time, late), a countdown to the next deadline, levels and daily streaks.
- Kids tap a quest when it's done; a parent approves it, or sends it back with a note, with a swipe on their phone.
- Parents set up quests, times and points from the phone, starting from a library of common chores.
- A weekly payday turns points into money, which the kids pour into savings jars. Parents send gifts and record spending.
- Surprise quests pop up on the kids' screen for them to race for, or take on together.
- Sounds and animations for claims, approvals, level-ups and payday, with quiet hours.
- A holiday pause and sick days, so time off doesn't break a streak.
- Optionally, over [Tailscale](https://tailscale.com): notifications on parents' phones, an installable app, and planning while the PC is off.

## Install

You need a Windows 10 or 11 PC for the kids' screen (a second monitor works well), and parents' phones on the same Wi-Fi.

1. Download `Pocket-Money-Pal-Setup-<version>.exe` from the [Releases page](https://github.com/chris-hammond-ross/pocket-money-pal/releases).
2. Run it. It isn't code-signed yet, so Windows SmartScreen warns about it: choose **More info**, then **Run anyway**. When Windows asks about **Network Command Shell**, choose **Yes**; that lets phones connect.
3. The kids' screen opens with a QR code. Scan it with your phone and follow the four setup steps: grown-ups, children, quests and the points rate.
4. Pair the other grown-ups' phones from **Players > Pair another phone**.

Updates install themselves. The [installation guide](installation.md) covers choosing the monitor, notifications with Tailscale, backups and uninstalling, and the [user guide](user-guide.md) explains day-to-day use.

## Running from source

You need Node.js 22 or newer.

```bash
npm install
npm run dev            # server on :4789 and Vite on :5173, both on the LAN
npm run desktop:dev    # build everything and open the kiosk window (Electron)
npm test               # unit and API tests
npm run lint && npm run typecheck
```

Open http://localhost:5173/kiosk on the PC, and `http://<pc-address>:5173/parent` on a phone. Phones need a firewall rule for the port; see [Running from source](installation.md#running-from-source) for that, the environment variables, and building the installer.

## How it fits together

- `apps/server`: Fastify, SQLite (Drizzle) and a WebSocket hub. It holds all the data and rules, runs the scheduler (new days, payday, surprises), and serves the web app. It's the single source of truth.
- `apps/web`: React and Mantine. `/kiosk` is the kids' screen and `/parent` is the phone app. Every screen is a client of the server and refreshes when it broadcasts a change.
- `apps/desktop`: Electron. It starts the server, shows the kiosk full screen on the chosen monitor, and handles the tray and auto-updates.
- `packages/shared`: Zod schemas and the rules (points, streaks, levels, payday, money in integer cents) as pure, tested functions used by both.

## Licence

[ISC](LICENSE)
