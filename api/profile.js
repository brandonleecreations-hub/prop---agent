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

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!SB_URL || !SRK) { res.status(200).json({ ok: false, configured: false }); return; }
  try {
    if (req.method === "GET" && req.query && req.query.board) {
      const r = await rest("profiles?select=id,display_name,wins,avatar_url,featured_card&order=wins.desc&limit=50", { headers: sbHeaders() });
      res.status(200).json({ ok: r.status === 200, board: Array.isArray(r.json) ? r.json : [] });
      return;
    }
    if (req.method === "GET" && req.query && req.query.uid) {
      const uid = String(req.query.uid);
      if (!UUID_RE.test(uid)) { res.status(200).json({ ok: false, error: "bad uid" }); return; }
      const p = await rest("profiles?select=id,display_name,wins,avatar_url,featured_card&id=eq." + uid, { headers: sbHeaders() });
      const t = await rest("tickets?select=legs,status,created_at&user_id=eq." + uid + "&order=created_at.desc&limit=200", { headers: sbHeaders() });
      res.status(200).json({ ok: true, profile: (p.json && p.json[0]) || null, tickets: Array.isArray(t.json) ? t.json : [] });
      return;
    }
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch (e) { body = {}; } }
      body = body || {};
      const uid = String(body.uid || "");
      if (!UUID_RE.test(uid)) { res.status(200).json({ ok: false, error: "bad uid" }); return; }
      const name = String(body.display_name || "Guest Agent").slice(0, 60);
      const avatarUrl = String(body.avatar_url || "").slice(0, 500);
      const featuredCard = String(body.featured_card || "").slice(0, 80);
      const wins = Math.max(0, parseInt(body.wins, 10) || 0);
      const rows = Array.isArray(body.tickets) ? body.tickets.slice(0, 200) : [];
      const up = await rest("profiles", {
        method: "POST",
        headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({ id: uid, display_name: name, wins: wins, avatar_url: avatarUrl, featured_card: featuredCard }),
      });
      if (up.status >= 300) { res.status(200).json({ ok: false, step: "profile", status: up.status, detail: (up.text || "").slice(0, 200) }); return; }
      await rest("tickets?user_id=eq." + uid, { method: "DELETE", headers: sbHeaders({ Prefer: "return=minimal" }) });
      if (rows.length) {
        const ins = await rest("tickets", {
          method: "POST",
          headers: sbHeaders({ Prefer: "return=minimal" }),
          body: JSON.stringify(rows.map((t) => ({
            user_id: uid,
            legs: Array.isArray(t.legs) ? t.legs : [],
            status: ["win", "loss", "pending"].indexOf(t.status) > -1 ? t.status : "pending",
            is_public: true,
          }))),
        });
        if (ins.status >= 300) { res.status(200).json({ ok: false, step: "tickets", status: ins.status, detail: (ins.text || "").slice(0, 200) }); return; }
      }
      res.status(200).json({ ok: true });
      return;
    }
    res.status(200).json({ ok: false, error: "method" });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};
