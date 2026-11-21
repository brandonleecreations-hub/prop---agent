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

// FREE-ONLY MODE (Brandon 2026-11-20, "Only do free pulls no credits
// right now"): while this is true, api/props.js makes ZERO paid Parlay
// fetches on every lane -- no window claims, no break pulls, no legacy
// fresh pulls, no key-rotation probes. Boards serve from the shared
// Supabase cache and the free ESPN fallback only, so the app looks
// normal, just staler. To restore normal paid pulls, flip this to false.
var FREE_ONLY_PULLS = true;

const SPORT_KEYS = [
  "basketball_nba", "basketball_ncaab", "basketball_wncaab", "basketball_wnba",
  "americanfootball_nfl", "americanfootball_ncaaf",
  "icehockey_nhl", "baseball_mlb", "tennis", "tennis_atp", "tennis_wta",
  // SOCCER TEST (Brandon 2026-11-19): soccer_epl admitted to prove whether
  // Parlay's soccer keys carry real PLAYER PROPS or only match lines (the
  // tennis_atp/wta trap). Deliberately NO ESPN_PATHS entry yet: the
  // schedule gate fails OPEN without one, so the one approved test pull
  // rides the brk lane. Pending Brandon's go/no-go for a full Soccer tab;
  // if the test proves props, the gate mapping + windows follow.
  "soccer_epl",
  // SOCCER TEST batch 2 (Brandon 2026-11-19, "do soccer too right now"):
  // MLS + La Liga + Bundesliga + Ligue 1 all have fixtures within 48h, so
  // these keys get the same player-props-vs-match-lines proof pull as
  // soccer_epl. Same rules: NO ESPN_PATHS entries (gate fails open, test
  // pulls ride the brk lane), pending Brandon's go/no-go for a Soccer tab.
  "soccer_usa_mls", "soccer_spain_la_liga", "soccer_germany_bundesliga",
  "soccer_france_ligue_one",
  // ESPORTS (Brandon 2026-11-19): CS2 props PROVEN (195 rows / 94 players,
  // per-map Kills + Headshots). LoL rides the same pipeline — its board
  // lights up whenever Parlay posts rows and reads as an off-day while
  // empty (pro LoL is in off-season). Scores/stats come from the free
  // esports lane below (bo3.gg + Riot LoL Esports feeds), NOT ESPN.
  "esports_cs2", "esports_lol",
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
// ---- Recently-started game retention (Brandon 2026-11-18) ----
// Parlay's feed is a PRE-GAME board: once a game starts, its props leave
// the feed entirely, so the next board write would erase them and the
// live Game Center would have nothing to show. Retention carries a
// started game's props forward from the previous board for up to 5
// hours after its start (a full game + OT in every sport), flagged
// retained:1. The client excludes started games from every pickable
// surface by start time, so retained rows are display-only fuel for
// the Game Center's live matching. Fresh rows win per prop (same
// player+stat+starts), even when the line moved.
const RETAIN_MS = 5 * 60 * 60 * 1000;
function mergeRetained(prevProps, freshProps, now) {
  const t = now == null ? Date.now() : now;
  const out = [];
  const seen = new Set();
  const freshPS = new Set();
  const psKey = (p) => p.player + "|" + p.stat + "|" + (p.starts || "");
  const fresh = Array.isArray(freshProps) ? freshProps : [];
  for (const p of fresh) { if (p && typeof p === "object") freshPS.add(psKey(p)); }
  const push = (p, retained) => {
    if (!p || typeof p !== "object") return;
    const k = rowKey(p);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(retained ? Object.assign({}, p, { retained: 1 }) : p);
  };
  for (const p of fresh) {
    const st = p && p.starts ? new Date(p.starts).getTime() : NaN;
    if (isFinite(st) && st < t - RETAIN_MS) continue; // long finished: never carry
    push(p, false);
  }
  for (const p of Array.isArray(prevProps) ? prevProps : []) {
    const st = p && p.starts ? new Date(p.starts).getTime() : NaN;
    if (!isFinite(st)) continue;         // no start time: cannot prove it just started
    if (st > t) continue;                 // still upcoming: the fresh board owns it
    if (st < t - RETAIN_MS) continue;     // older than a full game + OT: drop
    if (freshPS.has(psKey(p))) continue; // fresh board has this prop (any line): fresh wins
    push(p, true);
  }
  return out;
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
//   - Paid fetches happen only in three windows per sport per day (06:00,
//     16:00 and 20:00 ET), claimed atomically so exactly ONE instance fetches.
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
function dailyCap() { return 50; } // Brandon 2026-11-18: permanent daily cap 50 (was flat 30 with one-day lifts)
// Three paid windows per ET day (Brandon 2026-11-18): the 20:00 ET
// evening window catches late-posted slates (e.g. 21:00 ET tips) that the
// 06:00 / 16:00 ET windows structurally miss.
const SLOT_HOURS_ET = [6, 16, 20];
function etSlot() {
  const h = etHour();
  for (let i = SLOT_HOURS_ET.length - 1; i >= 0; i--) { if (h >= SLOT_HOURS_ET[i]) return i + 1; }
  return 0;
}
// Managed budget (Brandon 2026-11-19, approved over a fixed lean
// schedule): the day is spent like a budget. Core sports — everything
// that predates the 2026-11-19 expansion — pull first and are never
// budget-gated. The NEW sports (esports_cs2, esports_lol and every
// soccer_* key) fill in only while the day's booked total leaves room
// under a soft budget of 80: they may start a paid pull (window claim
// or brk lane) only when usedToday + 6 <= 80, and otherwise serve
// their cached board for that window. The 50 line stays the credit
// watch's notify line (dailyCap above, reported in the tally) and the
// 100 hard stop stays the backstop for everyone.
const DAILY_BUDGET = 80;
const NEW_SPORT_KEYS = ["esports_cs2", "esports_lol"];
function isNewSport(sport) { return NEW_SPORT_KEYS.indexOf(sport) !== -1 || String(sport || "").indexOf("soccer_") === 0; }
// ---- AI lane helpers ----
async function aiCacheGet(key) {
  try {
    const rows = await sbReq("props_cache?sport=eq." + encodeURIComponent("ai_" + key) + "&select=sport,props,fetched_at");
    if (rows && rows[0] && rows[0].props && rows[0].props.text) return rows[0].props;
  } catch (e) {}
  return null;
}
async function aiCacheSet(key, obj) {
  try {
    const nowIso = new Date().toISOString();
    const ex = await sbReq("props_cache?sport=eq." + encodeURIComponent("ai_" + key) + "&select=sport");
    if (ex && ex.length) await sbReq("props_cache?sport=eq." + encodeURIComponent("ai_" + key), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ props: obj, fetched_at: nowIso }) });
    else await sbReq("props_cache", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ sport: "ai_" + key, props: obj, fetched_at: nowIso, credits_today: 0, count_day: etToday(), last_slot: 0 }) });
  } catch (e) {}
}
async function aiChatCount(uid) {
  try {
    const rows = await sbReq("props_cache?sport=eq." + encodeURIComponent("aichat_" + uid) + "&select=sport,credits_today,count_day");
    if (rows && rows[0] && String(rows[0].count_day || "") === etToday()) return rows[0].credits_today | 0;
  } catch (e) {}
  return 0;
}
async function aiChatBump(uid, n) {
  try {
    const key = "aichat_" + uid, today = etToday();
    const rows = await sbReq("props_cache?sport=eq." + encodeURIComponent(key) + "&select=sport,credits_today,count_day");
    if (rows && rows[0]) {
      const cur = String(rows[0].count_day || "") === today ? (rows[0].credits_today | 0) : 0;
      await sbReq("props_cache?sport=eq." + encodeURIComponent(key), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ credits_today: cur + n, count_day: today }) });
    } else {
      await sbReq("props_cache", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ sport: key, props: {}, fetched_at: new Date().toISOString(), credits_today: n, count_day: today, last_slot: 0 }) });
    }
  } catch (e) {}
}
function aiProvider() {
  // Free first: Google Gemini's free tier (AI Studio key, no billing) via
  // its NATIVE API \u2014 the OpenAI-compatible endpoint 404s for current
  // AI Studio keys. OpenAI stays as an optional fallback.
  if (process.env.GEMINI_API_KEY) return { kind: "gemini", key: process.env.GEMINI_API_KEY };
  if (process.env.GOOGLE_API_KEY) return { kind: "gemini", key: process.env.GOOGLE_API_KEY };
  if (process.env.OPENAI_API_KEY) return { kind: "openai", url: "https://api.openai.com/v1/chat/completions", key: process.env.OPENAI_API_KEY, model: "gpt-4o-mini" };
  return null;
}
let AI_LAST_STATUS = 0;
// Gemini model names rotate over time (a retired name 404s), so walk the
// chain and remember what worked.
const AI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-flash-latest", "gemini-2.5-flash"];
let AI_MODEL_OK = "";
async function aiCall(messages, maxTokens) {
  const prov = aiProvider();
  if (!prov) return null;
  if (prov.kind === "openai") {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(prov.url, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + prov.key },
        body: JSON.stringify({ model: prov.model, messages: messages, max_tokens: maxTokens || 240, temperature: 0.75 }),
      });
      clearTimeout(to);
      AI_LAST_STATUS = r.status;
      if (!r.ok) return null;
      const j = await r.json();
      const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      return t ? String(t).trim() : null;
    } catch (e) { clearTimeout(to); return null; }
  }
  // Native Gemini: system text rides in system_instruction; turns map
  // user -> user, assistant -> model.
  let sysText = "";
  const contents = [];
  (messages || []).forEach((m) => {
    if (!m || !m.content) return;
    if (m.role === "system") { sysText += (sysText ? "\n" : "") + m.content; return; }
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content) }] });
  });
  if (!contents.length) return null;
  const models = AI_MODEL_OK ? [AI_MODEL_OK] : AI_MODELS;
  for (const m of models) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent", {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": prov.key },
        body: JSON.stringify({
          systemInstruction: sysText ? { parts: [{ text: sysText }] } : undefined,
          contents: contents,
          generationConfig: { maxOutputTokens: maxTokens || 240, temperature: 0.75 },
        }),
      });
      clearTimeout(to);
      AI_LAST_STATUS = r.status;
      if (r.status === 404 || r.status === 429 || r.status === 503) continue;
      if (!r.ok) return null;
      const j = await r.json();
      const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
      const t = parts ? parts.map((p) => p.text || "").join("") : "";
      if (t) { AI_MODEL_OK = m; return t.trim(); }
      return null;
    } catch (e) { clearTimeout(to); return null; }
  }
  return null;
}
async function aiLane(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const key = aiProvider() ? "set" : "";
  if (req.query.ai === "ping") { res.status(200).json({ ok: true, on: !!key }); return; }
  if (req.query.ai === "probe") {
    const prov = aiProvider();
    if (!prov || prov.kind !== "gemini") { res.status(200).json({ ok: false }); return; }
    try {
      const pm = String(req.query.m || "gemini-3.8-flash").replace(/[^a-zA-Z0-9.-]/g, "");
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + pm + ":generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": prov.key },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Say hi in one word." }] }] }),
      });
      const j = await r.json().catch(() => null);
      const errMsg = j && j.error ? String(j.error.message || "").slice(0, 220) : "";
      const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
      res.status(200).json({ ok: r.ok, st: r.status, err: errMsg, text: parts ? parts.map((p) => p.text || "").join("").slice(0, 80) : "" });
    } catch (e) { res.status(200).json({ ok: false, st: 0, err: String((e && e.message) || e).slice(0, 120) }); }
    return;
  }
  if (req.query.ai === "models") {
    const prov = aiProvider();
    if (!prov || prov.kind !== "gemini") { res.status(200).json({ ok: false }); return; }
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models", { headers: { "x-goog-api-key": prov.key } });
      const j = await r.json().catch(() => null);
      const names = j && Array.isArray(j.models) ? j.models.map((m) => String(m.name || "").replace("models/", "")).filter((n) => n.indexOf("gemini") === 0) : [];
      res.status(200).json({ ok: r.ok, st: r.status, models: names.slice(0, 40) });
    } catch (e) { res.status(200).json({ ok: false, st: 0 }); }
    return;
  }
  if (!key) { res.status(200).json({ ok: false, off: true }); return; }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") { res.status(200).json({ ok: false }); return; }
  if (body.mode === "gen") {
    const ck = String(body.cacheKey || "").replace(/[^a-zA-Z0-9_:-]/g, "").slice(0, 120);
    const sys = String(body.sys || "").slice(0, 600), usr = String(body.user || "").slice(0, 1800);
    if (!ck || !usr) { res.status(200).json({ ok: false }); return; }
    const hit = await aiCacheGet(ck);
    if (hit && hit.text) { res.status(200).json({ ok: true, text: hit.text, cached: true }); return; }
    const text = await aiCall([{ role: "system", content: sys || "You write short, punchy sports blurbs." }, { role: "user", content: usr }], body.maxTokens || 240);
    if (!text) { res.status(200).json({ ok: false, st: AI_LAST_STATUS }); return; }
    await aiCacheSet(ck, { text: text, ts: Date.now() });
    res.status(200).json({ ok: true, text: text });
    return;
  }
  if (body.mode === "chat") {
    const uid = String(body.uid || "anon").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40) || "anon";
    const used = await aiChatCount(uid);
    if (used >= 40) { res.status(200).json({ ok: false, limit: true }); return; }
    const msgs = Array.isArray(body.messages) ? body.messages.slice(-8).map((m) => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: String((m && m.content) || "").slice(0, 900) })).filter((m) => m.content) : [];
    if (!msgs.length) { res.status(200).json({ ok: false }); return; }
    const sys = String(body.sys || "").slice(0, 700);
    const ctx = String(body.ctx || "").slice(0, 3500);
    const full = [{ role: "system", content: sys + (ctx ? "\n\nLIVE APP DATA:\n" + ctx : "") }].concat(msgs);
    const text = await aiCall(full, 320);
    if (!text) { res.status(200).json({ ok: false, st: AI_LAST_STATUS }); return; }
    await aiChatBump(uid, 1);
    res.status(200).json({ ok: true, text: text });
    return;
  }
  res.status(200).json({ ok: false });
}
function budgetOpen(usedToday) { return usedToday + 6 <= DAILY_BUDGET; }
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
// Booked credits across ALL sports for the current ET day, from the
// shared props_cache rows; null when the shared store is unavailable.
async function sbUsedToday() {
  const rows = await sbCacheAll();
  if (!rows) return null;
  const today = etToday();
  return rows.reduce((sum, r) => sum + (String(r.count_day || "") === today ? (r.credits_today | 0) : 0), 0);
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
  // Retention: a fresh write must not erase props for games that just
  // started (see mergeRetained). When the fresh board is empty (feed
  // hiccup / empty slate), merge against the stored board itself so a
  // bad pull cannot wipe future games either -- it only prunes rows
  // older than the retention window.
  const base = (Array.isArray(props) && props.length) ? props : (row && Array.isArray(row.props) ? row.props : props);
  const body = { props: mergeRetained(row && row.props, base) };
  if (row && row !== undefined) {
    const today = etToday();
    const cur = String(row.count_day || "") === today ? (row.credits_today | 0) : 0;
    body.credits_today = Math.max(0, cur - Math.max(0, (reserved | 0) - (actualCredits | 0)));
    body.count_day = today;
  }
  const patched = await sbReq("props_cache?sport=eq." + encodeURIComponent(sport), { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
  if (!Array.isArray(patched) || !patched.length) {
    // No row exists for this sport yet: a PATCH matches nothing and the
    // write would silently vanish. That is exactly how the esports
    // boards were lost (Brandon 2026-11-19): esports_cs2/esports_lol
    // were added after the day's last window with the hard stop already
    // tripped, so no window claim ever created their rows, and every
    // brk-lane sbCachePut (195 CS2 rows, three times) no-opped — the
    // board never persisted and every phone read an empty shared board.
    // Create the row (same shape sbClaim's insert and espSbPut use);
    // if a concurrent claim created it first, the POST conflicts and
    // one more PATCH lands the board on it.
    const ins = await sbReq("props_cache", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ sport, props: body.props, fetched_at: new Date().toISOString(), credits_today: 0, count_day: etToday(), last_slot: 0 }) });
    if (!Array.isArray(ins) || !ins.length) {
      await sbReq("props_cache?sport=eq." + encodeURIComponent(sport), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });
    }
  }
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
    // A board whose rows are ALL retained (every game on it already
    // started) must not shadow upcoming games: fall through to the
    // in-memory board / ESPN fallback and append the retained rows so
    // the live Game Center still finds its props.
    if (!sbRow.props.some((p) => !p.retained)) {
      let extra = (hit && hit.props.length) ? hit.props : null;
      let fromFb = false;
      if (!extra) {
        const fbR = await espnFallback(sport, "pre").catch(() => []);
        if (fbR.length) { extra = fbR; fromFb = true; }
      }
      if (extra) {
        const merged = mergeRetained(sbRow.props, extra);
        cache[sport] = { ts: Date.now(), props: merged, pregameRefreshed: false, espnFallback: fromFb };
        res.status(200).json({ ok: true, configured: true, cached: true, shared: true, stale: true, props: merged });
        return;
      }
    }
    const fStale = await partialFill(sport, sbRow.props);
    if (fStale.filled) {
      stampSeen(sport, fStale.props);
      cache[sport] = { ts: Date.now(), props: fStale.props, pregameRefreshed: false, espnFallback: true, filled: true };
      res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
      res.status(200).json({ ok: true, configured: true, cached: true, shared: true, stale: true, partialFill: true, props: fStale.props });
      return;
    }
    cache[sport] = { ts: new Date(sbRow.fetched_at).getTime(), props: sbRow.props, pregameRefreshed: true };
    res.status(200).json({ ok: true, configured: true, cached: true, shared: true, stale: true, props: sbRow.props });
    return;
  }
  if (hit && hit.props.length) {
    const fHitStale = await partialFill(sport, hit.props);
    if (fHitStale.filled) {
      stampSeen(sport, fHitStale.props);
      cache[sport] = { ts: Date.now(), props: fHitStale.props, pregameRefreshed: false, espnFallback: true, filled: true };
      res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
      res.status(200).json({ ok: true, configured: true, cached: true, stale: true, partialFill: true, props: fHitStale.props });
      return;
    }
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
const PRIMARY_KEY = process.env.PARLAY_API_KEY_2 || process.env.PARLEY_API_KEY_2 || "";
const goodToday = {}; // key tail -> ET day of its last successful fetch
let probeDay = "";
function markGood(k) { goodToday[String(k).slice(-6)] = etToday(); }
function isGood(k) { return goodToday[String(k).slice(-6)] === etToday(); }
let rotN = 0;
async function fetchSport(sport, keys) {
  if (FREE_ONLY_PULLS) throw new Error("free-only mode: paid Parlay fetches disabled (Brandon 2026-11-20)");
  const all = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  const good = all.filter(isGood);
  const rest = all.filter(function (k) { return !isGood(k); });
  rest.sort(function (a, b) { return (b === PRIMARY_KEY) - (a === PRIMARY_KEY); });
  let list;
  if (good.length > 1) {
    const start = (rotN++) % good.length;
    list = good.slice(start).concat(good.slice(0, start)).concat(rest);
  } else {
    list = good.concat(rest);
  }
  if (probeDay !== etToday()) {
    const cand = list.find(function (k) { return !isGood(k) && keyAlive(k); });
    if (cand && list.length > 1) { probeDay = etToday(); list = [cand].concat(list.filter(function (k) { return k !== cand; })); }
  }
  let lastErr = null;
  for (const k of list) {
    if (!keyAlive(k)) continue;
    try { const out = await fetchSportWithKey(sport, k); markGood(k); return out; }
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

function normalize(rows, keepStarted, sportKey) {
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
      game: sportKey === "esports_cs2" ? "cs2" : (sportKey === "esports_lol" ? "lol" : ""),
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
    // "fill" mode (partial-board fill, below) covers a wider slate and
    // keeps more rows than the empty-board "pre" fill: the players
    // missing from a multi-game slate do not fit in the first 4 games /
    // 400 rows.
    const cap = mode === "fill" ? 8 : 4;
    targets = evs.filter((ev) => {
      const t = ev.status && ev.status.type;
      return t && t.state === "pre" && new Date(ev.date || 0).getTime() > now - 10 * 60 * 1000;
    }).slice(0, cap);
  }
  let out = [];
  for (const ev of targets) {
    try { out = out.concat(await espnGameProps(sport, ev)); } catch (e) {}
  }
  return out.slice(0, mode === "fill" ? 1200 : 400);
}

// ---- Partial-board fill (Brandon 2026-11-19): Parlay sometimes posts a
// PARTIAL board -- a handful of players for a multi-game slate (tonight's
// NBA board sat at 7 players for 4 games all day) -- and the empty-board
// ESPN fallback above never fires because the board is not empty. When a
// Parlay board's player coverage is clearly partial for today's upcoming
// slate, top it up from the same ESPN DraftKings feed: Parlay rows are
// kept verbatim and win every conflict; ESPN rows are added only for
// player+stat pairs the Parlay board lacks. The merged board is served
// (and held in the in-memory cache under the espnFallback flag, so it
// stays fresh 30 min max) but is NEVER written into the shared
// props_cache -- the shared board stays the pure Parlay board, so
// PrizePicks retakes the board the moment Parlay posts the full slate.
// Pro sports with a working ESPN odds feed only; tennis and college are
// untouched. Zero Parlay credits: the fill is ESPN-only.
const FILL_SPORTS = ["basketball_nba", "basketball_wnba", "americanfootball_nfl", "icehockey_nhl", "baseball_mlb"];
function fillNameKey(s) { return String(s || "").normalize("NFD").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function fillStatKey(s) {
  const tok = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean)
    .map((w) => ({ pts: "pt", rebs: "reb", asts: "ast", blocked: "block", blocks: "block", blks: "block", stls: "steal", steals: "steal" }[w] || w));
  let key = tok.join(" ");
  if (key === "3 pt made" || key === "3 pointers made" || key === "3 point field goals") key = "3pt made";
  else if (key === "block shots") key = "block";
  else if (tok.length > 1 && tok.every((w) => w === "pt" || w === "reb" || w === "ast")) key = tok.slice().sort().join("+");
  return key;
}
function mergeEspnFill(parlayProps, espnRows) {
  const have = new Set();
  for (const p of parlayProps) if (p && p.player) have.add(fillNameKey(p.player) + "|" + fillStatKey(p.stat));
  const out = parlayProps.slice();
  for (const r of espnRows) {
    if (!r || !r.player) continue;
    const k = fillNameKey(r.player) + "|" + fillStatKey(r.stat);
    if (have.has(k)) continue; // Parlay's line wins on conflict
    have.add(k);
    out.push(r);
  }
  return out;
}
async function partialFill(sport, props) {
  const board = Array.isArray(props) ? props : [];
  try {
    if (FILL_SPORTS.indexOf(sport) === -1 || !board.length) return { props: board, filled: false };
    const evs = await scoreboardEvents(sport);
    const now = Date.now();
    const upcoming = (Array.isArray(evs) ? evs : []).filter((ev) => {
      const t = ev && ev.status && ev.status.type;
      return t && t.state === "pre" && new Date(ev.date || 0).getTime() > now - 10 * 60 * 1000;
    });
    if (!upcoming.length) return { props: board, filled: false };
    const players = new Set();
    for (const p of board) {
      if (!p || p.retained || !p.player) continue;
      const st = p.starts ? new Date(p.starts).getTime() : NaN;
      if (isFinite(st) && st < now - 10 * 60 * 1000) continue;
      players.add(p.player);
    }
    // Coverage trigger: a healthy PrizePicks board carries well over 6
    // players per game, so fewer than max(15, 6 per upcoming game)
    // distinct players means the feed posted a partial slate.
    if (players.size >= Math.max(15, upcoming.length * 6)) return { props: board, filled: false };
    const fb = await espnFallback(sport, "fill").catch(() => []);
    if (!fb.length) return { props: board, filled: false };
    const merged = mergeEspnFill(board, fb);
    return { props: merged, filled: merged.length > board.length };
  } catch (e) { return { props: board, filled: false }; }
}

// ================= ESPORTS LANE (Brandon 2026-11-19) =================
// The Esports section's scores / schedules / player stats / grading data,
// from the free sources proven in ~/workspace/esports-free-sources.md:
//   CS2 -> bo3.gg public JSON API (no key): schedule via newest-list
//     polling + slug tracking, per-map player kills/headshots from
//     /games/{id}/players_stats, logos + photos on files.bo3.gg.
//   LoL -> Riot's LoL Esports feeds: getSchedule / getLive /
//     getEventDetails behind the long-published lolesports.com public web
//     key (a public web key shipped to every browser for years — NOT a
//     user secret; a 403 is treated as source-down and fails over), plus
//     the no-auth feed.lolesports.com livestats window feed for live and
//     final per-player KDA / CS.
// Everything is cached server-side (in-memory + the shared props_cache
// table under esp_* keys) so the app polls smoothly and politely. The
// failover floor is the manual stepper: a stat that cannot be resolved
// here stays unresolved — never an auto-loss (the v1.0.57 rule).
const LOL_WEB_KEY = process.env.LOL_ESPORTS_API_KEY || "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z";
const BO3_API = "https://api.bo3.gg/api/v1";
const LOL_GW = "https://esports-api.lolesports.com/persisted/gw";
const LOL_FEED = "https://feed.lolesports.com/livestats/v1";
const espMem = {}; // key -> {ts, data}
async function espGet(url, headers) {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(url, { headers: Object.assign({ "User-Agent": "PropAgent/1.0" }, headers || {}), signal: ctl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
async function espSbGet(key) {
  const rows = await sbReq("props_cache?sport=eq." + encodeURIComponent(key) + "&select=sport,props,fetched_at");
  if (!Array.isArray(rows) || !rows.length) return null;
  return { ts: new Date(rows[0].fetched_at).getTime() || 0, data: rows[0].props };
}
async function espSbPut(key, data) {
  const nowIso = new Date().toISOString();
  const ex = await sbReq("props_cache?sport=eq." + encodeURIComponent(key) + "&select=sport");
  if (Array.isArray(ex) && ex.length) {
    await sbReq("props_cache?sport=eq." + encodeURIComponent(key), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ props: data, fetched_at: nowIso }) });
  } else if (ex !== null && ex !== undefined) {
    await sbReq("props_cache", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ sport: key, props: data, fetched_at: nowIso, credits_today: 0, count_day: etToday(), last_slot: 0 }) });
  }
}
// Cached read-through: in-memory (ttlMs) -> shared store (ttlMs) -> loader
// -> store both. A failed load serves the shared copy while it is younger
// than staleMs, else the in-memory copy, else null.
async function espCached(key, ttlMs, staleMs, loader) {
  const m = espMem[key];
  if (m && Date.now() - m.ts < ttlMs) return m.data;
  const sb = await espSbGet(key).catch(() => null);
  if (sb && sb.data != null && Date.now() - sb.ts < ttlMs) { espMem[key] = sb; return sb.data; }
  let data = null;
  try { data = await loader(); } catch (e) { data = null; }
  if (data != null) { espMem[key] = { ts: Date.now(), data }; espSbPut(key, data).catch(() => {}); return data; }
  if (sb && sb.data != null && Date.now() - sb.ts < staleMs) { espMem[key] = sb; return sb.data; }
  if (m) return m.data;
  return sb ? sb.data : null;
}
function nickKey(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function espStatKind(stat) {
  const s = String(stat || "").toLowerCase();
  if (/headshot/.test(s)) return "hs";
  if (/kill/.test(s)) return "k";
  if (/death/.test(s)) return "d";
  if (/assist/.test(s)) return "a";
  if (/\bcs\b|creep/.test(s)) return "cs";
  return "";
}
// "MAPS 1-2 Kills" -> [1,2]; "Map 3 Headshots" -> [3]; no map scope -> null
// (the whole played series).
function espScope(stat) {
  const s = String(stat || "");
  if (/maps?\s*1\s*[-\u2013]\s*2/i.test(s)) return [1, 2];
  const m = /map\s*(\d)/i.exec(s);
  if (m) return [parseInt(m[1], 10)];
  return null;
}
// ---------- bo3.gg (CS2) ----------
function bo3TeamNorm(t) {
  return t ? { id: t.id || 0, slug: t.slug || "", name: t.name || "", logo: t.image_url || t.icon_url || "", rank: t.rank || null }
           : { id: 0, slug: "", name: "", logo: "", rank: null };
}
function bo3MapName(raw) {
  const s = String(raw || "").replace(/^de_/, "").replace(/^cs_/, "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}
function bo3DetailNorm(d) {
  const t1 = bo3TeamNorm(d.team1), t2 = bo3TeamNorm(d.team2);
  const games = (Array.isArray(d.games) ? d.games : []).slice().sort((a, b) => (a.number || 0) - (b.number || 0));
  const fin = d.status === "finished" || d.status === "defwin";
  const startMs = d.start_date ? new Date(d.start_date).getTime() : 0;
  const state = fin ? "post" : (startMs && startMs > Date.now() ? "pre" : "in");
  const maps = games.map((g) => {
    const wId = g.winner_team_clan && g.winner_team_clan.team_id;
    let s1 = null, s2 = null, winner = 0;
    if (g.winner_clan_score != null && g.loser_clan_score != null && wId != null) {
      if (String(wId) === String(t1.id)) { s1 = g.winner_clan_score; s2 = g.loser_clan_score; winner = 1; }
      else if (String(wId) === String(t2.id)) { s2 = g.winner_clan_score; s1 = g.loser_clan_score; winner = 2; }
    }
    return { n: g.number || 0, gameId: g.id, name: bo3MapName(g.map_name), state: g.state || "", status: g.status || "", s1, s2, winner, rounds: g.rounds_count || 0, begin: g.begin_at || "" };
  });
  return { game: "cs2", id: d.id, slug: d.slug, starts: d.start_date || "", ends: d.end_date || "", state, status: d.status || "", parsed: d.parsed_status || "", bo: d.bo_type || 0, tournament: (d.tournament && d.tournament.name) || "", tier: d.tier || "", teams: [t1, t2], score: [d.team1_score || 0, d.team2_score || 0], maps };
}
async function bo3Detail(slug) {
  const key = "esp_m_" + slug;
  const m = espMem[key];
  if (m && m.data && m.data.state === "post" && m.data.parsed === "done" && Date.now() - m.ts < 30 * 60 * 1000) return m.data;
  return espCached(key, 45000, 6 * 3600 * 1000, async () => {
    const d = await espGet(BO3_API + "/matches/" + encodeURIComponent(slug) + "?with=games");
    if (!d || !d.id) return null;
    return bo3DetailNorm(d);
  });
}
async function bo3Roster(teamSlug) {
  if (!teamSlug) return [];
  const data = await espCached("esp_team_" + teamSlug, 6 * 3600 * 1000, 24 * 3600 * 1000, async () => {
    const d = await espGet(BO3_API + "/teams/" + encodeURIComponent(teamSlug));
    if (!d) return null;
    return (d.players || []).filter((p) => p && !p.is_coach).slice(0, 8).map((p) => ({ nick: p.nickname || "", name: ((p.first_name || "") + " " + (p.last_name || "")).trim(), img: p.image_url || "", slug: p.slug || "" }));
  }).catch(() => null);
  return Array.isArray(data) ? data : [];
}
async function bo3GameStats(gameId, live) {
  // Live and final stats use SEPARATE cache keys: a mid-map partial fetched
  // on the live lane must never be served as the map's FINAL line by the
  // final lane's 30-min TTL once the map ends (Brandon 2026-11-20 audit).
  return espCached(live ? "esp_gl_" + gameId : "esp_g_" + gameId, live ? 30000 : 30 * 60 * 1000, 24 * 3600 * 1000, async () => {
    const d = await espGet(BO3_API + "/games/" + gameId + "/players_stats");
    const rows = Array.isArray(d) ? d : (d && Array.isArray(d.results) ? d.results : null);
    if (!rows || !rows.length) return null;
    return rows.map((r) => {
      const sp = r.steam_profile || {}, pl = sp.player || {};
      return { nick: sp.nickname || pl.nickname || "", name: ((pl.first_name || "") + " " + (pl.last_name || "")).trim(), img: pl.image_url || "", teamId: (r.team_clan && r.team_clan.team_id) || 0, clan: r.clan_name || "", k: r.kills || 0, hs: r.headshots || 0, d: r.death || 0, a: r.assists || 0, adr: r.adr != null ? Math.round(r.adr * 10) / 10 : null, rating: r.player_rating != null ? Math.round(r.player_rating * 100) / 100 : null, kast: r.kast != null ? Math.round(r.kast * 100) : null };
    });
  }).catch(() => null);
}
// Running round tally for an in-progress map, from the game's round log —
// the freshest live score bo3 serves; empty until rounds are logged.
async function bo3GameRounds(gameId) {
  const d = await espGet(BO3_API + "/games/" + gameId);
  if (!d) return null;
  const rounds = Array.isArray(d.game_rounds) ? d.game_rounds : [];
  const tally = {};
  rounds.forEach((r) => { if (r.winner_clan_name) tally[r.winner_clan_name] = (tally[r.winner_clan_name] || 0) + 1; });
  return { roundsPlayed: rounds.length, tally, wClan: (d.winner_team_clan && d.winner_team_clan.clan_name) || "", wId: (d.winner_team_clan && d.winner_team_clan.team_id) || 0, lClan: (d.loser_team_clan && d.loser_team_clan.clan_name) || "", lId: (d.loser_team_clan && d.loser_team_clan.team_id) || 0 };
}
async function espCs2Match(slug) {
  const det = await bo3Detail(slug);
  if (!det) return null;
  for (const m of det.maps) {
    if (m.state === "done" || m.status === "finished") {
      const st = await bo3GameStats(m.gameId, false);
      if (st) { m.players = st; m.statsFrom = "final"; }
    }
  }
  det.liveMap = null;
  if (det.state === "in") {
    const cur = det.maps.find((m) => !(m.state === "done" || m.status === "finished"));
    if (cur) {
      det.liveMap = cur.n;
      const rd = await bo3GameRounds(cur.gameId).catch(() => null);
      if (rd && rd.roundsPlayed) { cur.roundsPlayed = rd.roundsPlayed; cur.tally = rd.tally; cur.clanIds = {}; if (rd.wClan) cur.clanIds[rd.wClan] = rd.wId; if (rd.lClan) cur.clanIds[rd.lClan] = rd.lId; }
      const st = await bo3GameStats(cur.gameId, true);
      if (st) { cur.players = st; cur.statsFrom = "live"; }
    }
  }
  return det;
}
async function bo3List(sort) {
  const d = await espGet(BO3_API + "/matches?sort=" + encodeURIComponent(sort));
  return (d && Array.isArray(d.results)) ? d.results : [];
}
// Live matches carry status "current" on bo3 and sit in NEITHER top-10
// discovery list above (created earlier, not yet ended — proven live
// 2026-11-20: NT vs BAKS was mid-map-1 while the lane showed 0 live).
// Ask bo3 for the in-progress matches directly so live always surfaces.
async function bo3LiveList() {
  const d = await espGet(BO3_API + "/matches?filter%5Bmatches.status%5D%5Beq%5D=current&sort=-start_date&page%5Blimit%5D=50");
  return (d && Array.isArray(d.results)) ? d.results : [];
}
async function espCs2Schedule() {
  return espCached("esp_sched_cs2", 60000, 600000, async () => {
    const lists = await Promise.all([bo3List("-id"), bo3List("-end_date"), bo3LiveList()]);
    const seen = {}, rows = [];
    lists[0].concat(lists[1], lists[2]).forEach((r) => { if (r && r.id && !seen[r.id]) { seen[r.id] = 1; rows.push(r); } });
    const now = Date.now();
    const picked = rows.filter((r) => {
      const startMs = r.start_date ? new Date(r.start_date).getTime() : 0;
      const endMs = r.end_date ? new Date(r.end_date).getTime() : 0;
      const fin = r.status === "finished" || r.status === "defwin";
      if (fin) return !!(endMs && now - endMs < 48 * 3600 * 1000);
      return !!(startMs && startMs > now - 6 * 3600 * 1000 && startMs < now + 72 * 3600 * 1000);
    });
    // Detail slots are capped at 24, so spend them live-first: a match
    // that is on right now must never be crowded out of the detail fetch
    // by older finished matches with earlier start times.
    function prio(r) {
      if (r.status === "finished" || r.status === "defwin") return 2;
      const s = r.start_date ? new Date(r.start_date).getTime() : 0;
      return (r.status === "current" || (s && s <= now)) ? 0 : 1;
    }
    picked.sort((a, b) => {
      const pa = prio(a), pb = prio(b);
      if (pa !== pb) return pa - pb;
      if (pa === 2) return new Date(b.end_date || b.start_date) - new Date(a.end_date || a.start_date);
      return new Date(a.start_date) - new Date(b.start_date);
    });
    const top = picked.slice(0, 24);
    const dets = [];
    for (let i = 0; i < top.length; i += 6) {
      const chunk = await Promise.all(top.slice(i, i + 6).map((r) => bo3Detail(r.slug).catch(() => null)));
      chunk.forEach((d) => { if (d) dets.push(d); });
    }
    const out = { live: [], upcoming: [], finished: [] };
    for (const det of dets) {
      const item = { id: det.id, slug: det.slug, starts: det.starts, ends: det.ends, state: det.state, status: det.status, parsed: det.parsed, bo: det.bo, tournament: det.tournament, tier: det.tier, teams: det.teams, score: det.score, maps: det.maps.map((m) => ({ n: m.n, name: m.name, s1: m.s1, s2: m.s2, winner: m.winner, status: m.status })) };
      if (det.state === "post") { if (out.finished.length < 8) out.finished.push(item); }
      else if (det.state === "in") out.live.push(item);
      else if (out.upcoming.length < 10) out.upcoming.push(item);
    }
    out.finished.sort((a, b) => new Date(b.ends || b.starts) - new Date(a.ends || a.starts));
    // Rosters ride along for props attribution + player photos.
    for (const item of out.live.concat(out.upcoming)) {
      item.rosters = [];
      for (const t of item.teams) {
        const ros = await bo3Roster(t.slug);
        ros.forEach((p) => item.rosters.push({ nick: p.nick, name: p.name, img: p.img, team: t.name, teamId: t.id }));
      }
    }
    return out;
  }).catch(() => null);
}
// ---------- CS2 props attribution (Brandon 2026-11-20) ----------
// Parlay rows carry no team/matchup, and the schedule lane's roster window
// covers different matches (bo3's newest list, mostly tier-C) than the
// props board — measured 0 of 194 real rows attributed client-side. This
// lane attributes the shared CS2 board server-side instead:
//   1. each distinct player resolves to his bo3 team (/players/{slug},
//      cached a day — profiles move slowly);
//   2. teams sharing a Parlay start-time bucket are paired into real
//      matches by constructing the bo3 match slug from the two team slugs
//      + date and VERIFYING the detail's team ids match the pair;
//   3. rows are attributed from the two match teams' rosters (rosters
//      catch stale profiles), then by a roster sweep over the bucket's
//      teams, then by profile team alone (teammates stay together under
//      their real team name even when their match can't be constructed);
//   4. only a player bo3 cannot place anywhere stays unattributed.
// The computed map is cached against a fingerprint of the shared board.
const espAttrMiss = {}; // slug -> ts, in-memory negative cache for probes
async function bo3PlayerProfile(nkName, rawNick) {
  const p = await espCached("esp_p_" + nkName, 24 * 3600 * 1000, 7 * 86400000, async () => {
    const base = String(rawNick || "").toLowerCase();
    const cands = [...new Set([base.replace(/[^a-z0-9]/g, ""), base.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), base])];
    for (const slug of cands) {
      if (!slug) continue;
      const j = await espGet(BO3_API + "/players/" + encodeURIComponent(slug));
      if (j && j.nickname && nickKey(j.nickname) === nkName) {
        const t = j.team || {};
        return { found: 1, teamId: j.team_id || t.id || 0, teamSlug: t.slug || "", team: t.name || "", img: j.image_url || "" };
      }
    }
    return { found: 0, teamId: 0, teamSlug: "", team: "", img: "" };
  }).catch(() => null);
  return p && p.found ? p : null;
}
async function bo3DetailProbe(slug) {
  if (espAttrMiss[slug] && Date.now() - espAttrMiss[slug] < 30 * 60 * 1000) return null;
  const d = await bo3Detail(slug).catch(() => null);
  if (!d) { espAttrMiss[slug] = Date.now(); return null; }
  return d;
}
function espAttrDates(startsIso) {
  const t = new Date(startsIso).getTime();
  if (!t) return [];
  const fmt = (ms) => { const d = new Date(ms); return String(d.getUTCDate()).padStart(2, "0") + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + d.getUTCFullYear(); };
  return [fmt(t), fmt(t - 86400000), fmt(t + 86400000)];
}
async function espAttrFindMatch(teamA, teamB, startsIso, claimed) {
  const want = [String(teamA.teamId), String(teamB.teamId)].sort().join(",");
  for (const ds of espAttrDates(startsIso)) {
    const slugs = [teamA.teamSlug + "-vs-" + teamB.teamSlug + "-" + ds, teamB.teamSlug + "-vs-" + teamA.teamSlug + "-" + ds]
      .filter((s) => !claimed.has(s));
    const dets = await Promise.all(slugs.map((s) => bo3DetailProbe(s)));
    for (const d of dets) {
      if (d && (d.teams || []).map((t) => String(t.id)).sort().join(",") === want) return d;
    }
  }
  return null;
}
async function espCs2AttrCompute(rows) {
  const cs2 = rows.filter((r) => r && r.game === "cs2" && r.player);
  const out = {};
  const stats = { rows: cs2.length, roster: 0, sweep: 0, teamOnly: 0, other: 0, matches: 0 };
  if (!cs2.length || cs2.length > 1500) return { players: out, stats };
  // 1. resolve player profiles (chunked)
  const profs = {};
  const distinct = [...new Map(cs2.map((r) => [nickKey(r.player), r.player])).entries()];
  for (let i = 0; i < distinct.length; i += 6) {
    const part = await Promise.all(distinct.slice(i, i + 6).map(([k, nick]) => bo3PlayerProfile(k, nick)));
    part.forEach((p, j) => { profs[distinct[i + j][0]] = p; });
  }
  const buckets = {};
  cs2.forEach((r) => { (buckets[r.starts || ""] = buckets[r.starts || ""] || []).push(r); });
  const sched = await espCs2Schedule().catch(() => null);
  const schedMatches = sched ? [].concat(sched.live || [], sched.upcoming || [], sched.finished || []) : [];
  const claimed = new Set();
  for (const starts of Object.keys(buckets)) {
    const brows = buckets[starts];
    const players = [...new Set(brows.map((r) => r.player))];
    const teams = {};
    players.forEach((p) => {
      const pr = profs[nickKey(p)];
      if (pr && pr.teamId) { const t = teams[pr.teamId] || (teams[pr.teamId] = { teamId: pr.teamId, teamSlug: pr.teamSlug, team: pr.team, n: 0 }); t.n++; }
    });
    const pool = Object.values(teams).sort((a, b) => b.n - a.n);
    const matches = [];
    // 2. pair teams into verified matches
    let progressed = true;
    while (pool.length >= 2 && progressed) {
      progressed = false;
      outer:
      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          if (!pool[i].teamSlug || !pool[j].teamSlug) continue;
          const d = await espAttrFindMatch(pool[i], pool[j], starts, claimed);
          if (d) { matches.push(d); claimed.add(d.slug); pool.splice(j, 1); pool.splice(i, 1); progressed = true; break outer; }
        }
      }
    }
    // schedule cross-reference for a leftover team (its match is already
    // tracked by the schedule lane but its opponent has no props here)
    for (const t of [...pool]) {
      const cand = schedMatches.find((m) => !claimed.has(m.slug) && (m.teams || []).some((tm) => String(tm.id) === String(t.teamId)) && Math.abs(new Date(m.starts) - new Date(starts)) < 4 * 3600 * 1000);
      if (cand) { const d = await bo3DetailProbe(cand.slug); if (d) { matches.push(d); claimed.add(d.slug); pool.splice(pool.indexOf(t), 1); } }
    }
    stats.matches += matches.length;
    // rosters: match teams + every profile team in the bucket (for the sweep)
    const allTeams = {};
    matches.forEach((d) => (d.teams || []).forEach((t) => { allTeams[t.id] = { id: t.id, slug: t.slug, name: t.name }; }));
    Object.values(teams).forEach((t) => { if (!allTeams[t.teamId]) allTeams[t.teamId] = { id: t.teamId, slug: t.teamSlug, name: t.team }; });
    const rosterOf = {};
    const teamArr = Object.values(allTeams);
    for (let i = 0; i < teamArr.length; i += 6) {
      const part = await Promise.all(teamArr.slice(i, i + 6).map((t) => bo3Roster(t.slug).catch(() => [])));
      part.forEach((ros, j) => {
        const t = teamArr[i + j];
        rosterOf[t.id] = { name: t.name, nicks: new Set(ros.map((p) => nickKey(p.nick))), imgs: {} };
        ros.forEach((p) => { rosterOf[t.id].imgs[nickKey(p.nick)] = p.img || ""; });
      });
    }
    const matchOfTeam = {};
    matches.forEach((d) => (d.teams || []).forEach((t) => { matchOfTeam[t.id] = d; }));
    const done = new Set();
    const put = (r, teamName, det, img, via) => {
      const key = nickKey(r.player) + "|" + (r.starts || "");
      out[key] = { team: teamName, slug: det ? det.slug : "", state: det ? det.state : "", starts: det ? det.starts : "", matchup: det ? (det.teams || []).map((t) => t.name).join(" vs ") : "", img: img || "", via };
      done.add(key);
    };
    // 3a. match rosters first (they catch stale profiles), then profile
    // teamId inside a found match
    for (const d of matches) {
      for (const r of brows) {
        if (done.has(nickKey(r.player) + "|" + (r.starts || ""))) continue;
        for (const t of d.teams || []) {
          const ro = rosterOf[t.id];
          if (ro && ro.nicks.has(nickKey(r.player))) { put(r, t.name, d, ro.imgs[nickKey(r.player)], "roster"); break; }
        }
      }
      for (const r of brows) {
        if (done.has(nickKey(r.player) + "|" + (r.starts || ""))) continue;
        const pr = profs[nickKey(r.player)];
        if (pr && pr.teamId && (d.teams || []).some((t) => String(t.id) === String(pr.teamId))) {
          const t = (d.teams || []).find((t) => String(t.id) === String(pr.teamId));
          put(r, t.name, d, pr.img, "roster");
        }
      }
    }
    // 3b. roster sweep: a leftover on the roster of a bucket team joins
    // that team — the team with the most other bucket players wins, and
    // it must have at least one other bucket player (no stray listings)
    const teamPresence = {};
    players.forEach((p) => {
      const pr = profs[nickKey(p)];
      if (pr && pr.teamId) teamPresence[pr.teamId] = (teamPresence[pr.teamId] || 0) + 1;
    });
    brows.forEach((r) => {
      if (done.has(nickKey(r.player) + "|" + (r.starts || ""))) return;
      let best = null, bestScore = 0;
      for (const t of Object.values(allTeams)) {
        const ro = rosterOf[t.id];
        if (!ro || !ro.nicks.has(nickKey(r.player))) continue;
        let score = teamPresence[t.id] || 0;
        const pr = profs[nickKey(r.player)];
        if (pr && String(pr.teamId) === String(t.id)) score--; // don't count himself
        if (score >= 1 && score > bestScore) { best = t; bestScore = score; }
      }
      if (best) put(r, best.name, matchOfTeam[best.id] || null, rosterOf[best.id].imgs[nickKey(r.player)], matchOfTeam[best.id] ? "roster" : "sweep");
    });
    // 3c. profile team alone — teammates still together under the real name
    brows.forEach((r) => {
      if (done.has(nickKey(r.player) + "|" + (r.starts || ""))) return;
      const pr = profs[nickKey(r.player)];
      if (pr && pr.team) put(r, pr.team, null, pr.img, "team");
    });
  }
  // Row-accurate stats (put() is per player; Brandon's numbers are rows)
  cs2.forEach((r) => {
    const e = out[nickKey(r.player) + "|" + (r.starts || "")];
    if (!e) stats.other++;
    else if (e.via === "roster") stats.roster++;
    else if (e.via === "sweep") stats.sweep++;
    else stats.teamOnly++;
  });
  // player-only fallback keys for players in exactly one bucket, so a row
  // whose starts string shifted (post-attach) still finds its attribution
  const bucketCount = {};
  cs2.forEach((r) => { const k = nickKey(r.player); bucketCount[k] = bucketCount[k] || new Set(); bucketCount[k].add(r.starts || ""); });
  Object.keys(out).forEach((key) => {
    const nkName = key.split("|")[0];
    if (bucketCount[nkName] && bucketCount[nkName].size === 1 && !out[nkName]) out[nkName] = out[key];
  });
  return { players: out, stats };
}
async function espCs2Attribution() {
  const row = await sbCacheRow("esports_cs2").catch(() => undefined);
  if (!row || !Array.isArray(row.props) || !row.props.length) return { ok: false, players: {}, stats: null };
  const rows = row.props;
  const fp = rows.length + ":" + (rows[0] ? rows[0].starts : "") + ":" + (rows[rows.length - 1] ? rows[rows.length - 1].starts : "") + ":" + (new Date(row.fetched_at).getTime() || 0);
  const mem = espMem["esp_attr_cs2"];
  if (mem && mem.data && mem.data.fp === fp && Date.now() - mem.ts < 30 * 60 * 1000) return mem.data;
  const sb = await espSbGet("esp_attr_cs2").catch(() => null);
  if (sb && sb.data && sb.data.fp === fp && Date.now() - sb.ts < 30 * 60 * 1000) { espMem["esp_attr_cs2"] = sb; return sb.data; }
  const computed = await espCs2AttrCompute(rows);
  const data = { ok: true, game: "cs2", fp, players: computed.players, stats: computed.stats };
  espMem["esp_attr_cs2"] = { ts: Date.now(), data };
  espSbPut("esp_attr_cs2", data).catch(() => {});
  return data;
}
async function espGradeCs2(slug, player, stat) {
  const kind = espStatKind(stat);
  if (!kind || (kind !== "k" && kind !== "hs")) return { final: false };
  const det = await bo3Detail(slug);
  if (!det) return { final: false };
  const scope = espScope(stat);
  const pk = nickKey(player);
  if (!pk) return { final: false };
  let total = 0, found = false;
  for (const m of det.maps) {
    const played = m.state === "done" || m.status === "finished";
    if (scope) {
      if (scope.indexOf(m.n) === -1) continue;
      // A scoped map that never played (2-0 series, "Map 3" leg) cannot be
      // resolved honestly — PrizePicks voids those; stay manual.
      if (!played) return { final: false };
    } else {
      if (!played) continue;
      if (det.state !== "post") return { final: false };
    }
    const st = await bo3GameStats(m.gameId, false);
    if (!st) return { final: false };
    const row = st.find((r) => nickKey(r.nick) === pk || nickKey(r.name) === pk);
    if (!row) return { final: false };
    total += kind === "hs" ? row.hs : row.k;
    found = true;
  }
  if (scope && det.state !== "post") {
    // Scoped legs still need every scoped map final; a live series with
    // both scoped maps done resolves early only when the match is over.
    const allDone = det.maps.filter((m) => scope.indexOf(m.n) > -1).every((m) => m.state === "done" || m.status === "finished");
    if (!allDone) return { final: false };
  }
  return found ? { final: true, value: total } : { final: false };
}
// ---------- Riot LoL Esports ----------
async function lolGw(path) { return espGet(LOL_GW + path, { "x-api-key": LOL_WEB_KEY }); }
function lolTeamNorm(t) {
  return { id: t.id || "", name: t.name || "", code: t.code || "", logo: t.image || "", wins: t.result ? t.result.gameWins : null, outcome: t.result ? (t.result.outcome || "") : "" };
}
async function espLolSchedule() {
  return espCached("esp_sched_lol", 120000, 900000, async () => {
    const out = { live: [], upcoming: [], finished: [] };
    const liveIds = {};
    const live = await lolGw("/getLive?hl=en-US");
    const liveEvs = ((((live || {}).data || {}).schedule || {}).events) || [];
    liveEvs.forEach((ev) => { if (ev && ev.match) liveIds[ev.match.id] = 1; });
    let events = [];
    let page = await lolGw("/getSchedule?hl=en-US");
    events = events.concat((((page || {}).data || {}).schedule || {}).events || []);
    let tok = page && page.data && page.data.schedule && page.data.schedule.pages && page.data.schedule.pages.newer;
    let hops = 0;
    while (tok && hops < 2) {
      const p2 = await lolGw("/getSchedule?hl=en-US&pageToken=" + encodeURIComponent(tok));
      const ev2 = (((p2 || {}).data || {}).schedule || {}).events || [];
      if (!ev2.length) break;
      events = events.concat(ev2);
      tok = p2.data.schedule.pages && p2.data.schedule.pages.newer;
      hops++;
    }
    liveEvs.forEach((ev) => { if (ev && ev.match && !events.some((e) => e.match && e.match.id === ev.match.id)) events.push(ev); });
    const now = Date.now();
    events.filter((ev) => ev && ev.type === "match" && ev.match && ev.match.id).forEach((ev) => {
      const n = { id: ev.match.id, starts: ev.startTime || "", state: ev.state || "", league: (ev.league && ev.league.name) || "", block: ev.blockName || "", bo: (ev.match.strategy && ev.match.strategy.count) || 0, teams: (ev.match.teams || []).map(lolTeamNorm) };
      if (liveIds[n.id] || ev.state === "inProgress") out.live.push(n);
      else if (ev.state === "unstarted") { if (!n.starts || new Date(n.starts).getTime() < now + 7 * 86400000) out.upcoming.push(n); }
      else if (ev.state === "completed") out.finished.push(n);
    });
    out.upcoming.sort((a, b) => new Date(a.starts) - new Date(b.starts));
    out.finished.sort((a, b) => new Date(b.starts) - new Date(a.starts));
    out.finished = out.finished.slice(0, 8);
    out.upcoming = out.upcoming.slice(0, 10);
    return out;
  }).catch(() => null);
}
// Freshest frame for a game in ONE call: the window feed returns ~10s of
// dense frames from startingTime, and any startingTime after the game has
// ended returns its FINAL frames (verified against GEN vs BLG 2026-11-14:
// final frame K2/D1/A13, CS 295 for Kiin). startingTime must sit on a
// round timestamp and the window must end >20s ago, so use now-30s
// quantized to 10s — for a live game that is also the freshest slice the
// feed will serve. Falls back to the opening chunk when the late window
// is empty (a game that just started).
async function lolGameFrames(gameId) {
  const t = new Date(Date.now() - 30000);
  t.setSeconds(Math.floor(t.getSeconds() / 10) * 10, 0);
  let w = await espGet(LOL_FEED + "/window/" + encodeURIComponent(gameId) + "?startingTime=" + encodeURIComponent(t.toISOString()));
  if (!w || !Array.isArray(w.frames) || !w.frames.length) w = await espGet(LOL_FEED + "/window/" + encodeURIComponent(gameId));
  if (!w || !Array.isArray(w.frames) || !w.frames.length) return null;
  const f = w.frames[w.frames.length - 1];
  return { frame: f, meta: w.gameMetadata || null, state: f.gameState || "" };
}
async function espLolMatch(id) {
  return espCached("esp_lolm_" + id, 60000, 3600000, async () => {
    const d = await lolGw("/getEventDetails?hl=en-US&id=" + encodeURIComponent(id));
    const ev = d && d.data && d.data.event;
    if (!ev || !ev.match) return null;
    const teams = (ev.match.teams || []).map(lolTeamNorm);
    const games = [];
    for (const g of (ev.match.games || [])) {
      const gm = { n: g.number, id: g.id, state: g.state, sides: (g.teams || []).map((t) => ({ id: t.id, side: t.side })) };
      if (g.state === "completed" || g.state === "inProgress") {
        const fr = await lolGameFrames(g.id).catch(() => null);
        if (fr) {
          gm.gameState = fr.state;
          const meta = fr.meta || {};
          if (meta.patchVersion) gm.patch = meta.patchVersion;
          const pmap = {};
          [meta.blueTeamMetadata, meta.redTeamMetadata].forEach((tm) => { ((tm && tm.participantMetadata) || []).forEach((pm) => { pmap[pm.participantId] = pm; }); });
          const teamIds = [meta.blueTeamMetadata && meta.blueTeamMetadata.esportsTeamId, meta.redTeamMetadata && meta.redTeamMetadata.esportsTeamId];
          gm.totals = [fr.frame.blueTeam, fr.frame.redTeam].map((tm) => tm ? { gold: tm.totalGold || 0, towers: tm.towers || 0, kills: tm.totalKills || 0, dragons: (tm.dragons || []).length, barons: tm.barons || 0 } : null);
          gm.players = [];
          [fr.frame.blueTeam, fr.frame.redTeam].forEach((tm, ix) => {
            ((tm && tm.participants) || []).forEach((pt) => {
              const pm = pmap[pt.participantId] || {};
              const full = pm.summonerName || "";
              gm.players.push({ name: full.replace(/^\S+\s+/, ""), full, champ: pm.championId || "", role: pm.role || "", teamId: teamIds[ix] || "", k: pt.kills || 0, d: pt.deaths || 0, a: pt.assists || 0, cs: pt.creepScore || 0, gold: pt.totalGold || 0, level: pt.level || 0 });
            });
          });
        }
      }
      games.push(gm);
    }
    // A series is final when a side's game wins pass half the best-of —
    // unplayed tail games (a 3-1 BO5's game 5) must not hold it "live".
    const boN = (ev.match.strategy && ev.match.strategy.count) || 0;
    const decided = teams.some((t) => t.wins != null && boN && t.wins > boN / 2);
    const state = decided ? "post" : (games.some((g) => g.state === "inProgress" || g.state === "completed") ? "in" : "pre");
    // Data Dragon version for champion portraits (free Riot CDN).
    const dd = await espCached("esp_ddver", 24 * 3600 * 1000, 7 * 86400000, async () => {
      const v = await espGet("https://ddragon.leagueoflegends.com/api/versions.json");
      return Array.isArray(v) && v.length ? v[0] : null;
    }).catch(() => null);
    return { game: "lol", id, league: (ev.league && ev.league.name) || "", block: "", state, bo: boN, ddver: dd || "", teams, games };
  }).catch(() => null);
}
async function espGradeLol(id, player, stat) {
  const kind = espStatKind(stat);
  if (!kind) return { final: false };
  const det = await espLolMatch(id);
  if (!det || det.state !== "post") return { final: false };
  const pk = nickKey(player);
  if (!pk) return { final: false };
  let total = 0, found = false;
  for (const g of det.games) {
    if (g.state === "inProgress") return { final: false };
    if (g.state !== "completed") continue; // unplayed tail games contribute nothing
    if (!g.players) return { final: false };
    const row = g.players.find((r) => nickKey(r.name) === pk || nickKey(r.full) === pk);
    if (!row) continue;
    total += kind === "k" ? row.k : kind === "d" ? row.d : kind === "a" ? row.a : row.cs;
    found = true;
  }
  return found ? { final: true, value: total } : { final: false };
}
async function espLane(req, res) {
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
  const mode = String(req.query.esports || "");
  try {
    if (mode === "schedule") {
      const both = await Promise.all([espCs2Schedule(), espLolSchedule()]);
      res.status(200).json({ ok: true, cs2: both[0] || { live: [], upcoming: [], finished: [] }, lol: both[1] || { live: [], upcoming: [], finished: [] } });
      return;
    }
    if (mode === "attribute") {
      const d = await espCs2Attribution();
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
      res.status(200).json(d);
      return;
    }
    if (mode === "match") {
      if (req.query.game === "lol") {
        const d = await espLolMatch(String(req.query.id || ""));
        res.status(200).json(d ? { ok: true, match: d } : { ok: false, error: "match unavailable" });
        return;
      }
      const d = await espCs2Match(String(req.query.slug || ""));
      res.status(200).json(d ? { ok: true, match: d } : { ok: false, error: "match unavailable" });
      return;
    }
    if (mode === "grade") {
      const player = String(req.query.player || ""), stat = String(req.query.stat || "");
      const out = req.query.game === "lol"
        ? await espGradeLol(String(req.query.id || ""), player, stat)
        : await espGradeCs2(String(req.query.slug || ""), player, stat);
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
      res.status(200).json({ ok: true, final: !!out.final, value: out.final ? out.value : null });
      return;
    }
  } catch (e) { res.status(200).json({ ok: false, error: String((e && e.message) || e) }); return; }
  res.status(400).json({ ok: false, error: "unknown esports mode" });
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=39600");
  // Score Agent Player Finder (2026-11-21): ESPN's teams-list endpoint
  // sends no CORS header, so the app cannot fetch it from the browser —
  // pass it through here. Rosters/bio/stats endpoints have CORS and the
  // client fetches those directly; only the teams list needs this lane.
  if (req.query && req.query.pfteams) {
    const pft = String(req.query.pfteams);
    if (!/^[a-z]+\/[\w.-]+$/.test(pft)) { res.status(400).json({ ok: false }); return; }
    try {
      const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/" + pft + "/teams" + (pft.indexOf("college") >= 0 ? "?limit=1000" : ""));
      if (!r.ok) { res.status(200).json({ sports: [] }); return; }
      const j = await r.json();
      res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
      res.status(200).json(j);
    } catch (e) { res.status(200).json({ sports: [] }); }
    return;
  }
  // Score Agent AI lane (Brandon 2026-11-21: all six AI features for every
  // user). Dormant until GEMINI_API_KEY (free) or OPENAI_API_KEY exists in Vercel env: the client
  // pings ?ai=ping and hides every AI surface while off. Generated blurbs
  // are cached in the shared props_cache (sport = "ai_<key>") so each one
  // is written ONCE and served to everyone; chat is per-user with a daily
  // cap counted in the same table.
  if (req.query && req.query.ai) { await aiLane(req, res); return; }
  // Esports lane first: it runs on free sources (bo3.gg / Riot feeds) and
  // the shared cache — it must answer even when no Parlay key is present.
  if (req.query && req.query.esports) { await espLane(req, res); return; }
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
    res.status(200).json({ ok: true, tally: true, day: todayT, cap: dailyCap(), totalToday: totalT, sports: sportsT, budget: DAILY_BUDGET, budgetUsed: totalT, newSportsOpen: budgetOpen(totalT) });
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
    if (FREE_ONLY_PULLS) {
      // Free-only mode (Brandon 2026-11-20): no paid break pull -- serve
      // the shared board as-is, else this instance's board, else empty.
      const sbBrk = await sbCacheRow(sport).catch(() => undefined);
      const sbBrkProps = sbBrk && Array.isArray(sbBrk.props) ? sbBrk.props : null;
      const brkProps = (sbBrkProps && sbBrkProps.length) ? sbBrkProps : (hit ? hit.props : []);
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60");
      res.status(200).json({ ok: true, configured: true, cached: true, brk: true, freeOnly: true, props: brkProps });
      return;
    }
    if (!(await gamesToday(sport)) || !brkBudgetOk(sport)) {
      if (hit) { res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60"); res.status(200).json({ ok: true, configured: true, cached: true, brk: true, props: hit.props }); return; }
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60");
      res.status(200).json({ ok: true, configured: true, brk: true, props: [] });
      return;
    }
    // Managed budget (Brandon 2026-11-19): the brk lane is a paid lane
    // too — new-sport keys ride it only while the day's booked total
    // leaves room under the soft budget; otherwise they serve the
    // cached board, exactly like the window-claim gate. When the
    // shared tally is unreadable the gate cannot be evaluated and the
    // lane fails open, like every other shared-store helper.
    if (isNewSport(sport)) {
      const usedBrk = await sbUsedToday();
      if (usedBrk !== null && !budgetOpen(usedBrk)) {
        if (hit) { res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60"); res.status(200).json({ ok: true, configured: true, cached: true, brk: true, props: hit.props }); return; }
        res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60");
        res.status(200).json({ ok: true, configured: true, brk: true, props: [] });
        return;
      }
    }
    try {
      if (!inflight[sport]) {
        noteBrk(sport); noteFetch(sport);
        inflight[sport] = fetchSport(sport, keys).finally(() => { delete inflight[sport]; });
      }
      const rows = await inflight[sport];
      const prev = prevFetch[sport];
      const fullProps = normalize(rows, true, sport);
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
      // A break pull that lands a FULLER board also refreshes the shared
      // cache, so every phone picks up the new slate on the normal lane
      // instead of only this instance's memory. The pull's credits are
      // added to the shared day tally so the count stays honest.
      try {
        const sbBefore = await sbCacheRow(sport);
        const playersOf = (arr) => new Set((Array.isArray(arr) ? arr : []).map((p) => p.player || p.name || "")).size;
        if (sbBefore !== undefined && playersOf(fullProps) > playersOf(sbBefore && sbBefore.props)) {
          await sbCachePut(sport, fullProps, 0, 0);
          const sbAfter = await sbCacheRow(sport);
          if (sbAfter && String(sbAfter.count_day || "") === etToday()) {
            await sbReq("props_cache?sport=eq." + encodeURIComponent(sport), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ credits_today: (sbAfter.credits_today | 0) + ((rows.pagesUsed || 1) * 3) }) });
          }
        }
      } catch (e) {}
      res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=120");
      res.status(200).json({ ok: true, configured: true, cached: false, brk: true, props });
    } catch (err) {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ ok: false, configured: true, brk: true, error: String((err && err.message) || err), props: hit ? hit.props : [] });
    }
    return;
  }
  if (cacheFresh(hit)) {
    if (hit.props.length && !hit.filled && !hit.espnFallback) {
      const fHit = await partialFill(sport, hit.props);
      if (fHit.filled) {
        stampSeen(sport, fHit.props);
        cache[sport] = { ts: Date.now(), props: fHit.props, pregameRefreshed: false, espnFallback: true, filled: true };
        res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
        res.status(200).json({ ok: true, configured: true, cached: true, partialFill: true, props: fHit.props });
        return;
      }
    }
    if (!hit.props.length) res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
    res.status(200).json({ ok: true, configured: true, cached: true, props: hit.props });
    return;
  }
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
  const tennisBlind = !gateOk && (sport === "tennis" || sport === "tennis_atp" || sport === "tennis_wta");
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
  if (FREE_ONLY_PULLS) {
    // Free-only mode (Brandon 2026-11-20): no window claim and no paid
    // fetch on any path below -- serve the shared board / in-memory
    // board / free ESPN fallback exactly like the stale path does when
    // a pull is not allowed. Esports props ride this same lane, so they
    // serve their cached boards too; the free esports lane above is
    // untouched and stays fully live.
    await serveStaleOrFallback(res, sport, hit, sbRow === undefined ? null : sbRow);
    return;
  }
  let sbClaimed = null;
  if (sbRow !== undefined) {
    if (sbRow && sbFresh(sbRow)) {
      const sp = Array.isArray(sbRow.props) ? sbRow.props : [];
      if (sp.length) {
        const fShared = await partialFill(sport, sp);
        if (fShared.filled) {
          stampSeen(sport, fShared.props);
          cache[sport] = { ts: Date.now(), props: fShared.props, pregameRefreshed: false, espnFallback: true, filled: true };
          res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
          res.status(200).json({ ok: true, configured: true, cached: true, shared: true, partialFill: true, props: fShared.props });
          return;
        }
      }
      cache[sport] = { ts: new Date(sbRow.fetched_at).getTime(), props: sp, pregameRefreshed: true };
      if (!sp.length) res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
      res.status(200).json({ ok: true, configured: true, cached: true, shared: true, props: sp });
      return;
    }
    const slot = etSlot();
    const slotUsed = !!(sbRow && slot > 0 && String(sbRow.count_day || "") === etToday() && (sbRow.last_slot | 0) >= slot);
    if (slot === 0 || slotUsed) { await serveStaleOrFallback(res, sport, hit, sbRow); return; }
    const usedToday = (await sbUsedToday()) || 0;
    if (usedToday + 6 > 100) { await serveStaleOrFallback(res, sport, hit, sbRow); return; } // hard stop 100; the 50 cap is the notify line (dailyCap, reported in the tally) — Brandon approved going over when needed
    // Managed budget (Brandon 2026-11-19): new sports fill in only
    // while the day's budget leaves room — over the soft line they
    // serve their cached board this window instead of claiming a pull.
    // Core sports are never budget-gated.
    if (isNewSport(sport) && !budgetOpen(usedToday)) { await serveStaleOrFallback(res, sport, hit, sbRow); return; }
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
    let props = normalize(rows, false, sport);
    const parlayProps = props;
    let espnFb = false;
    if (!props.length) {
      const fb = await espnFallback(sport, "pre").catch(() => []);
      if (fb.length) { props = fb; espnFb = true; }
    }
    // Partial-board fill: a non-empty pull can still be a partial slate
    // (see partialFill). The shared cache below still stores parlayProps
    // (the pure Parlay board); only the served/cached board is merged.
    let filled = false;
    if (props.length && !espnFb) {
      const fFresh = await partialFill(sport, props);
      if (fFresh.filled) { props = fFresh.props; filled = true; }
    }
    prevFetch[sport] = { ts: Date.now(), keys: new Set(normalize(rows, true, sport).map(rowKey)) };
    // Retention: the feed has already dropped started games, so carry
    // their props forward from the previous board (shared row when the
    // shared store is in play, else this instance's last board).
    const prevBoard = (sbRow && Array.isArray(sbRow.props) && sbRow.props) || (hit && hit.props) || [];
    props = mergeRetained(prevBoard, props);
    stampSeen(sport, props);
    const wasPregame = !!(hit && Date.now() - hit.ts < DAY_TTL);
    cache[sport] = { ts: Date.now(), props, pregameRefreshed: wasPregame, espnFallback: espnFb || filled, filled };
    if (sbClaimed) { await sbCachePut(sport, parlayProps, ((rows.pagesUsed || 1) * 3), sbClaimed.reserved); sbClaimed = null; }
    if (!props.length || espnFb || filled) res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300"); res.status(200).json({ ok: true, configured: true, cached: false, fallback: espnFb ? "espn" : undefined, partialFill: filled ? true : undefined, props });
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
