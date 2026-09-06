# Kalshi Parlay Desk

A self-updating parlay research board built from live [Kalshi](https://kalshi.com) game markets
(MLB, Bundesliga, EFL Cup, WNBA). Research / preview only — nothing here is an executed order.

- **`index.html`** — the dashboard. A calendar strip selects a day; each day renders its
  KPIs, auto-built 3–6 leg parlay tickets, timing notes, and games/legs tables from an
  embedded `board-data` JSON blob. All ticket math (multiplier, all-hit %, EV) is computed
  in-page from the legs.
- **`refresh-board.mjs`** — pulls the four Kalshi series, computes each game's de-vigged
  win %, entry, volume tier, and start time, groups games into days, builds the tickets by
  rule, and splices the new `board-data` blob into `index.html`. No dependencies (Node 18+).
- **`.github/workflows/refresh.yml`** — runs `refresh-board.mjs` every day at 12:00 UTC
  (8:00 AM ET) and commits `index.html` if it changed. Also runnable on demand via
  *Actions → Refresh Kalshi board → Run workflow*.

Served by GitHub Pages from the repo root.

Run locally:

```
BOARD_TARGETS=index.html node refresh-board.mjs
```
