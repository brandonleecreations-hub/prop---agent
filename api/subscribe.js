// Prop Agent — save/remove a device's push subscription in Supabase so the
// alerts job can reach it when the app is closed.
//   POST /api/subscribe { uid, subscription:{endpoint, keys:{p256dh, auth}} }
//   POST /api/subscribe { uid, action:"unsubscribe", endpoint }
// push_subscriptions columns: id, user_id, endpoint, p256dh, auth, created_at.
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

// Same device-user anchor trick as api/profile.js: user_id has a foreign
// key to auth.users, so a fresh device UUID needs an auth user first.
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
  if (req.method !== "POST") { res.status(200).json({ ok: false, error: "POST only" }); return; }
  if (!SB_URL || !SRK) { res.status(200).json({ ok: false, configured: false }); return; }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch (e) { body = {}; } }
    body = body || {};
    let uid = String(body.uid || "");
    if (!UUID_RE.test(uid)) { res.status(200).json({ ok: false, error: "bad uid" }); return; }

    if (body.action === "unsubscribe") {
      const ep = String(body.endpoint || "");
      if (ep) await rest("push_subscriptions?endpoint=eq." + encodeURIComponent(ep), { method: "DELETE", headers: sbHeaders({ Prefer: "return=minimal" }) });
      res.status(200).json({ ok: true });
      return;
    }

    const sub = body.subscription || {};
    const endpoint = String(sub.endpoint || "");
    const p256dh = String((sub.keys && sub.keys.p256dh) || "");
    const auth = String((sub.keys && sub.keys.auth) || "");
    if (!endpoint || !p256dh || !auth) { res.status(200).json({ ok: false, error: "bad subscription" }); return; }

    const insert = (id) => rest("push_subscriptions", {
      method: "POST",
      headers: sbHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({ user_id: id, endpoint: endpoint, p256dh: p256dh, auth: auth }),
    });
    // One row per endpoint: drop any older row for this browser first.
    await rest("push_subscriptions?endpoint=eq." + encodeURIComponent(endpoint), { method: "DELETE", headers: sbHeaders({ Prefer: "return=minimal" }) });
    let ins = await insert(uid);
    if (ins.status >= 300 && (ins.text || "").indexOf("23503") > -1) {
      const newId = await createDeviceUser();
      if (newId) { uid = newId; ins = await insert(uid); }
    }
    if (ins.status >= 300) { res.status(200).json({ ok: false, step: "insert", status: ins.status, detail: (ins.text || "").slice(0, 200) }); return; }
    res.status(200).json({ ok: true, uid });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};
