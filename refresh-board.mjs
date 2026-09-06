// refresh-board.mjs — rebuild the Kalshi Parlay Desk board-data blob from live Kalshi data.
// No dependencies (Node 18+ global fetch). Exits non-zero on any pull failure so the
// scheduler skips the publish step. Splices the new JSON into kalshi-parlay-desk.html
// (and k123) between the <script id="board-data"> markers; touches nothing else.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
// Files to rewrite in place, comma-separated, relative to this script's dir.
// GitHub Action sets BOARD_TARGETS=index.html; locally it defaults to both working copies.
const TARGETS = (process.env.BOARD_TARGETS || "kalshi-parlay-desk.html,k123")
  .split(",").map((s) => s.trim()).filter(Boolean).map((f) => path.join(DIR, f));
const SRC = TARGETS[0];

const BASE =
  "https://api.elections.kalshi.com/trade-api/v2/events?status=open&with_nested_markets=true&limit=200&series_ticker=";
const SERIES = { mlb: "KXMLBGAME", bundes: "KXBUNDESLIGAGAME", efl: "KXEFLCUPGAME", wnba: "KXWNBAGAME" };
const CAL_DAYS = 4; // calendar window

// ---------- helpers ----------
const round1 = (n) => Math.round(n * 10) / 10;
const nyFmtDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const nyFmtParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", hour12: true,
});

function etParts(iso) {
  const d = new Date(iso);
  const p = Object.fromEntries(nyFmtParts.formatToParts(d).map((x) => [x.type, x.value]));
  const id = nyFmtDate.format(d); // YYYY-MM-DD
  const time = `${p.hour}:${p.minute}${p.dayPeriod[0].toLowerCase()}`.replace(":00", "");
  return { id, dow: p.weekday, d: +p.day, mon: p.month, label: `${p.weekday} ${p.month} ${+p.day}`, time };
}
function fmtVol(v) { return v >= 1000 ? `${Math.round(v / 1000)}k` : `${(v / 1000).toFixed(1)}k`; }
function tier(vol, spreadCents) {
  if (vol >= 40000 && spreadCents <= 1.01) return "A";
  if (vol < 15000 || spreadCents >= 2.99) return "C";
  return "B";
}
const isTie = (s) => /(^|\b)tie\b/i.test(s || "");

async function pull(series) {
  const r = await fetch(BASE + series);
  if (!r.ok) throw new Error(`${series}: HTTP ${r.status}`);
  const j = await r.json();
  if (!j || !Array.isArray(j.events)) throw new Error(`${series}: malformed response`);
  return j.events;
}

// ---------- build a game record from one event ----------
function gameFromEvent(ev, sport) {
  const mkts = (ev.markets || []).filter((m) => m.status === "active");
  const sides = mkts.filter((m) => !isTie(m.yes_sub_title));
  if (sides.length < 2) return null;
  const mid = (m) => ((+m.yes_bid_dollars) + (+m.yes_ask_dollars)) / 2 * 100;
  const spr = (m) => ((+m.yes_ask_dollars) - (+m.yes_bid_dollars)) * 100;
  const allMid = mkts.reduce((a, m) => a + mid(m), 0);
  if (!(allMid > 0)) return null;
  sides.sort((a, b) => mid(b) - mid(a));
  const fav = sides[0];
  const ep = etParts(fav.occurrence_datetime || ev.markets[0].close_time);
  const title = String(ev.title || "").split(":")[0].trim();
  const parts = title.split(/\s+vs\.?\s+/i);
  const away = (parts[0] || "").trim();
  const home = (parts[1] || "").trim();
  const favMid = mid(fav);
  const g = {
    date: ep.id, dow: ep.dow, d: ep.d, mon: ep.mon, label: ep.label,
    sport, away, home,
    pick: String(fav.yes_sub_title || "").replace(/^Reg Time:\s*/i, "").trim(),
    entry: Math.round((+fav.yes_ask_dollars) * 100),
    winPct: round1((favMid / allMid) * 100),
    volNum: fav.volume_24h_fp || 0,
    vol: fmtVol(fav.volume_24h_fp || 0),
    tier: tier(fav.volume_24h_fp || 0, spr(fav)),
    time: ep.time,
    favMid,
  };
  if (sport !== "mlb" && favMid >= 92) { g.skip = true; g.entry = null; }
  return g;
}

// ---------- ticket construction ----------
const uniqByMatch = (arr) => {
  const seen = new Set();
  return arr.filter((g) => { const k = g.away + "|" + g.home; if (seen.has(k)) return false; seen.add(k); return true; });
};
const leg = (g) => ({ sport: g.sport, match: `${g.away} vs ${g.home}`, pick: g.pick, winPct: g.winPct, entry: g.entry });

function buildParlays(dayGames, forming) {
  const mlb = dayGames.filter((g) => g.sport === "mlb" && !g.skip);
  const soc = dayGames.filter((g) => g.sport !== "mlb" && !g.skip);
  // a still-forming slate with essentially no traded volume gets no tickets — just the games table
  if (forming && mlb.filter((g) => g.volNum >= 1000).length < 3) return [];
  const byWin = (a, b) => b.winPct - a.winPct;
  const byVol = (a, b) => b.volNum - a.volNum;
  // volume floors relax on a still-forming slate so it still gets a full set of tickets
  const F = forming
    ? { chalk: 500, bal: 500, same: 500, ls: 500, socMin: 300 }
    : { chalk: 15000, bal: 12000, same: 12000, ls: 10000, socMin: 8000 };
  const bestSoccer = soc.filter((g) => g.volNum >= F.socMin).sort(byWin)[0];
  const out = [];
  const prov = forming ? "Provisional — thin markets, prices firm up at the next refresh. " : "";
  const sizeCap = { 3: "≤1%", 4: "≤0.75%", 5: "≤0.4%", 6: "≤0.25%" };

  const seenSets = new Set();
  const mk = (name, tag, legs, feature) => {
    legs = uniqByMatch(legs);
    if (legs.length < 3) return;
    const sig = legs.map((l) => l.match).sort().join("§");
    if (seenSets.has(sig)) return; // don't emit a ticket identical to one already built
    seenSets.add(sig);
    const n = legs.length;
    const hasSoc = legs.some((l) => l.sport !== "mlb");
    out.push({
      name, tag, feature: !!feature,
      legs: legs.map(leg),
      notes: {
        inval: `${prov}Re-check every ask at lineup lock; skip if any leg's YES ask is ≥3¢ worse than shown${hasSoc ? "; the soccer leg loses on a draw" : ""}.`,
        size: `${sizeCap[n] || "≤0.5%"} of prediction-market bankroll. ${n} correlated favorites — treat as capped-risk.`,
        risk: `${n} favorites stacked; a favorite-heavy or favorite-light day moves them together. Lowest-win-% leg is ${legs[legs.length - 1].pick} at ${round1(legs[legs.length - 1].winPct)}%.`,
      },
    });
  };

  // Blue Chip 3
  let bc = mlb.filter((g) => g.volNum >= F.chalk).sort(byWin);
  if (bestSoccer && bestSoccer.winPct >= 68) mk("Blue Chip 3", "3 legs · cross-sport chalk", [...bc.slice(0, 2), bestSoccer], true);
  else mk("Blue Chip 3", "3 legs · MLB chalk", bc.slice(0, 3), true);

  // Balanced 4
  let bal = mlb.filter((g) => g.volNum >= F.bal && g.winPct >= 55 && g.winPct <= 72).sort(byWin);
  if (bestSoccer) mk("Balanced 4", "4 legs · cross-sport", [...bal.slice(0, 3), bestSoccer]);
  else mk("Balanced 4", "4 legs · cross-sport", bal.slice(0, 4));

  // MLB Same-Slate 4
  mk("MLB Same-Slate 4", "4 legs · single sport", mlb.filter((g) => g.volNum >= F.bal).sort(byWin).slice(0, 4));

  // Value 5 — highest volume, decent favorites
  mk("Value 5", "5 legs · high-volume MLB", mlb.filter((g) => g.winPct >= 53).sort(byVol).slice(0, 5));

  // Longshot 6
  const ls = mlb.filter((g) => g.volNum >= F.ls).sort(byWin).slice(0, 5);
  const sixth = bestSoccer || soc.sort(byWin)[0] || mlb.filter((g) => g.volNum >= F.ls).sort(byWin)[5];
  mk("Longshot 6", "6 legs · stretch ticket", sixth ? [...ls, sixth] : ls, true);

  return out;
}

// ---------- assemble ----------
function main(events) {
  const games = [];
  for (const [k, evs] of Object.entries(events)) {
    const sport = k === "mlb" ? "mlb" : k === "wnba" ? "wnba" : "soc";
    for (const ev of evs) { const g = gameFromEvent(ev, sport); if (g) games.push(g); }
  }

  const todayId = nyFmtDate.format(new Date());
  const byDate = new Map();
  for (const g of games) {
    if (g.date < todayId) continue;
    if (!byDate.has(g.date)) byDate.set(g.date, []);
    byDate.get(g.date).push(g);
  }

  const dateKeys = [...byDate.keys()].sort();
  const days = [];
  for (const dk of dateKeys) {
    const dg = byDate.get(dk).sort((a, b) => b.volNum - a.volNum);
    const nonSkip = dg.filter((g) => !g.skip);
    if (nonSkip.length < 3) continue;                 // not enough to build tickets
    if (days.length >= CAL_DAYS) break;
    const meta = dg[0];
    const deep = dg.filter((g) => g.sport === "mlb" && g.volNum >= 20000).length;
    const status = nonSkip.length >= 6 && deep >= 4 ? "full" : "forming";
    const mlbG = dg.filter((g) => g.sport === "mlb");
    const socG = dg.filter((g) => g.sport === "soc");
    const wnbaG = dg.filter((g) => g.sport === "wnba");

    const timing = [];
    if (mlbG.length) {
      const times = mlbG.map((g) => g.time);
      timing.push(`<b>MLB — ${mlbG.length} game${mlbG.length > 1 ? "s" : ""}.</b> First pitches ${times[times.length - 1]}–${times[0]} ET. <span class='now'>Re-pull any leg before you enter it.</span>`);
    }
    if (socG.length) {
      timing.push(`<b>Soccer — ${socG.length} game${socG.length > 1 ? "s" : ""}.</b> ` +
        socG.slice(0, 4).map((g) => `${g.away} vs ${g.home}${g.skip ? " (priced out)" : ` ~${g.time} ET`}`).join("; ") + ".");
    }
    if (!wnbaG.length) timing.push("<span class='now'>No WNBA.</span> Kalshi has no open per-game WNBA markets — the regular season is over.");

    const parlays = buildParlays(dg, status === "forming");

    const day = {
      id: dk, dow: meta.dow, d: meta.d, mon: meta.mon, label: meta.label, status,
      parlaySub: "Ordered short→long. Each leg shows its current Kalshi win % (mid) and ¢ entry (YES ask). Entry cost = product of asks; all-N-hit = product of no-vig win probabilities; EV is per $1 after spread.",
      swapNote: `<ul><li>Rebuilt from the latest pull — every leg is the top-win-% liquid favorite available in its game. Move arrows read “—”; the board is regenerated fresh each morning, not diffed.</li></ul>`,
      timing,
      parlays,
      games: {
        mlb: mlbG.map(stripInternal),
        soccer: socG.map(stripInternal),
        wnba: wnbaG.map(stripInternal),
      },
    };
    if (status === "forming") {
      day.formingNote = `<b>The ${meta.label} slate is still forming.</b> Only ${nonSkip.length} markets are listed and volume is light — prices are provisional and firm up overnight. The next ~8:00a ET refresh rebuilds this day with the full slate.`;
    }
    days.push(day);
  }

  // forward legs: soccer games after the last calendar day, best pick per game
  const lastCal = days.length ? days[days.length - 1].id : todayId;
  const forwardLegs = games
    .filter((g) => g.sport === "soc" && !g.skip && g.date > lastCal && g.winPct >= 55)
    .sort((a, b) => a.date.localeCompare(b.date) || b.winPct - a.winPct)
    .slice(0, 8)
    .map((g) => ({ match: `${g.away} vs ${g.home}`, pick: g.pick, entry: g.entry, winPct: g.winPct, vol: g.vol, date: g.label }));

  const nowEt = etParts(new Date().toISOString());
  const payload = {
    generatedLabel: `${nowEt.dow} ${nowEt.mon} ${nowEt.d} ${new Date().getUTCFullYear()}, ${nowEt.time} ET auto-refresh`,
    days,
    forwardLegs,
  };
  return payload;
}

function stripInternal(g) {
  const { volNum, favMid, date, dow, d, mon, label, ...rest } = g;
  return rest; // {sport,away,home,pick,entry,winPct,vol,tier,time,skip?}
}

function splice(html, jsonText) {
  const re = /(<script type="application\/json" id="board-data">)[\s\S]*?(<\/script>)/;
  if (!re.test(html)) throw new Error("board-data markers not found in HTML");
  // replacement as a function so $1/$2 sequences inside jsonText are not treated as backrefs
  return html.replace(re, (_m, open, close) => `${open}\n${jsonText}\n${close}`);
}

// ---------- run ----------
(async () => {
  const events = {};
  for (const [k, s] of Object.entries(SERIES)) {
    events[k] = await pull(s); // throws -> non-zero exit, publish skipped
    console.log(`  ${s}: ${events[k].length} events`);
  }
  const payload = main(events);
  if (!payload.days.length) throw new Error("no days with enough live markets — refusing to publish an empty board");

  const jsonText = JSON.stringify(payload, null, 2).replace(/<\//g, "<\\/");
  const src = fs.readFileSync(SRC, "utf8");
  const out = splice(src, jsonText);
  for (const t of TARGETS) fs.writeFileSync(t, out);

  console.log(`\nOK — ${payload.generatedLabel}  (wrote ${TARGETS.map((t) => path.basename(t)).join(", ")})`);
  console.log(`Days: ${payload.days.map((d) => `${d.label} (${d.status}, ${d.parlays.length} tickets, ${d.games.mlb.length}M/${d.games.soccer.length}S)`).join(" · ")}`);
  console.log(`Forward legs: ${payload.forwardLegs.length}`);
})().catch((e) => {
  console.error("REFRESH FAILED:", e.message);
  process.exit(1);
});
