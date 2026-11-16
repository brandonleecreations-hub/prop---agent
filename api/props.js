// Prop Agent — PrizePicks props via Parlay API (parlay-api.com).
// GET /api/props?sport=basketball_nba
//   -> { ok:true, configured:true, props:[{player, stat, line, team, matchup, starts, book}] }
// The API key stays server-side in the PARLAY_API_KEY env var (Vercel ->
// Settings -> Environment Variables). Without it: { ok:false, configured:false }.
// Parlay API: GET https://parlay-api.com/v1/sports/{sport_key}/props
//   header X-API-Key, filter bookmakers=prizepicks. One call per sport,
//   3 credits per call — responses are cached in-memory for 60s per sport.

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

async function fetchSport(sport, key) {
  const base = "https://parlay-api.com/v1/sports/" + encodeURIComponent(sport) + "/props";
  let offset = 0, rows = [], guard = 0;
  while (guard < 3) {
    guard++;
    const url = base + "?bookmakers=prizepicks&limit=200&offset=" + offset;
    const r = await fetch(url, { headers: { "X-API-Key": key, "Accept": "application/json" } });
    if (!r.ok) throw new Error("parlay http " + r.status);
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
    const line = typeof lineRaw === "number" ? lineRaw : parseFloat(lineRaw);
    if (!player || !isFinite(line)) continue;
    const home = row.home_team || "", away = row.away_team || "";
    const matchup = row.event_name || row.matchup || (home && away ? away + " @ " + home : (row.event || ""));
    const starts = row.commence_time || row.start_time || row.event_time || row.game_time || "";
    // Only pre-game props: if a start time is present and already passed, skip.
    if (starts && new Date(starts).getTime() < Date.now() - 10 * 60 * 1000) continue;
    out.push({
      player,
      stat: statLabel(marketKey, row.market_display_name || row.description),
      line,
      team: row.team || row.player_team || "",
      matchup: String(matchup || ""),
      starts: String(starts || ""),
      book: row.bookmaker_title || row.bookmaker || "PrizePicks",
    });
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
  const key = process.env.PARLAY_API_KEY;
  if (!key) { res.status(200).json({ ok: false, configured: false, props: [] }); return; }
  const sport = (req.query && req.query.sport) || "";
  if (SPORT_KEYS.indexOf(sport) === -1) { res.status(400).json({ ok: false, error: "unknown sport" }); return; }
  const hit = cache[sport];
  if (hit && Date.now() - hit.ts < 60 * 1000) { res.status(200).json({ ok: true, configured: true, props: hit.props }); return; }
  try {
    const rows = await fetchSport(sport, key);
    const props = normalize(rows);
    cache[sport] = { ts: Date.now(), props };
    res.status(200).json({ ok: true, configured: true, props });
  } catch (err) {
    res.status(200).json({ ok: false, configured: true, error: String((err && err.message) || err), props: hit ? hit.props : [] });
  }
};
