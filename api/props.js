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

async function fetchSport(sport, key) {
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
  return rows;
}

function normalize(rows) {
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
    if (starts && new Date(starts).getTime() < Date.now() - 10 * 60 * 1000) continue;
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
    out.push({
      player,
      stat: row.market || statLabel(marketKey, row.market_display_name || row.description),
      line,
      team: row.team || row.player_team || "",
      matchup: String(matchup || ""),
      starts: String(starts || ""),
      book: row.bookmaker_title || row.bookmaker || "PrizePicks",
      pct,
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
  // An empty board (e.g. pulled between slates) only stays fresh ~10 min,
  // so the next posted props land quickly instead of riding the 11h cache.
  if (!hit.props.length) return age < 10 * 60 * 1000;
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

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=39600");
  const key = process.env.PARLAY_API_KEY || process.env.PARLEY_API_KEY || process.env.PRIZEPICKS_FEED_API_KEY || process.env.PRIZEPICKS_API_KEY || process.env.PARLAY_KEY;
  if (!key) { res.setHeader("Cache-Control", "no-store"); res.status(200).json({ ok: false, configured: false, props: [] }); return; }
  const sport = (req.query && req.query.sport) || "";
  if (SPORT_KEYS.indexOf(sport) === -1) { res.status(400).json({ ok: false, error: "unknown sport" }); return; }
  const hit = cache[sport];
  if (cacheFresh(hit)) { res.status(200).json({ ok: true, configured: true, cached: true, props: hit.props }); return; }
  // Budget brake: never let a runaway loop drain the account. Serve the
  // last board we have (even stale) rather than paying for another fetch.
  if (budgetLeft(sport) <= 0) {
    if (hit) { res.status(200).json({ ok: true, configured: true, cached: true, stale: true, props: hit.props }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, configured: true, error: "daily fetch budget reached for this sport", props: [] });
    return;
  }
  try {
    if (!inflight[sport]) {
      noteFetch(sport);
      inflight[sport] = fetchSport(sport, key).finally(() => { delete inflight[sport]; });
    }
    const rows = await inflight[sport];
    const props = normalize(rows);
    const wasPregame = !!(hit && Date.now() - hit.ts < DAY_TTL);
    cache[sport] = { ts: Date.now(), props, pregameRefreshed: wasPregame };
    res.status(200).json({ ok: true, configured: true, cached: false, props });
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err), props: hit ? hit.props : [] });
  }
};
