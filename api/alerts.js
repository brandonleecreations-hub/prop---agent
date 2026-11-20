// Prop Agent — closed-app alerts: ticket-start reminders + win/loss results.
// Grades pending Supabase tickets against final ESPN box scores and sends a
// web-push to the owner's saved subscriptions when a ticket settles.
// Triggered on a schedule by Muse's checker (Vercel Hobby crons are
// daily-only). Idempotent: a ticket is only pushed on the pending -> win/loss
// transition, and legs[0].__alerted stamps the ticket once alerted.
//   GET /api/alerts          grade + push
//   GET /api/alerts?dry=1    grade + report only (no writes, no pushes)
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/";
const LEAGUES = {
  nba: ["basketball", "nba"], nfl: ["football", "nfl"], cfb: ["football", "college-football"],
  cbb: ["basketball", "mens-college-basketball"], wbb: ["basketball", "womens-college-basketball"],
  wnba: ["basketball", "wnba"], nhl: ["hockey", "nhl"], mlb: ["baseball", "mlb"],
  tennis: ["tennis", "atp"],
};

function sbHeaders(extra) {
  return Object.assign({ apikey: SRK, Authorization: "Bearer " + SRK, "Content-Type": "application/json" }, extra || {});
}
async function rest(path, opts) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, opts);
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
  return { status: r.status, json: j, text: txt };
}
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("fetch " + r.status);
  return r.json();
}
function etYmd(iso) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)).replace(/-/g, "");
  } catch (e) { return null; }
}
function surname(name) { const p = String(name || "").trim().split(/\s+/); return (p[p.length - 1] || "").toLowerCase(); }
// Stat-name parity with the app (index.html findLiveStat / liveStatFor /
// gcCanonStat): Parlay stat names are words ("Points", "Passing Yards")
// while ESPN box-score labels are terse ("PTS", "C/ATT"), so the generic
// substring match below misses core stats — most notably basketball
// "Points", which matched nothing and left legs final-with-no-verdict.
// The dictionary resolves first; the generic match stays as a fallback so
// nothing that resolved before stops resolving.
const STAT_ALIAS = { "Blocked Shots": "Blocks", "3-PT Made": "3-Pointers Made" };
const STAT_CANON = {
  "passing touchdowns": "Passing TDs", "rushing touchdowns": "Rushing TDs", "receiving touchdowns": "Receiving TDs",
  "pass completions": "Completions", "passing attempts": "Pass Attempts", "pass attempts": "Pass Attempts",
  "field goals made": "FG Made", "fg made": "FG Made", "field goals attempted": "FG Attempted", "fg attempted": "FG Attempted",
  "3-pointers made": "3-Pointers Made", "3-pointers attempted": "3-PT Attempted",
  "blocked shots": "Blocks", "tackles plus assists": "Tackles+Assists", "tackles+assists": "Tackles+Assists",
  "shots on goal": "Shots on Goal",
};
function canonStat(stat) {
  const s = String(stat || "").replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  const hit = STAT_CANON[s.toLowerCase()];
  if (hit) return hit;
  return s.replace(/\s+plus\s+/gi, "+").replace(/\s*\+\s*/g, "+");
}
const COMBO_PARTS = { pts: "Points", point: "Points", points: "Points", reb: "Rebounds", rebs: "Rebounds", rebounds: "Rebounds", ast: "Assists", asts: "Assists", assists: "Assists", stl: "Steals", stls: "Steals", steals: "Steals", blk: "Blocks", blks: "Blocks", blocks: "Blocks",
  "passing yards": "Passing Yards", "rushing yards": "Rushing Yards", "receiving yards": "Receiving Yards",
  passing: "Passing Yards", rushing: "Rushing Yards", receiving: "Receiving Yards",
  pass: "Passing Yards", rush: "Rushing Yards", rec: "Receiving Yards",
  "pass yards": "Passing Yards", "rush yards": "Rushing Yards", "rec yards": "Receiving Yards" };
function surOf(name) { const p = String(name || "").trim().split(/\s+/); return (p[p.length - 1] || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function athleteDicts(summary, leg) {
  // Per-stat-group stat dicts for the leg's player, mirroring the app's
  // findLiveStat collection: exact athlete (id or full name) first, and a
  // surname match only when exactly one athlete in the box score has it.
  const groups = [];
  ((summary && summary.boxscore && summary.boxscore.players) || []).forEach((tp) => { (tp.statistics || []).forEach((g) => { groups.push(g); }); });
  const rawD = [];
  groups.forEach((g) => {
    const cols = g.labels || g.names || [];
    (g.athletes || []).forEach((a) => {
      const nm = (a.athlete && a.athlete.displayName) || "";
      const d = { __names: cols.join(","), __nm: nm, __id: (a.athlete && a.athlete.id) || "" };
      cols.forEach((n, i) => { d[n] = (a.stats || [])[i]; });
      rawD.push(d);
    });
  });
  let dicts = rawD.filter((d) => (leg.athleteId && String(d.__id) === String(leg.athleteId)) || d.__nm.toLowerCase() === String(leg.player || "").toLowerCase());
  if (!dicts.length) {
    const sur = {};
    rawD.forEach((d) => { if (surOf(d.__nm) === surOf(leg.player)) sur[d.__nm.toLowerCase()] = 1; });
    if (Object.keys(sur).length === 1) dicts = rawD.filter((d) => surOf(d.__nm) === surOf(leg.player));
  }
  return dicts;
}
function statFromDicts(dicts, stat) {
  // Verbatim branch chain from the app's findLiveStat.
  const num = (x) => { const v = parseFloat(x); return isFinite(v) ? v : null; };
  const made = (x) => { if (x == null) return null; const parts = String(x).split(/[\/-]/); return num(parts[0]); };
  const att = (x) => { if (x == null) return null; const parts = String(x).split(/[\/-]/); return parts.length === 2 ? num(parts[1]) : null; };
  const toi = (x) => { if (x == null) return null; const m = String(x).match(/^(\d+):([0-5]\d)$/); if (m) return Math.round((parseInt(m[1], 10) + parseInt(m[2], 10) / 60) * 10) / 10; return num(x); };
  for (const d of dicts) {
    let v = null;
    const pass = d.__names.indexOf("C/ATT") > -1, rush = d.__names.indexOf("CAR") > -1, recv = d.__names.indexOf("TGTS") > -1, def = d.__names.indexOf("TOT") > -1, kick = d.__names.indexOf("XP") > -1;
    if (stat === "Points") { v = num(d.PTS != null ? d.PTS : d.P); if (v == null && d.G != null && d.A != null) { const pg = num(d.G), pa2 = num(d.A); if (pg != null && pa2 != null) v = pg + pa2; } }
    else if (stat === "Rebounds") v = num(d.REB);
    else if (stat === "Offensive Rebounds") v = num(d.OREB);
    else if (stat === "Defensive Rebounds") v = num(d.DREB);
    else if (stat === "Assists") { v = num(d.AST != null ? d.AST : d.A); if (v == null && def) { const tt = num(d.TOT), so = num(d.SOLO); if (tt != null && so != null) v = tt - so; } }
    else if (stat === "Steals") v = num(d.STL);
    else if (stat === "Blocks") v = num(d.BLK != null ? d.BLK : d.BS);
    else if (stat === "Turnovers") v = num(d.TO);
    else if (stat === "Personal Fouls") v = num(d.PF);
    else if (stat === "Minutes") v = num(d.MIN);
    else if (stat === "Plus/Minus") v = num(d["+/-"]);
    else if (stat === "3-Pointers Made" || stat === "3-PT Made") v = made(d["3PT"]);
    else if (stat === "3-PT Attempted" || stat === "3-Pointers Attempted") v = att(d["3PT"]);
    else if (stat === "FG Made") v = made(d.FG);
    else if (stat === "FG Attempted") v = att(d.FG);
    else if (stat === "Free Throws Made") v = made(d.FT);
    else if (stat === "Free Throws Attempted") v = att(d.FT);
    else if (stat === "Two Pointers Made") { const fm = made(d.FG), tm = made(d["3PT"]); if (fm != null && tm != null) v = fm - tm; }
    else if (stat === "Two Pointers Attempted") { const fa = att(d.FG), ta = att(d["3PT"]); if (fa != null && ta != null) v = fa - ta; }
    else if (stat === "Double-Double") { if (num(d.PTS) != null) { const cats = [d.PTS, d.REB, d.AST, d.STL, d.BLK]; let c2 = 0; cats.forEach((x) => { const n2 = num(x); if (n2 != null && n2 >= 10) c2++; }); v = c2 >= 2 ? 1 : 0; } }
    else if (stat === "Goals") v = num(d.G);
    else if (stat === "Shots on Goal") v = num(d.SOG);
    else if (stat === "Saves") v = num(d.SV);
    else if (stat === "Hits") v = num(d.HT);
    else if (stat === "Faceoffs Won") v = num(d.FW);
    else if (stat === "Time On Ice") v = toi(d.TOI);
    else if (stat === "Passing Yards" && pass) v = num(d.YDS);
    else if (stat === "Passing TDs" && pass) v = num(d.TD);
    else if (stat === "Completions" && pass) v = made(d["C/ATT"]);
    else if (stat === "Pass Attempts" && pass) v = att(d["C/ATT"]);
    else if (stat === "Passing Interceptions" && pass) v = num(d.INT);
    else if (stat === "Longest Passing Completion" && pass) v = num(d.LONG);
    else if (stat === "Rushing Yards" && rush) v = num(d.YDS);
    else if (stat === "Rushing TDs" && rush) v = num(d.TD);
    else if (stat === "Carries" && rush) v = num(d.CAR);
    else if (stat === "Longest Rush" && rush) v = num(d.LONG);
    else if (stat === "Receiving Yards" && recv) v = num(d.YDS);
    else if (stat === "Receiving TDs" && recv) v = num(d.TD);
    else if (stat === "Receptions" && recv) v = num(d.REC);
    else if (stat === "Longest Reception" && recv) v = num(d.LONG);
    else if (stat === "Targets" && recv) v = num(d.TGTS);
    else if (stat === "Tackles" && def) v = num(d.SOLO);
    else if (stat === "Tackles+Assists" && def) v = num(d.TOT);
    else if (stat === "Sacks" && def) v = num(d.SACKS);
    else if (stat === "Extra Points Made" && kick) v = made(d.XP);
    else if (stat === "Kicking Points" && kick) v = num(d.PTS);
    if (v != null) return v;
  }
  return null;
}
function statFor(summary, leg) {
  if (!summary || !leg) return null;
  if (String(leg.player || "").indexOf("+") > -1) return null; // combo-player legs name no real athlete (app parity)
  const dicts = athleteDicts(summary, leg);
  if (dicts.length) {
    const stat = canonStat(STAT_ALIAS[leg.stat] || leg.stat);
    let v = statFromDicts(dicts, stat);
    if (v == null && /anytime tds/i.test(stat)) {
      // "Anytime Tds": sum the TD entries across the player's own stat
      // groups — the same derivation the app uses for display.
      let sum = 0, any = false;
      dicts.forEach((d) => { const n = parseFloat(d.TD); if (isFinite(n)) { sum += n; any = true; } });
      if (any) v = sum;
    }
    if (v == null && stat.indexOf("+") > -1) {
      const parts = stat.split("+");
      let sum = 0, okCombo = parts.length > 1;
      for (const part of parts) {
        const canon = COMBO_PARTS[part.trim().toLowerCase()];
        if (!canon) { okCombo = false; break; }
        const pv = statFromDicts(dicts, canon);
        if (pv == null) { okCombo = false; break; }
        sum += pv;
      }
      if (okCombo) v = sum;
    }
    if (v != null) return v;
  }
  return statForGeneric(summary, leg);
}
function statForGeneric(summary, leg) {
  // Mirrors the app's findLiveStat: locate the player in the box score and
  // pull the numeric stat whose label matches the prop's stat name.
  const boxes = (summary && summary.boxscore && summary.boxscore.players) || [];
  const want = String(leg.stat || "").toLowerCase();
  for (const teamBox of boxes) {
    for (const group of teamBox.statistics || []) {
      const labels = (group.labels || []).map((x) => String(x).toLowerCase());
      const names = (group.names || []).map((x) => String(x).toLowerCase());
      let idx = labels.findIndex((l) => want.indexOf(l) > -1 || l.indexOf(want) > -1);
      if (idx < 0) idx = names.findIndex((l) => want.indexOf(l) > -1);
      for (const a of group.athletes || []) {
        const nm = (a.athlete && a.athlete.displayName) || "";
        const match = (leg.athleteId && a.athlete && String(a.athlete.id) === String(leg.athleteId)) || surname(nm) === surname(leg.player) && nm.toLowerCase().indexOf(surname(leg.player)) > -1;
        if (!match) continue;
        if (idx < 0) return null;
        const raw = (a.stats || [])[idx];
        const v = parseFloat(String(raw == null ? "" : raw).split("/")[0]);
        return isNaN(v) ? null : v;
      }
    }
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const dry = !!(req.query && req.query.dry);
  if (!SB_URL || !SRK) { res.status(200).json({ ok: false, configured: false }); return; }
  const report = { ok: true, dry, pending: 0, finalized: 0, pushed: 0, skipped: 0, startEligible: 0, startPushed: 0, errors: [] };
  try {
    const tix = await rest("tickets?select=id,user_id,legs,created_at&status=eq.pending&order=created_at.asc&limit=100", { headers: sbHeaders() });
    const rows = Array.isArray(tix.json) ? tix.json : [];
    report.pending = rows.length;
    const subsRes = await rest("push_subscriptions?select=id,user_id,endpoint,p256dh,auth&limit=500", { headers: sbHeaders() });
    const subsByUser = {};
    (Array.isArray(subsRes.json) ? subsRes.json : []).forEach((s) => {
      (subsByUser[s.user_id] = subsByUser[s.user_id] || []).push(s);
    });

    let webpush = null;
    const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY, subj = process.env.VAPID_SUBJECT;
    if (pub && priv && subj) {
      try { webpush = require("web-push"); webpush.setVapidDetails(subj, pub, priv); } catch (e) { webpush = null; }
    }

    // ---- Ticket-start alerts: one push shortly before a ticket's first game.
    // Eligible when the earliest leg starts within the next 30 minutes (the
    // checker runs every 15 min, so users get roughly a 15-30 min heads-up).
    // Stamped once via legs[0].__startAlerted so it can never fire twice.
    const nowMs = Date.now();
    for (const row of rows) {
      const legs = Array.isArray(row.legs) ? row.legs : [];
      if (!legs.length || !legs[0] || legs[0].__startAlerted) continue;
      const starts = legs.map((l) => new Date((l && l.starts) || 0).getTime()).filter(Boolean);
      if (!starts.length) continue;
      const first = Math.min.apply(null, starts);
      if (first < nowMs - 5 * 60000 || first > nowMs + 30 * 60000) continue;
      report.startEligible++;
      const userSubs = subsByUser[row.user_id] || [];
      if (!userSubs.length || !webpush) continue;
      if (!dry) {
        const stamped = legs.map((l, i) => i === 0 ? Object.assign({}, l, { __startAlerted: first }) : l);
        await rest("tickets?id=eq." + row.id, { method: "PATCH", headers: sbHeaders({ Prefer: "return=minimal" }), body: JSON.stringify({ legs: stamped }) });
        row.legs = stamped;
      }
      const firstLeg = legs.find((l) => new Date((l && l.starts) || 0).getTime() === first) || legs[0];
      let when = "";
      try { when = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(first)) + " ET"; } catch (e) {}
      const title = "⏰ Almost game time!";
      const body = (firstLeg.player ? firstLeg.player + " " + (firstLeg.dir || "") + " " + firstLeg.line + " " + firstLeg.stat + " \u2014 " : "") + "starts at " + (when || "soon") + ". Your " + legs.length + "-pick ticket is about to ride. Good luck! 🍀";
      for (const s of userSubs) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title, body, url: "/" }));
          report.startPushed++;
        } catch (e) {
          if (e && (e.statusCode === 404 || e.statusCode === 410)) {
            if (!dry) await rest("push_subscriptions?id=eq." + s.id, { method: "DELETE", headers: sbHeaders({ Prefer: "return=minimal" }) });
          } else if (report.errors.length < 5) report.errors.push(String((e && e.message) || e).slice(0, 120));
        }
      }
    }

    const sbCache = {}, sumCache = {};
    let sumFetches = 0;
    async function scoreboard(lg, ymd) {
      const k = lg + "|" + ymd;
      if (!(k in sbCache)) {
        const L = LEAGUES[lg]; if (!L) { sbCache[k] = []; return sbCache[k]; }
        try { const j = await getJson(ESPN + L[0] + "/" + L[1] + "/scoreboard?dates=" + ymd + "&limit=100"); sbCache[k] = j.events || []; }
        catch (e) { sbCache[k] = []; }
      }
      return sbCache[k];
    }
    async function summary(lg, eventId) {
      const k = lg + "|" + eventId;
      if (!(k in sumCache)) {
        if (sumFetches >= 40) { sumCache[k] = null; return null; }
        sumFetches++;
        const L = LEAGUES[lg];
        try { sumCache[k] = await getJson(ESPN + L[0] + "/" + L[1] + "/summary?event=" + eventId); }
        catch (e) { sumCache[k] = null; }
      }
      return sumCache[k];
    }

    // ---- Esports legs (Brandon 2026-11-19): CS2 legs resolve from
    // bo3.gg's final per-map player stats — the same source and map-scope
    // rules as the app (/api/props?esports=grade). Anything that cannot
    // be resolved returns { final:false } so the ticket stays PENDING and
    // settles on the owner's manual stepper — never an auto-loss (the
    // v1.0.57 unresolved rule). LoL legs stay on that floor until Parlay
    // posts LoL props.
    function espNickKey(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
    async function gradeEsportsLeg(leg) {
      try {
        if (!leg || !leg.player || !leg.stat) return { final: false };
        const espRef = String(leg.eventId || "");
        const espCi = espRef.indexOf(":");
        if (espCi <= 0 || espRef.slice(0, espCi) !== "cs2") return { final: false };
        const espSlug = espRef.slice(espCi + 1);
        const stat = String(leg.stat);
        const kind = /headshot/i.test(stat) ? "hs" : (/kill/i.test(stat) ? "k" : "");
        if (!kind) return { final: false };
        let scope = null;
        if (/maps?\s*1\s*[-\u2013]\s*2/i.test(stat)) scope = [1, 2];
        else { const mm = /map\s*(\d)/i.exec(stat); if (mm) scope = [parseInt(mm[1], 10)]; }
        const det = await getJson("https://api.bo3.gg/api/v1/matches/" + encodeURIComponent(espSlug) + "?with=games");
        if (!det || !det.id) return { final: false };
        const fin = det.status === "finished" || det.status === "defwin";
        const games = (Array.isArray(det.games) ? det.games : []).slice().sort((a, b) => (a.number || 0) - (b.number || 0));
        const pk = espNickKey(leg.player);
        if (!pk || !games.length) return { final: false };
        let total = 0, found = false;
        for (const g of games) {
          const played = g.state === "done" || g.status === "finished";
          if (scope) {
            if (scope.indexOf(g.number || 0) === -1) continue;
            if (!played) return { final: false }; // scoped map never played / not final: stay pending
          } else {
            if (!played) continue;
            if (!fin) return { final: false };
          }
          const rows = await getJson("https://api.bo3.gg/api/v1/games/" + g.id + "/players_stats");
          const list = Array.isArray(rows) ? rows : (rows && Array.isArray(rows.results) ? rows.results : null);
          if (!list || !list.length) return { final: false };
          const row = list.find((r) => {
            const sp = r.steam_profile || {}, pl = sp.player || {};
            const full = ((pl.first_name || "") + " " + (pl.last_name || "")).trim();
            return espNickKey(sp.nickname || pl.nickname || "") === pk || espNickKey(full) === pk;
          });
          if (!row) return { final: false };
          total += kind === "hs" ? (row.headshots || 0) : (row.kills || 0);
          found = true;
        }
        if (!found) return { final: false };
        if (scope && !fin) {
          const allDone = games.filter((g) => scope.indexOf(g.number || 0) > -1).every((g) => g.state === "done" || g.status === "finished");
          if (!allDone) return { final: false };
        }
        const hit = leg.dir === "LESS" ? total < leg.line : total > leg.line;
        const push = total === leg.line;
        return { final: true, hit: hit || push, push, actual: total };
      } catch (e) { return { final: false }; }
    }
    async function gradeLeg(leg) {
      // -> { final:bool, hit:bool|null, actual:number|null, unresolved:bool }
      if (!leg || leg.custom) return { final: false };
      if (leg.league === "esports") return gradeEsportsLeg(leg);
      if (!leg.starts || !LEAGUES[leg.league]) return { final: false };
      if (leg.league === "tennis") return { final: false }; // tennis stats aren't in the box-score map
      const ymd = etYmd(leg.starts); if (!ymd) return { final: false };
      const events = await scoreboard(leg.league, ymd);
      let ev = null;
      if (leg.eventId) ev = events.find((e) => String(e.id) === String(leg.eventId)) || null;
      if (!ev && leg.team) {
        ev = events.find((e) => {
          const cs = (e.competitions && e.competitions[0] && e.competitions[0].competitors) || [];
          return cs.some((c) => c.team && (c.team.displayName === leg.team || c.team.shortDisplayName === leg.team));
        }) || null;
      }
      const candidates = ev ? [ev] : events;
      for (const cand of candidates) {
        const sum = await summary(leg.league, cand.id);
        if (!sum) continue;
        const state = sum.header && sum.header.competitions && sum.header.competitions[0] && sum.header.competitions[0].status && sum.header.competitions[0].status.type && sum.header.competitions[0].status.type.state;
        const actual = statFor(sum, leg);
        if (actual == null) { if (ev) return { final: false, unresolved: state === "post" }; continue; }
        if (state !== "post") return { final: false, actual };
        const hit = leg.dir === "LESS" ? actual < leg.line : actual > leg.line;
        const push = actual === leg.line;
        return { final: true, hit: hit || push, push, actual };
      }
      return { final: false };
    }

    for (const row of rows) {
      const legs = Array.isArray(row.legs) ? row.legs : [];
      if (!legs.length || !legs[0] || legs[0].__alerted) { report.skipped++; continue; }
      if (legs.some((l) => !l || l.custom)) { report.skipped++; continue; }
      const starts = legs.map((l) => new Date(l.starts || 0).getTime()).filter(Boolean);
      if (!starts.length || Math.max.apply(null, starts) > Date.now() - 100 * 60000) { report.skipped++; continue; }
      let result = null, missedLeg = null, missedActual = null;
      let allFinal = true;
      for (const leg of legs) {
        const g = await gradeLeg(leg);
        if (!g.final) { allFinal = false; continue; }
        if (g.hit === false) { result = "loss"; missedLeg = leg; missedActual = g.actual; break; }
      }
      if (!result && allFinal) result = "win";
      if (!result) { report.skipped++; continue; }
      report.finalized++;
      const userSubs = subsByUser[row.user_id] || [];
      if (!dry) {
        const stamped = legs.map((l, i) => i === 0 ? Object.assign({}, l, { __alerted: result }) : l);
        await rest("tickets?id=eq." + row.id, { method: "PATCH", headers: sbHeaders({ Prefer: "return=minimal" }), body: JSON.stringify({ status: result, legs: stamped }) });
      }
      if (webpush && userSubs.length) {
        const title = result === "win" ? "🎉 Ticket WON — every leg hit!" : "Ticket missed — shake it off";
        const body = result === "win"
          ? "Beautiful picking, Agent. Open the app to see your ticket and check for new cards you unlocked."
          : (missedLeg ? (missedLeg.player + " " + missedLeg.stat + " " + missedLeg.line + " landed on " + missedActual + " — that leg came up short. The next board is already up when you are.") : "One leg came up short this time. Fresh props are already posting — go get the next one.");
        for (const s of userSubs) {
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title, body, url: "/" }));
            report.pushed++;
          } catch (e) {
            if (e && (e.statusCode === 404 || e.statusCode === 410)) {
              if (!dry) await rest("push_subscriptions?id=eq." + s.id, { method: "DELETE", headers: sbHeaders({ Prefer: "return=minimal" }) });
            } else if (report.errors.length < 5) report.errors.push(String((e && e.message) || e).slice(0, 120));
          }
        }
      }
    }
    // ---- Clash re-engagement: one push when an agent hasn't clashed in 3+
    // days (at most one per user per 7 days). Needs profiles.clash_last and
    // profiles.clash_reminded; fails open when the columns aren't there yet.
    report.clashReminded = 0;
    try {
      if (webpush && !dry) {
        const cp = await rest("profiles?select=id,clash_last,clash_reminded&clash_last=gt.0&limit=500", { headers: sbHeaders() });
        const crows = Array.isArray(cp.json) ? cp.json : [];
        for (const p of crows) {
          const last = Number(p.clash_last) || 0;
          const reminded = Number(p.clash_reminded) || 0;
          if (!last || nowMs - last < 3 * 86400000) continue;
          if (reminded && nowMs - reminded < 7 * 86400000) continue;
          const userSubs = subsByUser[p.id] || [];
          if (!userSubs.length) continue;
          let sent = false;
          for (const s of userSubs) {
            try {
              await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: "\u2694\uFE0F Your agents are waiting!", body: "It's been a few days since your last Agent Clash. Jump back in, tier up your cards and chase THE RING \uD83D\uDC8D \u2014 one of a kind.", url: "/" }));
              sent = true; report.pushed++;
            } catch (e) {
              if (e && (e.statusCode === 404 || e.statusCode === 410)) {
                await rest("push_subscriptions?id=eq." + s.id, { method: "DELETE", headers: sbHeaders({ Prefer: "return=minimal" }) });
              } else if (report.errors.length < 5) report.errors.push(String((e && e.message) || e).slice(0, 120));
            }
          }
          if (sent) {
            report.clashReminded++;
            try { await rest("profiles?id=eq." + p.id, { method: "PATCH", headers: sbHeaders({ Prefer: "return=minimal" }), body: JSON.stringify({ clash_reminded: nowMs }) }); } catch (e) {}
          }
        }
      }
    } catch (e) { /* clash reminders fail open */ }
    res.status(200).json(report);
  } catch (e) {
    report.ok = false; report.error = String((e && e.message) || e);
    res.status(200).json(report);
  }
};
