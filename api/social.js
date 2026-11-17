// Prop Agent — social: follows, public picks, ticket likes (Supabase,
// service role key server-side only). Identity is the app's cloud uid.
//   GET  ?state=1&uid=ME            -> { following:[ids], followers:n }
//   GET  ?counts=1                  -> { counts:{ profileId: followerCount } }
//   GET  ?picks=TARGET&me=ME        -> { profile, tickets:[{id,user_id,status,
//                                        created_at,legs,likes,likedByMe}] }
//   GET  ?feed=1&uid=ME             -> { items:[{owner, ticket}] } latest
//                                      tickets from agents ME follows
//   GET  ?top=1&me=ME               -> { ticket, owner } most-liked finished
//                                      public ticket (or ticket:null)
//   POST {uid, action:"follow"|"unfollow", target}
//   POST {uid, action:"like"|"unlike", ticketId}
// Likes live on the ticket row itself: legs[0].__likedBy / __likes (the
// profile sync carries them over by leg fingerprint, see api/profile.js).
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function sbHeaders(extra) {
  return Object.assign(
    { apikey: SRK, Authorization: "Bearer " + SRK, "Content-Type": "application/json" },
    extra || {}
  );
}
async function rest(path, opts) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, opts);
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
  return { status: r.status, json: j, text: txt };
}
function likesOf(legs) {
  return (Array.isArray(legs) && legs[0] && typeof legs[0].__likes === "number") ? legs[0].__likes : 0;
}
function likedByOf(legs) {
  return (Array.isArray(legs) && legs[0] && Array.isArray(legs[0].__likedBy)) ? legs[0].__likedBy : [];
}
function cleanLegs(legs) {
  return (Array.isArray(legs) ? legs : []).map((l) => {
    const o = {};
    Object.keys(l || {}).forEach((k) => { if (k.indexOf("__") !== 0) o[k] = l[k]; });
    return o;
  });
}
function shapeTicket(t, me) {
  return {
    id: t.id, user_id: t.user_id, status: t.status, created_at: t.created_at,
    legs: cleanLegs(t.legs), likes: likesOf(t.legs),
    likedByMe: !!me && likedByOf(t.legs).indexOf(me) > -1,
  };
}
const PROF_SEL = "id,display_name,wins,avatar_url,featured_card";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!SB_URL || !SRK) { res.status(200).json({ ok: false, configured: false }); return; }
  try {
    if (req.method === "GET" && req.query && req.query.username !== undefined) {
      const name = String(req.query.username || "");
      const me = String(req.query.me || "");
      if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) { res.status(200).json({ ok: true, available: false, reason: "format" }); return; }
      const cand = await rest("profiles?select=id,display_name&display_name=ilike." + encodeURIComponent(name), { headers: sbHeaders() });
      const taken = Array.isArray(cand.json) && cand.json.some((r) => r.id !== me && String(r.display_name).toLowerCase() === name.toLowerCase());
      res.status(200).json({ ok: true, available: !taken, reason: taken ? "taken" : "" });
      return;
    }
    if (req.method === "GET" && req.query && req.query.streaks) {
      const b = await rest("profiles?select=id&order=wins.desc&limit=50", { headers: sbHeaders() });
      const ids = Array.isArray(b.json) ? b.json.map((r) => r.id) : [];
      const out = {};
      if (ids.length) {
        const t = await rest("tickets?select=user_id,status,created_at,legs&user_id=in.(" + ids.join(",") + ")&status=in.(win,loss)&order=created_at.desc&limit=1000", { headers: sbHeaders() });
        const byUser = {};
        if (Array.isArray(t.json)) t.json.forEach((r) => { (byUser[r.user_id] = byUser[r.user_id] || []).push(r.status === "win" && Array.isArray(r.legs) && r.legs.some((l) => l && l.custom) ? "skip" : r.status); });
        ids.forEach((id) => { const arr = byUser[id] || []; let n = 0; for (let i = 0; i < arr.length; i++) { if (arr[i] === "skip") continue; if (arr[i] === "win") n++; else break; } out[id] = n; });
      }
      res.status(200).json({ ok: true, streaks: out });
      return;
    }
    if (req.method === "GET" && req.query && req.query.search !== undefined) {
      const q = String(req.query.search || "").trim().replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      const me = String(req.query.me || "");
      if (q.length < 2) { res.status(200).json({ ok: true, results: [] }); return; }
      const r = await rest("profiles?select=" + PROF_SEL + "&display_name=ilike." + encodeURIComponent("%" + q + "%") + "&order=wins.desc&limit=20", { headers: sbHeaders() });
      const rows = Array.isArray(r.json) ? r.json : [];
      const counts = {}, mine = {};
      if (rows.length) {
        const ids = rows.map((x) => x.id);
        const f = await rest("follows?select=follower_id,following_id&following_id=in.(" + ids.join(",") + ")&limit=10000", { headers: sbHeaders() });
        if (Array.isArray(f.json)) f.json.forEach((x) => { counts[x.following_id] = (counts[x.following_id] || 0) + 1; if (me && x.follower_id === me) mine[x.following_id] = 1; });
      }
      res.status(200).json({ ok: true, results: rows.map((x) => ({ id: x.id, display_name: x.display_name, wins: x.wins, avatar_url: x.avatar_url, featured_card: x.featured_card, followers: counts[x.id] || 0, following: !!mine[x.id] })) });
      return;
    }
    if (req.method === "GET" && req.query && req.query.state) {
      const me = String(req.query.uid || "");
      if (!UUID_RE.test(me)) { res.status(200).json({ ok: false, error: "bad uid" }); return; }
      const ing = await rest("follows?select=following_id&follower_id=eq." + me + "&limit=10000", { headers: sbHeaders() });
      const ers = await rest("follows?select=id&following_id=eq." + me + "&limit=10000", { headers: sbHeaders() });
      res.status(200).json({
        ok: true,
        following: Array.isArray(ing.json) ? ing.json.map((r) => r.following_id) : [],
        followers: Array.isArray(ers.json) ? ers.json.length : 0,
      });
      return;
    }
    if (req.method === "GET" && req.query && req.query.counts) {
      const all = await rest("follows?select=following_id&limit=10000", { headers: sbHeaders() });
      const counts = {};
      if (Array.isArray(all.json)) all.json.forEach((r) => { counts[r.following_id] = (counts[r.following_id] || 0) + 1; });
      res.status(200).json({ ok: true, counts });
      return;
    }
    if (req.method === "GET" && req.query && req.query.picks) {
      const target = String(req.query.picks);
      const me = String(req.query.me || "");
      if (!UUID_RE.test(target)) { res.status(200).json({ ok: false, error: "bad uid" }); return; }
      const p = await rest("profiles?select=" + PROF_SEL + "&id=eq." + target, { headers: sbHeaders() });
      const prof = (p.json && p.json[0]) || null;
      const t = await rest("tickets?select=id,user_id,legs,status,created_at&user_id=eq." + target + "&is_public=eq.true&order=created_at.desc&limit=50", { headers: sbHeaders() });
      const all = await rest("tickets?select=status,created_at,legs&user_id=eq." + target + "&order=created_at.asc&limit=1000", { headers: sbHeaders() });
      const rowsA = Array.isArray(all.json) ? all.json : [];
      const customWin = (r) => r.status === "win" && Array.isArray(r.legs) && r.legs.some((l) => l && l.custom);
      let sw = 0, sl = 0, best = 0, cur = 0;
      rowsA.forEach((r) => {
        if (customWin(r)) return;
        if (r.status === "win") { sw++; cur++; if (cur > best) best = cur; }
        else if (r.status === "loss") { sl++; cur = 0; }
      });
      let streak = 0;
      for (let i = rowsA.length - 1; i >= 0; i--) {
        if (customWin(rowsA[i])) continue;
        if (rowsA[i].status === "win") streak++;
        else if (rowsA[i].status === "loss") break;
      }
      res.status(200).json({
        ok: true,
        profile: prof,
        stats: {
          tickets: rowsA.length,
          wins: prof ? (prof.wins || 0) : sw,
          recordW: sw, recordL: sl,
          winPct: (sw + sl) ? Math.round(100 * sw / (sw + sl)) : null,
          streak: streak, best: best,
        },
        tickets: Array.isArray(t.json) ? t.json.map((x) => shapeTicket(x, me)) : [],
      });
      return;
    }
    if (req.method === "GET" && req.query && req.query.feed) {
      const me = String(req.query.uid || "");
      if (!UUID_RE.test(me)) { res.status(200).json({ ok: false, error: "bad uid" }); return; }
      const ing = await rest("follows?select=following_id&follower_id=eq." + me + "&limit=10000", { headers: sbHeaders() });
      const ids = Array.isArray(ing.json) ? ing.json.map((r) => r.following_id) : [];
      if (!ids.length) { res.status(200).json({ ok: true, items: [] }); return; }
      const t = await rest("tickets?select=id,user_id,legs,status,created_at&is_public=eq.true&user_id=in.(" + ids.join(",") + ")&order=created_at.desc&limit=30", { headers: sbHeaders() });
      const rows = Array.isArray(t.json) ? t.json : [];
      const owners = {};
      if (rows.length) {
        const oids = Array.from(new Set(rows.map((r) => r.user_id)));
        const pr = await rest("profiles?select=" + PROF_SEL + "&id=in.(" + oids.join(",") + ")", { headers: sbHeaders() });
        if (Array.isArray(pr.json)) pr.json.forEach((p) => { owners[p.id] = p; });
      }
      res.status(200).json({
        ok: true,
        items: rows.map((x) => ({ owner: owners[x.user_id] || { id: x.user_id, display_name: "Agent" }, ticket: shapeTicket(x, me) })),
      });
      return;
    }
    if (req.method === "GET" && req.query && req.query.top) {
      const me = String(req.query.me || "");
      const t = await rest("tickets?select=id,user_id,legs,status,created_at&is_public=eq.true&order=created_at.desc&limit=300", { headers: sbHeaders() });
      const rows = Array.isArray(t.json) ? t.json : [];
      let best = null;
      rows.forEach((x) => {
        if (x.status !== "win" && x.status !== "loss") return;
        const lk = likesOf(x.legs);
        if (lk > 0 && (!best || lk > likesOf(best.legs))) best = x;
      });
      if (!best) { res.status(200).json({ ok: true, ticket: null, owner: null }); return; }
      const p = await rest("profiles?select=" + PROF_SEL + "&id=eq." + best.user_id, { headers: sbHeaders() });
      const ot = await rest("tickets?select=status,legs&user_id=eq." + best.user_id + "&status=in.(win,loss)&order=created_at.desc&limit=100", { headers: sbHeaders() });
      let ostreak = 0;
      if (Array.isArray(ot.json)) { for (let i = 0; i < ot.json.length; i++) { const r = ot.json[i]; if (r.status === "win" && Array.isArray(r.legs) && r.legs.some((l) => l && l.custom)) continue; if (r.status === "win") ostreak++; else break; } }
      res.status(200).json({ ok: true, ticket: shapeTicket(best, me), owner: (p.json && p.json[0]) || null, streak: ostreak });
      return;
    }
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch (e) { body = {}; } }
      body = body || {};
      const uid = String(body.uid || "");
      if (!UUID_RE.test(uid)) { res.status(200).json({ ok: false, error: "bad uid" }); return; }
      if (body.action === "follow" || body.action === "unfollow") {
        const target = String(body.target || "");
        if (!UUID_RE.test(target) || target === uid) { res.status(200).json({ ok: false, error: "bad target" }); return; }
        if (body.action === "unfollow") {
          await rest("follows?follower_id=eq." + uid + "&following_id=eq." + target, { method: "DELETE", headers: sbHeaders({ Prefer: "return=minimal" }) });
          res.status(200).json({ ok: true, following: false });
          return;
        }
        const ex = await rest("follows?select=id&follower_id=eq." + uid + "&following_id=eq." + target, { headers: sbHeaders() });
        if (Array.isArray(ex.json) && ex.json.length) { res.status(200).json({ ok: true, following: true }); return; }
        const ins = await rest("follows", {
          method: "POST",
          headers: sbHeaders({ Prefer: "return=minimal" }),
          body: JSON.stringify({ id: require("crypto").randomUUID(), follower_id: uid, following_id: target }),
        });
        if (ins.status >= 300) { res.status(200).json({ ok: false, step: "follow", status: ins.status, detail: (ins.text || "").slice(0, 200) }); return; }
        res.status(200).json({ ok: true, following: true });
        return;
      }
      if (body.action === "like" || body.action === "unlike") {
        const tid = String(body.ticketId || "");
        if (!UUID_RE.test(tid)) { res.status(200).json({ ok: false, error: "bad ticket" }); return; }
        const t = await rest("tickets?select=id,user_id,legs,status,is_public&id=eq." + tid, { headers: sbHeaders() });
        const row = t.json && t.json[0];
        if (!row || !row.is_public) { res.status(200).json({ ok: false, error: "not public" }); return; }
        if (row.user_id === uid) { res.status(200).json({ ok: false, error: "own ticket" }); return; }
        const legs = Array.isArray(row.legs) ? row.legs : [];
        if (!legs.length) { res.status(200).json({ ok: false, error: "no legs" }); return; }
        let likedBy = likedByOf(legs).slice();
        if (body.action === "like") { if (likedBy.indexOf(uid) === -1) likedBy.push(uid); }
        else likedBy = likedBy.filter((x) => x !== uid);
        if (likedBy.length > 500) likedBy = likedBy.slice(likedBy.length - 500);
        legs[0] = Object.assign({}, legs[0], { __likedBy: likedBy, __likes: likedBy.length });
        const up = await rest("tickets?id=eq." + tid, {
          method: "PATCH",
          headers: sbHeaders({ Prefer: "return=minimal" }),
          body: JSON.stringify({ legs }),
        });
        if (up.status >= 300) { res.status(200).json({ ok: false, step: "like", status: up.status, detail: (up.text || "").slice(0, 200) }); return; }
        res.status(200).json({ ok: true, likes: likedBy.length, liked: body.action === "like" });
        return;
      }
      res.status(200).json({ ok: false, error: "bad action" });
      return;
    }
    res.status(200).json({ ok: false, error: "method" });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};
