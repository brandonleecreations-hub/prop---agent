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
function statFor(summary, leg) {
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
      const title = "Your Prop Agent ticket starts soon";
      const body = (firstLeg.player ? firstLeg.player + " " + (firstLeg.dir || "") + " " + firstLeg.line + " " + firstLeg.stat + " \u2014 " : "") + "first game starts " + (when || "shortly") + ". " + legs.length + (legs.length === 1 ? " pick" : " picks") + " on this ticket.";
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
    async function gradeLeg(leg) {
      // -> { final:bool, hit:bool|null, actual:number|null }
      if (!leg || leg.custom || !leg.starts || !LEAGUES[leg.league]) return { final: false };
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
        if (actual == null) { if (ev) return { final: state === "post" }; continue; }
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
        const title = result === "win" ? "Your Prop Agent ticket WON" : "Your Prop Agent ticket missed";
        const body = result === "win"
          ? "Every leg hit. Open the app to see your ticket and cards."
          : (missedLeg ? (missedLeg.player + " " + missedLeg.stat + " " + missedLeg.line + " finished at " + missedActual + " — ticket missed.") : "One leg missed. Open the app for details.");
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
    res.status(200).json(report);
  } catch (e) {
    report.ok = false; report.error = String((e && e.message) || e);
    res.status(200).json(report);
  }
};
