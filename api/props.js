// Prop Agent — PrizePicks props via Parlay API (parlay-api.com).
// GET /api/props?sport=basketball_nba
//   -> { ok:true, configured:true, props:[{player, stat, line, team, matchup, starts, book}] }
// The API key stays server-side in the PARLAY_API_KEY env var (Vercel ->
// Settings -> Environment Variables). Without it: { ok:false, configured:false }.
// Parlay API: GET https://parlay-api.com/v1/sports/{sport_key}/props
//   header X-API-Key, filter bookmakers=prizepicks. One call per sport,
//   3 credits per call.
// Refresh policy (free plan, per Brandon 2026-11-16): each sport's board is
// refreshed from Parlay at most TWICE A DAY (11h cache, lazily on the first
// board open after expiry — untouched sports cost zero credits). Exception:
// one extra refresh per cycle when a game on the cached board starts within
// 2 hours and the cache is over 30 min old, so late line moves and props
// added/dropped near tip-off ("major changes") still land.
// Credit management (Brandon 2026-11-16, after the free tier ran dry):
//   - The CDN edge cache is the SHARED cache for all users and instances
//     (1h fresh, then stale-while-revalidate up to ~11h), so repeat opens
//     almost never reach this function, let alone Parlay.
//   - Single-flight: concurrent requests for a sport share ONE Parlay fetch.
//   - A hard per-instance daily budget (MAX_FETCHES_PER_DAY per sport) is a
//     brake: when hit, the last cached board is served instead of fetching.
//   - Fetches are capped at 2 pages; failures are never cached anywhere.
// Shared budget (Brandon 2026-11-17, after the second overnight drain):
// when the Supabase props_cache table exists, it governs ALL paid fetches
// across every instance -- one fetch serves everyone, paid fetches happen
// only inside two daily windows (06:00 + 16:00 ET), and a hard global cap
// of 30 credits/day (~900/month) keeps the free tier alive. If the table
// is missing or Supabase is unreachable, behavior falls back to the
// per-instance rules above, unchanged.

const SPORT_KEYS = [
  "basketball_nba", "basketball_ncaab", "basketball_wncaab", "basketball_wnba",
  "americanfootball_nfl", "americanfootball_ncaaf",
  "icehockey_nhl", "baseball_mlb", "tennis_atp", "tennis_wta",
];

const STAT_LABELS = {
  player_points: "Points",
  player_rebounds: "Rebounds",
  player_assists: "Assists",
  player_points_rebounds_assists: "Pts + Reb + Ast",
  player_points_rebounds: "Pts + Reb",
  player_points_assists: "Pts + Ast",
  player_rebounds_assists: "Reb + Ast",
  player_threes: "3-Pointers Made",
  player_blocks: "Blocks",
  player_steals: "Steals",
  player_blocks_steals: "Blocks + Steals",
  player_turnovers: "Turnovers",
  player_pass_yds: "Passing Yards",
  player_passing_yards: "Passing Yards",
  player_pass_tds: "Passing TDs",
  player_rush_yds: "Rushing Yards",
  player_rushing_yards: "Rushing Yards",
  player_rush_tds: "Rushing TDs",
  player_reception_yds: "Receiving Yards",
  player_receiving_yards: "Receiving Yards",
  player_receptions: "Receptions",
  player_reception_tds: "Receiving TDs",
  player_goals: "Goals",
  player_shots_on_goal: "Shots on Goal",
  player_saves: "Saves",
  player_hits: "Hits",
  player_total_bases: "Total Bases",
  player_home_runs: "Home Runs",
  player_rbis: "RBIs",
  player_strikeouts: "Strikeouts",
  player_aces: "Aces",
  player_double_faults: "Double Faults",
};

function statLabel(marketKey, fallback) {
  if (marketKey && STAT_LABELS[marketKey]) return STAT_LABELS[marketKey];
  if (marketKey) {
    return marketKey.replace(/^player_/, "").replace(/_/g, " ")
      .replace(/\byds\b/g, "Yards").replace(/\btds\b/g, "TDs")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return fallback || "Prop";
}

const seenMap = {}; // sport -> {rowKey: firstSeenMs} — spots props posted mid-game
function rowKey(p) { return p.player + "|" + p.stat + "|" + p.line + "|" + (p.starts || ""); }
function stampSeen(sport, props) {
  const m = seenMap[sport] = seenMap[sport] || {};
  const now = Date.now();
  for (const p of props) { const k = rowKey(p); if (m[k] == null) m[k] = now; p.seen = m[k]; }
  const keys = Object.keys(m);
  if (keys.length > 4000) { const cut = now - 24 * 60 * 60 * 1000; for (const k of keys) if (m[k] < cut) delete m[k]; }
}
const prevFetch = {}; // sport -> {ts, keys:Set} — the previous fetch's full row keys.
                      // A past-start row only counts as a break prop when a fetch
                      // made AFTER its game started did not list it (proof it was
                      // posted mid-game). A cold instance has no proof -> shows none.
const brkLog = {}; // sport -> {day, count} break-check allowance
function brkBudgetOk(sport) {
  const day = new Date().toISOString().slice(0, 10);
  const log = brkLog[sport];
  if (!log || log.day !== day) { brkLog[sport] = { day, count: 0 }; return true; }
  return log.count < 8; // at most 8 paid break checks per sport per day
}
function noteBrk(sport) {
  const day = new Date().toISOString().slice(0, 10);
  if (!brkLog[sport] || brkLog[sport].day !== day) brkLog[sport] = { day, count: 0 };
  brkLog[sport].count++;
}

const cache = {}; // sport -> {ts, props}
const inflight = {}; // sport -> Promise (single-flight dedupe)
const fetchLog = {}; // sport -> {day, count} daily-budget brake
const MAX_FETCHES_PER_DAY = 6;

function budgetLeft(sport) {
  const day = new Date().toISOString().slice(0, 10);
  const log = fetchLog[sport];
  if (!log || log.day !== day) { fetchLog[sport] = { day, count: 0 }; return MAX_FETCHES_PER_DAY; }
  return MAX_FETCHES_PER_DAY - log.count;
}
function noteFetch(sport) {
  const day = new Date().toISOString().slice(0, 10);
  if (!fetchLog[sport] || fetchLog[sport].day !== day) fetchLog[sport] = { day, count: 0 };
  fetchLog[sport].count++;
}

// ---- Shared props cache + global credit budget (Brandon 2026-11-17) ----
// The overnight drain happened because every Vercel instance kept its own
// cache and its own budget: the account-level total was unbounded. The fix
// moves the board cache and the fetch accounting into ONE Supabase table
// (props_cache) shared by every instance:
//   - A fresh shared board is served to everyone; no Parlay fetch at all.
//   - Paid fetches happen only in two windows per sport per day (06:00 and
//     16:00 ET), claimed atomically so exactly ONE instance fetches.
//   - Credits are reserved at claim time and the day total across ALL
//     sports is hard-capped at DAILY_CREDIT_BUDGET, so the free tier
//     (1,000/month) cannot be drained: worst case ~30 credits/day.
//   - An empty Parlay board is retried at the next window, never on a
//     30-minute loop; the free ESPN fallback covers boards meanwhile.
// Every helper fails OPEN (returns null/undefined) when the table does not
// exist or Supabase hiccups, and the handler then uses the legacy
// per-instance behavior -- so this code is safe to run before the table
// is created.
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DAILY_CREDIT_BUDGET = 30;
// Brandon: one-day lifts -- on 2026-11-17 and 2026-11-18 (ET) the cap is 50
// so the day's next pull can complete; never above 50 that day, and the
// normal 30/day cap resumes by itself the next ET day.
function dailyCap() { return (etToday() === "2026-11-17" || etToday() === "2026-11-18") ? 50 : DAILY_CREDIT_BUDGET; }
const SLOT_HOURS_ET = [6, 16];
function etSlot() {
  const h = etHour();
  if (h >= SLOT_HOURS_ET[1]) return 2;
  if (h >= SLOT_HOURS_ET[0]) return 1;
  return 0;
}
async function sbReq(path, opts) {
  if (!SB_URL || !SB_SVC) return null;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(SB_URL + "/rest/v1/" + path, Object.assign({}, opts || {}, {
      signal: ctl.signal,
      headers: Object.assign({ apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" }, (opts && opts.headers) || {}),
    }));
    clearTimeout(to);
    if (!r.ok) return null;
    const txt = await r.text();
    try { return JSON.parse(txt); } catch (e) { return null; }
  } catch (e) { return null; }
}
// Returns the row, null when the sport has no row yet, and undefined when
// the shared store is unavailable (the caller then uses legacy behavior).
async function sbCacheRow(sport) {
  const rows = await sbReq("props_cache?sport=eq." + encodeURIComponent(sport) + "&select=sport,props,fetched_at,credits_today,count_day,last_slot");
  if (rows === null) return undefined;
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function sbCacheAll() {
  const rows = await sbReq("props_cache?select=sport,credits_today,count_day");
  return Array.isArray(rows) ? rows : null;
}
function sbFresh(row) {
  if (!row) return false;
  const age = Date.now() - new Date(row.fetched_at).getTime();
  const props = Array.isArray(row.props) ? row.props : [];
  if (!props.length) return age < 30 * 60 * 1000;
  if (age > PREGAME_TTL) {
    const anyFuture = props.some((p) => p.starts && new Date(p.starts).getTime() > Date.now() - 10 * 60 * 1000);
    if (!anyFuture) return age < 30 * 60 * 1000;
  }
  return age < DAY_TTL;
}
// Atomically claim this sport's fetch window. The claim condition matches
// the row's previous (count_day, last_slot) exactly, so when two instances
// race, only one's PATCH lands. Reserves the worst case (6 credits).
async function sbClaim(sport, row, slot) {
  const today = etToday();
  const prevDay = row ? String(row.count_day || "") : "";
  const prevSlot = row ? (row.last_slot | 0) : 0;
  const prevCredits = row && prevDay === today ? (row.credits_today | 0) : 0;
  const body = { fetched_at: new Date().toISOString(), last_slot: slot, count_day: today, credits_today: prevCredits + 6 };
  if (row) {
    const out = await sbReq("props_cache?sport=eq." + encodeURIComponent(sport) + "&last_slot=eq." + prevSlot + "&count_day=eq." + encodeURIComponent(prevDay), {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(body),
    });
    return Array.isArray(out) && out.length ? { reserved: 6 } : null;
  }
  const ins = await sbReq("props_cache", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify(Object.assign({ sport, props: [] }, body)),
  });
  return Array.isArray(ins) && ins.length ? { reserved: 6 } : null;
}
async function sbCachePut(sport, props, actualCredits, reserved) {
  const row = await sbCacheRow(sport);
  const body = { props };
  if (row && row !== undefined) {
    const today = etToday();
    const cur = String(row.count_day || "") === today ? (row.credits_today | 0) : 0;
    body.credits_today = Math.max(0, cur - Math.max(0, (reserved | 0) - (actualCredits | 0)));
    body.count_day = today;
  }
  await sbReq("props_cache?sport=eq." + encodeURIComponent(sport), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });
}
async function sbRefund(sport, reserved) {
  const row = await sbCacheRow(sport);
  if (!row || row === undefined) return;
  const today = etToday();
  if (String(row.count_day || "") !== today) return;
  const cur = Math.max(0, (row.credits_today | 0) - (reserved | 0));
  await sbReq("props_cache?sport=eq." + encodeURIComponent(sport), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ credits_today: cur }) });
}
// No paid fetch is allowed: serve the shared board (even stale), else the
// in-memory board, else the free ESPN fallback, else an empty board.
async function serveStaleOrFallback(res, sport, hit, sbRow) {
  if (sbRow && Array.isArray(sbRow.props) && sbRow.props.length) {
    cache[sport] = { ts: new Date(sbRow.fetched_at).getTime(), props: sbRow.props, pregameRefreshed: true };
    res.status(200).json({ ok: true, configured: true, cached: true, shared: true, stale: true, props: sbRow.props });
    return;
  }
  if (hit && hit.props.length) {
    res.status(200).json({ ok: true, configured: true, cached: true, stale: true, props: hit.props });
    return;
  }
  const fb = await espnFallback(sport, "pre").catch(() => []);
  if (fb.length) {
    stampSeen(sport, fb);
    cache[sport] = { ts: Date.now(), props: fb, pregameRefreshed: false, espnFallback: true };
    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
    res.status(200).json({ ok: true, configured: true, cached: false, fallback: "espn", props: fb });
    return;
  }
  res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
  res.status(200).json({ ok: true, configured: true, cached: true, shared: !!sbRow, props: sbRow && Array.isArray(sbRow.props) ? sbRow.props : (hit ? hit.props : []) });
}

// Schedule gate (Brandon 2026-11-16): before paying for a Parlay refresh,
// check the sport's ESPN schedule (free). If the sport has NO games today
// that are upcoming or in progress, don't refresh its props at all until
// the evening (18:00 ET), when tomorrow's slate starts posting — and even
// then only once that day. The gate fails OPEN: any ESPN error, or a
// schedule shape we don't recognize, means "allow the fetch".
const ESPN_PATHS = {
  basketball_nba: "basketball/nba",
  basketball_ncaab: "basketball/mens-college-basketball",
  basketball_wncaab: "basketball/womens-college-basketball",
  basketball_wnba: "basketball/wnba",
  americanfootball_nfl: "football/nfl",
  americanfootball_ncaaf: "football/college-football",
  icehockey_nhl: "hockey/nhl",
  baseball_mlb: "baseball/mlb",
  tennis_atp: "tennis/atp",
  tennis_wta: "tennis/wta",
};
const schedCache = {}; // sport -> {ts, games}
const SCHED_TTL = 60 * 60 * 1000;

async function gamesToday(sport) {
  const hit = schedCache[sport];
  if (hit && Date.now() - hit.ts < SCHED_TTL) return hit.games;
  let games = true; // fail open
  try {
    const path = ESPN_PATHS[sport];
    if (path) {
      const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/" + path + "/scoreboard?dates=" + etToday().replace(/-/g, ""));
      if (r.ok) {
        const data = await r.json();
        const evs = Array.isArray(data.events) ? data.events : [];
        if (evs.length) {
          const anyState = evs.some((e) => e && e.status && e.status.type && e.status.type.state);
          games = !anyState || evs.some((e) => {
            const st = e && e.status && e.status.type && e.status.type.state;
            return st === "pre" || st === "in";
          });
        } else {
          games = false; // a real, empty schedule: no games today
        }
      }
    }
  } catch (e) { games = true; }
  schedCache[sport] = { ts: Date.now(), games };
  return games;
}

function etHour() {
  try {
    const h = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()), 10);
    return isFinite(h) ? h : 12;
  } catch (e) { return 12; }
}
function etToday() {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}

// Key failover (Brandon 2026-11-17): several Parlay keys may be
// configured -- PARLAY_API_KEY_2 / PARLEY_API_KEY_2 are the backup slots.
// A fetch tries the keys in order; a key that answers CREDIT_LIMIT_REACHED
// (or any 403) is marked dead for the rest of the ET day and skipped, so a
// drained key costs at most one wasted (free) 403 call per instance per
// day and the backup key takes over automatically. Failover changes WHO
// pays, never how much: the shared daily credit budget still governs how
// often fetches happen at all.
const deadKeys = {}; // last-6-chars of key -> ET day it ran dry
function keyAlive(k) { return deadKeys[String(k).slice(-6)] !== etToday(); }
async function fetchSport(sport, keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  let lastErr = null;
  for (const k of list) {
    if (!keyAlive(k)) continue;
    try { return await fetchSportWithKey(sport, k); }
    catch (e) {
      lastErr = e;
      if (/CREDIT_LIMIT_REACHED|http 403/i.test(String((e && e.message) || e))) { deadKeys[String(k).slice(-6)] = etToday(); continue; }
      throw e;
    }
  }
  throw lastErr || new Error("no parlay key available");
}
async function fetchSportWithKey(sport, key) {
  const base = "https://parlay-api.com/v1/sports/" + encodeURIComponent(sport) + "/props";
  let offset = 0, rows = [], guard = 0;
  while (guard < 2) {
    guard++;
    const url = base + "?bookmakers=prizepicks&limit=200&offset=" + offset;
    const r = await fetch(url, { headers: { "X-API-Key": key, "Accept": "application/json" } });
    if (!r.ok) { const body = await r.text().catch(() => ""); throw new Error("parlay http " + r.status + ": " + String(body).slice(0, 220)); }
    const data = await r.json();
    const batch = Array.isArray(data) ? data : (data.data || data.props || data.results || []);
    rows = rows.concat(batch);
    const hasMore = r.headers.get("x-result-has-more") === "true";
    const next = parseInt(r.headers.get("x-next-offset") || "", 10);
    if (!hasMore || !isFinite(next) || batch.length === 0) break;
    offset = next;
  }
  rows.pagesUsed = guard;
  return rows;
}

function normalize(rows, keepStarted) {
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const player = row.player_name || row.player || row.athlete_name || row.name || "";
    const marketKey = row.market_key || row.market || row.market_name || "";
    const lineRaw = row.line != null ? row.line : (row.point != null ? row.point : (row.projection != null ? row.projection : row.value));
    let line = typeof lineRaw === "number" ? lineRaw : parseFloat(lineRaw);
    if (isFinite(line)) line = Math.round(line * 100) / 100;
    if (!player || !isFinite(line)) continue;
    const home = row.home_team || "", away = row.away_team || "";
    const matchup = row.event_name || row.matchup || (home && away ? away + " @ " + home : (row.event || ""));
    const starts = row.commence_time || row.start_time || row.event_time || row.game_time || "";
    // Only pre-game props: if a start time is present and already passed, skip.
    // (Break checks pass keepStarted and filter to genuinely-new rows themselves.)
    if (!keepStarted && starts && new Date(starts).getTime() < Date.now() - 10 * 60 * 1000) continue;
    // Best-percentage support: pass through an implied probability when the
    // feed provides one (or derive it from American odds/prices when present).
    let pct = null;
    const probRaw = row.implied_probability != null ? row.implied_probability
      : (row.impliedProbability != null ? row.impliedProbability
      : (row.probability != null ? row.probability
      : (row.win_probability != null ? row.win_probability
      : (row.confidence != null ? row.confidence : null))));
    if (probRaw != null) {
      const pv = typeof probRaw === "number" ? probRaw : parseFloat(probRaw);
      if (isFinite(pv) && pv > 0) pct = Math.round((pv <= 1 ? pv * 100 : pv) * 10) / 10;
    }
    if (pct == null) {
      const priceRaw = row.over_price != null ? row.over_price
        : (row.over_odds != null ? row.over_odds
        : (row.price != null ? row.price
        : (row.odds != null ? row.odds : null)));
      const av = typeof priceRaw === "number" ? priceRaw : parseFloat(priceRaw);
      if (isFinite(av) && av !== 0) pct = Math.round((av < 0 ? (-av) / ((-av) + 100) : 100 / (av + 100)) * 1000) / 10;
    }
    const halfSrc = [row.market, row.market_display_name, row.description, marketKey].join(" ");
    const half = /1st\s*half|first\s*half|1st-half|\b1h\b/i.test(halfSrc) ? 1 : 0;
    out.push({
      player,
      stat: row.market || statLabel(marketKey, row.market_display_name || row.description),
      line,
      team: row.team || row.player_team || "",
      matchup: String(matchup || ""),
      starts: String(starts || ""),
      book: row.bookmaker_title || row.bookmaker || "PrizePicks",
      pct,
      half,
    });
  }
  return out;
}

const DAY_TTL = 11 * 60 * 60 * 1000;      // twice-a-day refresh window
const PREGAME_TTL = 30 * 60 * 1000;       // near tip-off, a fresher board matters
const PREGAME_WINDOW = 2 * 60 * 60 * 1000;

function cacheFresh(hit) {
  if (!hit) return false;
  const age = Date.now() - hit.ts;
  // An empty board stays fresh 30 min: the fewest refreshes that still
  // catch newly posted props reasonably soon (Brandon 2026-11-16).
  if (!hit.props.length) return age < 30 * 60 * 1000;
  // ESPN fallback boards also stay fresh only 30 min, so the moment Parlay
  // posts the real PrizePicks props they take the board back.
  if (hit.espnFallback) return age < 30 * 60 * 1000;
  // Most-recent rule: if every game on the cached board has already started,
  // the board is yesterday's news — a newer slate may be posted, so refresh
  // (at most once per 30 min) instead of riding the 11h cache into empty.
  if (age > PREGAME_TTL && hit.props.length) {
    const anyFuture = hit.props.some((p) => p.starts && new Date(p.starts).getTime() > Date.now() - 10 * 60 * 1000);
    if (!anyFuture) return false;
  }
  if (age < DAY_TTL) {
    if (hit.pregameRefreshed) return true;
    // Major-changes exception: a game on this board starts within 2h and the
    // cached lines are over 30 min old -> allow ONE early refresh this cycle.
    let earliest = Infinity;
    for (const p of hit.props) {
      const t = p.starts ? new Date(p.starts).getTime() : NaN;
      if (isFinite(t) && t > Date.now() - 10 * 60 * 1000 && t < earliest) earliest = t;
    }
    if (earliest !== Infinity && earliest - Date.now() < PREGAME_WINDOW && age > PREGAME_TTL) return false;
    return true;
  }
  return false;
}


// ---- ESPN fallback (Brandon 2026-11-16): Parlay stays the primary source.
// When a Parlay pull comes back EMPTY for a sport with games on, fill the
// board from ESPN's odds feed (DraftKings prop bets via the ESPN core API)
// for UPCOMING games, so the board is never blank while real lines exist.
// The break lane uses the same feed for games sitting at a break when
// PrizePicks has not posted 2nd-half props. Fallback rows carry
// book:"DraftKings" so the app labels them honestly ("DraftKings - via ESPN").
const CORE = "https://sports.core.api.espn.com/v2/sports/";
const SITE = "https://site.api.espn.com/apis/site/v2/sports/";
const rosterCache = {}; // path|teamId -> {ts, map}
const sbEvCache = {}; // sport -> {ts, events}
const ESPN_STAT = {
  "3-Point Field Goals": "3-Pointers Made",
  "Passing Touchdowns": "Passing TDs",
  "Rushing Touchdowns": "Rushing TDs",
  "Receiving Touchdowns": "Receiving TDs",
  "Points, Rebounds, and Assists": "Pts + Reb + Ast",
  "Points and Rebounds": "Pts + Reb",
  "Points and Assists": "Pts + Ast",
  "Assists and Rebounds": "Reb + Ast",
  "Points + Rebounds + Assists": "Pts + Reb + Ast",
  "Points + Rebounds": "Pts + Reb",
  "Points + Assists": "Pts + Ast",
  "Rebounds + Assists": "Reb + Ast",
};
function espnStatLabel(name) {
  const raw = String(name || "");
  const s = raw.replace(/^Total /, "");
  return ESPN_STAT[s] || ESPN_STAT[raw] || s || "Prop";
}
function amToProb(a) {
  const v = parseFloat(a);
  if (!isFinite(v) || v === 0) return null;
  return v < 0 ? (-v) / ((-v) + 100) : 100 / (v + 100);
}
async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("espn http " + r.status);
  return r.json();
}
async function scoreboardEvents(sport) {
  const hit = sbEvCache[sport];
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.events;
  let events = [];
  try {
    const path = ESPN_PATHS[sport];
    if (path) {
      const j = await jget(SITE + path + "/scoreboard?dates=" + etToday().replace(/-/g, "") + "&limit=100");
      events = Array.isArray(j.events) ? j.events : [];
    }
  } catch (e) {}
  sbEvCache[sport] = { ts: Date.now(), events };
  return events;
}
async function rosterMap(path, teamId) {
  const k = path + "|" + teamId;
  const hit = rosterCache[k];
  if (hit && Date.now() - hit.ts < 6 * 60 * 60 * 1000) return hit.map;
  const map = {};
  try {
    const j = await jget(SITE + path + "/teams/" + teamId + "/roster");
    const flat = [];
    for (const a of j.athletes || []) {
      if (a && a.displayName) flat.push(a);
      else if (a && Array.isArray(a.items)) for (const b of a.items) flat.push(b);
    }
    for (const a of flat) if (a && a.id && a.displayName) map[String(a.id)] = a.displayName;
  } catch (e) {}
  rosterCache[k] = { ts: Date.now(), map };
  return map;
}
async function espnGameProps(sport, ev) {
  const path = ESPN_PATHS[sport];
  if (!path || !ev) return [];
  const corePath = path.replace("/", "/leagues/");
  const comp = ev.competitions && ev.competitions[0];
  if (!comp) return [];
  const teams = (comp.competitors || []).map((c) => ({
    id: c.team && c.team.id,
    name: (c.team && (c.team.displayName || c.team.shortDisplayName)) || "",
    homeAway: c.homeAway,
  }));
  const athletes = {};
  for (const t of teams) {
    if (!t.id) continue;
    const m = await rosterMap(path, t.id);
    for (const id in m) athletes[id] = { name: m[id], team: t.name };
  }
  if (!Object.keys(athletes).length) return [];
  let provId = null;
  try {
    const oj = await jget(CORE + corePath + "/events/" + ev.id + "/competitions/" + ev.id + "/odds");
    const it = (oj.items || [])[0];
    if (it && it.provider && it.provider.id) provId = it.provider.id;
  } catch (e) {}
  if (!provId) return [];
  const groups = {}; // athleteId|typeName -> {lineStr: [americanPrices]}
  let page = 1, count = Infinity;
  while (page <= 6 && (page - 1) * 100 < count) {
    let pj = null;
    try { pj = await jget(CORE + corePath + "/events/" + ev.id + "/competitions/" + ev.id + "/odds/" + provId + "/propBets?limit=100&page=" + page); } catch (e) { break; }
    count = pj.count || 0;
    const items = pj.items || [];
    if (!items.length) break;
    for (const it of items) {
      const tval = it.current && it.current.target && it.current.target.value;
      if (typeof tval !== "number" || !isFinite(tval)) continue;
      const tname = (it.type && it.type.name) || "";
      if (!tname || /milestone/i.test(tname)) continue;
      const aref = (it.athlete && it.athlete.$ref) || "";
      const aid = (aref.split("/athletes/")[1] || "").split("?")[0];
      if (!aid || !athletes[aid]) continue;
      const g = groups[aid + "|" + tname] = groups[aid + "|" + tname] || {};
      (g[String(tval)] = g[String(tval)] || []).push(it.odds && it.odds.american && it.odds.american.value);
    }
    page++;
  }
  const away = teams.find((t) => t.homeAway === "away"), home = teams.find((t) => t.homeAway === "home");
  const matchup = away && home ? away.name + " @ " + home.name : (ev.name || "");
  const rows = [];
  for (const gk in groups) {
    const parts = gk.split("|");
    const aid = parts[0], tname = parts.slice(1).join("|");
    let best = null;
    for (const lk in groups[gk]) {
      const prices = groups[gk][lk].map(amToProb).filter((v) => v != null);
      let bal = 0.5, pct = 50;
      if (prices.length >= 2) { const s = prices[0] + prices[1]; pct = Math.round(1000 * prices[0] / s) / 10; bal = Math.abs(prices[0] / s - 0.5); }
      else if (prices.length === 1) { pct = Math.round(prices[0] * 1000) / 10; bal = Math.abs(prices[0] - 0.5); }
      if (!best || bal < best.bal) best = { line: parseFloat(lk), pct, bal };
    }
    if (!best) continue;
    rows.push({
      player: athletes[aid].name,
      stat: espnStatLabel(tname),
      line: Math.round(best.line * 100) / 100,
      team: athletes[aid].team,
      matchup: String(matchup || ""),
      starts: String(ev.date || ""),
      book: "DraftKings",
      pct: best.pct,
    });
  }
  return rows;
}
async function espnFallback(sport, mode) {
  const evs = await scoreboardEvents(sport);
  const now = Date.now();
  let targets = [];
  if (mode === "break") {
    targets = evs.filter((ev) => {
      const t = ev.status && ev.status.type;
      if (!t || t.state !== "in") return false;
      const s = (t.detail || "") + " " + (t.shortDetail || "");
      return /HALFTIME|END_PERIOD|INTERMISSION/i.test(t.name || "") || /halftime|intermission|end of (1st|2nd|3rd|4th)/i.test(s);
    }).slice(0, 3);
  } else {
    targets = evs.filter((ev) => {
      const t = ev.status && ev.status.type;
      return t && t.state === "pre" && new Date(ev.date || 0).getTime() > now - 10 * 60 * 1000;
    }).slice(0, 4);
  }
  let out = [];
  for (const ev of targets) {
    try { out = out.concat(await espnGameProps(sport, ev)); } catch (e) {}
  }
  return out.slice(0, 400);
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=39600");
  const keys = [process.env.PARLAY_API_KEY, process.env.PARLEY_API_KEY, process.env.PARLAY_API_KEY_2, process.env.PARLEY_API_KEY_2, process.env.PRIZEPICKS_FEED_API_KEY, process.env.PRIZEPICKS_API_KEY, process.env.PARLAY_KEY].filter((v, i, a) => !!v && a.indexOf(v) === i);
  if (!keys.length) { res.setHeader("Cache-Control", "no-store"); res.status(200).json({ ok: false, configured: false, props: [] }); return; }
  // Read-only daily credit tally (Brandon 2026-11-17: watch today's
  // progress, notify if credits go up). Numbers only -- no props, no keys.
  if (req.query && req.query.tally === "1") {
    res.setHeader("Cache-Control", "no-store");
    const rowsT = await sbCacheAll();
    if (!rowsT) { res.status(200).json({ ok: false, tally: false }); return; }
    const todayT = etToday();
    let totalT = 0; const sportsT = {};
    rowsT.forEach((r) => { const c = String(r.count_day || "") === todayT ? (r.credits_today | 0) : 0; sportsT[r.sport] = c; totalT += c; });
    res.status(200).json({ ok: true, tally: true, day: todayT, cap: dailyCap(), totalToday: totalT, sports: sportsT });
    return;
  }
  const sport = (req.query && req.query.sport) || "";
  if (SPORT_KEYS.indexOf(sport) === -1) { res.status(400).json({ ok: false, error: "unknown sport" }); return; }
  const hit = cache[sport];
  // Break lane (Brandon 2026-11-16): while a game in this sport sits at
  // halftime / intermission / a quarter break, the client may ask for a
  // fresh pull (&brk=1) to catch 2nd-half / 4th-quarter props the moment
  // PrizePicks posts them. Guardrails keep it minimal: the in-instance
  // cache answers for 3 minutes, the response rides a 2-minute edge
  // cache shared by every user, and paid break pulls are capped per day.
  if (req.query && req.query.brk === "1") {
    if (hit && Date.now() - hit.ts < 3 * 60 * 1000) {
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60");
      res.status(200).json({ ok: true, configured: true, cached: true, brk: true, props: hit.props });
      return;
    }
    if (!(await gamesToday(sport)) || !brkBudgetOk(sport)) {
      if (hit) { res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60"); res.status(200).json({ ok: true, configured: true, cached: true, brk: true, props: hit.props }); return; }
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60");
      res.status(200).json({ ok: true, configured: true, brk: true, props: [] });
      return;
    }
    try {
      if (!inflight[sport]) {
        noteBrk(sport); noteFetch(sport);
        inflight[sport] = fetchSport(sport, keys).finally(() => { delete inflight[sport]; });
      }
      const rows = await inflight[sport];
      const prev = prevFetch[sport];
      const fullProps = normalize(rows, true);
      const fullKeys = new Set(fullProps.map(rowKey));
      // Rows whose start already passed survive ONLY with proof they were
      // posted mid-game: a fetch made after their game started (and within
      // this evening) did not list them. Everything else is dropped,
      // exactly like the normal lane.
      let props = fullProps.filter((p) => {
        const t = p.starts ? new Date(p.starts).getTime() : NaN;
        if (!isFinite(t) || t > Date.now() - 10 * 60 * 1000) return true;
        if (t < Date.now() - 4 * 60 * 60 * 1000) return false;
        return !!(prev && prev.ts > t + 10 * 60 * 1000 && prev.ts < Date.now() + 1000 && !prev.keys.has(rowKey(p)));
      });
      // ESPN break fallback: no genuinely-new PrizePicks break props ->
      // pull live lines from ESPN for the games sitting at a break.
      const hasBrk = props.some((p) => { const t = p.starts ? new Date(p.starts).getTime() : NaN; return isFinite(t) && t <= Date.now() - 10 * 60 * 1000; });
      if (!hasBrk) {
        const fb = await espnFallback(sport, "break").catch(() => []);
        if (fb.length) props = props.concat(fb);
      }
      prevFetch[sport] = { ts: Date.now(), keys: fullKeys };
      stampSeen(sport, props);
      cache[sport] = { ts: Date.now(), props, pregameRefreshed: true };
      res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=120");
      res.status(200).json({ ok: true, configured: true, cached: false, brk: true, props });
    } catch (err) {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ ok: false, configured: true, brk: true, error: String((err && err.message) || err), props: hit ? hit.props : [] });
    }
    return;
  }
  if (cacheFresh(hit)) { if (!hit.props.length) res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300"); res.status(200).json({ ok: true, configured: true, cached: true, props: hit.props }); return; }
  // Schedule gate (Brandon 2026-11-17, ALL sports): gamesToday() is
  // state-aware -- it counts only games still upcoming ("pre") or live
  // ("in") today. If there are none, NO Parlay pull happens for this
  // sport, all day: the board is served from cache (free), and a pull
  // can only ever fire when a game is actually coming up or on. The
  // old one-evening-look-ahead exception is removed for every sport.
  const gateOk = await gamesToday(sport);
  // Tennis exception (Brandon 2026-11-18): ESPN's tennis scoreboard only
  // carries top-tour tournaments and marks them "post" while Challenger /
  // ITF matches that PrizePicks lists are still being played, so an ESPN
  // "no games" answer cannot be trusted for tennis. Tennis falls through
  // to the shared-cache path below, which still pays for at most ONE
  // claimed fetch per window under the global cap -- if Parlay has no
  // tennis props, the empty board is cached and costs nothing more.
  const tennisBlind = !gateOk && (sport === "tennis_atp" || sport === "tennis_wta");
  if (!gateOk && !tennisBlind) {
    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=900");
    res.status(200).json({ ok: true, configured: true, noGames: true, props: hit ? hit.props : [] });
    return;
  }
  // Shared cache + global budget: when the Supabase props_cache table is
  // reachable it governs paid fetches (see the sb* helpers). sbRow ===
  // undefined means the shared store is unavailable -- fall through to the
  // legacy per-instance behavior below, unchanged.
  const sbRow = await sbCacheRow(sport);
  let sbClaimed = null;
  if (sbRow !== undefined) {
    if (sbRow && sbFresh(sbRow)) {
      const sp = Array.isArray(sbRow.props) ? sbRow.props : [];
      cache[sport] = { ts: new Date(sbRow.fetched_at).getTime(), props: sp, pregameRefreshed: true };
      if (!sp.length) res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
      res.status(200).json({ ok: true, configured: true, cached: true, shared: true, props: sp });
      return;
    }
    const slot = etSlot();
    const slotUsed = !!(sbRow && slot > 0 && String(sbRow.count_day || "") === etToday() && (sbRow.last_slot | 0) >= slot);
    if (slot === 0 || slotUsed) { await serveStaleOrFallback(res, sport, hit, sbRow); return; }
    const allRows = await sbCacheAll();
    const usedToday = (allRows || []).reduce((sum, r) => sum + (String(r.count_day || "") === etToday() ? (r.credits_today | 0) : 0), 0);
    if (usedToday + 6 > dailyCap()) { await serveStaleOrFallback(res, sport, hit, sbRow); return; }
    sbClaimed = await sbClaim(sport, sbRow, slot);
    if (!sbClaimed) {
      const freshRow = await sbCacheRow(sport);
      await serveStaleOrFallback(res, sport, hit, freshRow === undefined ? sbRow : freshRow);
      return;
    }
  }
  if (tennisBlind && sbRow === undefined) {
    // Shared store unreachable: without it we cannot prove a fetch would
    // be the window's one allowed pull, so serve cache instead of paying.
    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=900");
    res.status(200).json({ ok: true, configured: true, noGames: true, props: hit ? hit.props : [] });
    return;
  }
  // Budget brake: never let a runaway loop drain the account. Serve the
  // last board we have (even stale) rather than paying for another fetch.
  // (Skipped when the shared claim already authorized this fetch.)
  if (!sbClaimed && budgetLeft(sport) <= 0) {
    if (hit) { if (!hit.props.length) res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300"); res.status(200).json({ ok: true, configured: true, cached: true, stale: true, props: hit.props }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, configured: true, error: "daily fetch budget reached for this sport", props: [] });
    return;
  }
  try {
    if (!inflight[sport]) {
      noteFetch(sport);
      inflight[sport] = fetchSport(sport, keys).finally(() => { delete inflight[sport]; });
    }
    const rows = await inflight[sport];
    let props = normalize(rows);
    const parlayProps = props;
    let espnFb = false;
    if (!props.length) {
      const fb = await espnFallback(sport, "pre").catch(() => []);
      if (fb.length) { props = fb; espnFb = true; }
    }
    prevFetch[sport] = { ts: Date.now(), keys: new Set(normalize(rows, true).map(rowKey)) };
    stampSeen(sport, props);
    const wasPregame = !!(hit && Date.now() - hit.ts < DAY_TTL);
    cache[sport] = { ts: Date.now(), props, pregameRefreshed: wasPregame, espnFallback: espnFb };
    if (sbClaimed) { await sbCachePut(sport, parlayProps, ((rows.pagesUsed || 1) * 3), sbClaimed.reserved); sbClaimed = null; }
    if (!props.length || espnFb) res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300"); res.status(200).json({ ok: true, configured: true, cached: false, fallback: espnFb ? "espn" : undefined, props });
  } catch (err) {
    if (sbClaimed) { await sbRefund(sport, sbClaimed.reserved); sbClaimed = null; }
    if (!hit || !hit.props.length) {
      const fb = await espnFallback(sport, "pre").catch(() => []);
      if (fb.length) {
        stampSeen(sport, fb);
        cache[sport] = { ts: Date.now(), props: fb, pregameRefreshed: false, espnFallback: true };
        res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
        res.status(200).json({ ok: true, configured: true, cached: false, fallback: "espn", props: fb });
        return;
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err), props: hit ? hit.props : [] });
  }
};
