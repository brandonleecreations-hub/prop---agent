// Prop Agent — cloud profiles + progress via Supabase (server-side only).
// Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from Vercel env vars; the
// service role key never leaves the server. Identity is a per-device UUID
// the app keeps in localStorage (pa_uid) — no passwords, no typing.
//   GET  /api/profile?board=1   -> top profiles by wins (real leaderboard)
//   GET  /api/profile?uid=<uuid> -> { profile, tickets } for restore
//   POST /api/profile { uid, display_name, wins, tickets:[{legs,status}] }
//        -> upserts the profile row and replaces that user's ticket rows.
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

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
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Ticket likes live on the ticket row (legs[0].__likedBy). A sync replaces
// the user's rows, so likes are carried over by leg fingerprint.
function fpOf(legs) {
  return (Array.isArray(legs) ? legs : []).map((l) => [l.player || "", l.stat || "", l.dir || "", l.line].join("|")).join(";;");
}

// profiles.id has a foreign key to auth.users (the original build used
// Supabase Auth). A device's self-made UUID is not an auth user, so the
// first save for a new device creates a device auth user server-side and
// the app adopts its id. The password is random and never stored or shown —
// the account is only an anchor row for the profile; the device keeps the id.
async function createDeviceUser() {
  const rand = (n) => Array.from({ length: n }, () => "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 55)]).join("");
  const r = await fetch(SB_URL + "/auth/v1/admin/users", {
    method: "POST",
    headers: { apikey: SRK, Authorization: "Bearer " + SRK, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "device-" + Date.now() + "-" + rand(10) + "@propagent.dev",
      password: rand(24),
      email_confirm: true,
      user_metadata: { device: true, app: "prop-agent" },
    }),
  });
  const j = await r.json().catch(() => null);
  return j && j.id ? j.id : null;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!SB_URL || !SRK) { res.status(200).json({ ok: false, configured: false }); return; }
  try {
    if (req.method === "GET" && req.query && req.query.board) {
      let r = await rest("profiles?select=id,display_name,wins,avatar_url,featured_card,battle_w,battle_l&order=wins.desc&limit=50", { headers: sbHeaders() });
      if (r.status !== 200) r = await rest("profiles?select=id,display_name,wins,avatar_url,featured_card&order=wins.desc&limit=50", { headers: sbHeaders() });
      res.status(200).json({ ok: r.status === 200, board: Array.isArray(r.json) ? r.json : [] });
      return;
    }
    if (req.method === "GET" && req.query && req.query.uid) {
      const uid = String(req.query.uid);
      if (!UUID_RE.test(uid)) { res.status(200).json({ ok: false, error: "bad uid" }); return; }
      let p = await rest("profiles?select=id,display_name,wins,avatar_url,featured_card,coins,battle_w,battle_l,ladder&id=eq." + uid, { headers: sbHeaders() });
      if (p.status >= 300) p = await rest("profiles?select=id,display_name,wins,avatar_url,featured_card&id=eq." + uid, { headers: sbHeaders() });
      const t = await rest("tickets?select=legs,status,created_at&user_id=eq." + uid + "&order=created_at.desc&limit=200", { headers: sbHeaders() });
      res.status(200).json({ ok: true, profile: (p.json && p.json[0]) || null, tickets: Array.isArray(t.json) ? t.json : [] });
      return;
    }
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch (e) { body = {}; } }
      body = body || {};
      let uid = String(body.uid || "");
      if (!UUID_RE.test(uid)) { res.status(200).json({ ok: false, error: "bad uid" }); return; }
      const name = String(body.display_name || "Guest Agent").slice(0, 60);
      const avatarUrl = String(body.avatar_url || "").slice(0, 500);
      const featuredCard = String(body.featured_card || "").slice(0, 80);
      const wins = Math.max(0, parseInt(body.wins, 10) || 0);
      const coins = Math.max(0, parseInt(body.coins, 10) || 0);
      const battleW = Math.max(0, parseInt(body.battle_w, 10) || 0);
      const battleL = Math.max(0, parseInt(body.battle_l, 10) || 0);
      const ladderN = Math.max(0, Math.min(7, parseInt(body.ladder, 10) || 0));
      const rows = Array.isArray(body.tickets) ? body.tickets.slice(0, 200) : [];
      const upsertProfile = (id, full) => rest("profiles", {
        method: "POST",
        headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify(full
          ? { id: id, display_name: name, wins: wins, avatar_url: avatarUrl, featured_card: featuredCard, coins: coins, battle_w: battleW, battle_l: battleL, ladder: ladderN }
          : { id: id, display_name: name, wins: wins, avatar_url: avatarUrl, featured_card: featuredCard }),
      });
      if (name !== "Guest Agent") {
        const cur = await rest("profiles?select=display_name&id=eq." + uid, { headers: sbHeaders() });
        const curName = (cur.json && cur.json[0] && cur.json[0].display_name) || "";
        if (name.toLowerCase() !== String(curName).toLowerCase()) {
          if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) { res.status(200).json({ ok: false, error: "username format" }); return; }
          const cand = await rest("profiles?select=id,display_name&display_name=ilike." + encodeURIComponent(name), { headers: sbHeaders() });
          const taken = Array.isArray(cand.json) && cand.json.some((r) => r.id !== uid && String(r.display_name).toLowerCase() === name.toLowerCase());
          if (taken) { res.status(200).json({ ok: false, error: "username taken" }); return; }
        }
      }
      let up = await upsertProfile(uid, true);
      if (up.status >= 300 && (up.text || "").indexOf("23503") === -1) up = await upsertProfile(uid, false);
      if (up.status >= 300 && (up.text || "").indexOf("23503") > -1) {
        // Device id is not an auth user yet — create one and adopt its id.
        const newId = await createDeviceUser();
        if (newId) {
          uid = newId;
          up = await upsertProfile(uid, true);
          if (up.status >= 300 && (up.text || "").indexOf("23503") === -1) up = await upsertProfile(uid, false);
        }
      }
      if (up.status >= 300) { res.status(200).json({ ok: false, step: "profile", status: up.status, detail: (up.text || "").slice(0, 200) }); return; }
      const clashLast = Math.max(0, parseInt(body.clash_last, 10) || 0);
      if (clashLast) { try { await rest("profiles?id=eq." + uid, { method: "PATCH", headers: sbHeaders({ Prefer: "return=minimal" }), body: JSON.stringify({ clash_last: clashLast }) }); } catch (e) {} }
      const prev = await rest("tickets?select=legs&user_id=eq." + uid + "&limit=500", { headers: sbHeaders() });
      const likeMap = {};
      if (Array.isArray(prev.json)) prev.json.forEach((r) => {
        const by = (Array.isArray(r.legs) && r.legs[0] && Array.isArray(r.legs[0].__likedBy)) ? r.legs[0].__likedBy : [];
        if (by.length) likeMap[fpOf(r.legs)] = by;
      });
      await rest("tickets?user_id=eq." + uid, { method: "DELETE", headers: sbHeaders({ Prefer: "return=minimal" }) });
      if (rows.length) {
        const ins = await rest("tickets", {
          method: "POST",
          headers: sbHeaders({ Prefer: "return=minimal" }),
          body: JSON.stringify(rows.map((t) => {
            let legs = Array.isArray(t.legs) ? t.legs : [];
            const by = likeMap[fpOf(legs)];
            if (by && by.length && legs.length) {
              legs = legs.map((l, i) => (i === 0 ? Object.assign({}, l, { __likedBy: by, __likes: by.length }) : l));
            }
            return {
              user_id: uid,
              legs: legs,
              status: ["win", "loss", "pending"].indexOf(t.status) > -1 ? t.status : "pending",
              is_public: t.is_public !== false,
            };
          })),
        });
        if (ins.status >= 300) { res.status(200).json({ ok: false, step: "tickets", status: ins.status, detail: (ins.text || "").slice(0, 200) }); return; }
      }
      res.status(200).json({ ok: true, uid });
      return;
    }
    res.status(200).json({ ok: false, error: "method" });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};
