// Prop Agent — email + password accounts via Supabase Auth.
// The app talks only to this endpoint; passwords pass over HTTPS straight to
// Supabase's auth service, which stores them bcrypt-hashed. Nothing about a
// password is stored, logged or returned by this function. The service role
// key stays server-side; it is used as the API key for the auth endpoints
// because the project's anon key on file is stale.
//   POST {action:"signup", email, password}     -> creates account + session
//   POST {action:"login", email, password}      -> session
//   POST {action:"refresh", refresh_token}      -> fresh session
//   POST {action:"recover", email}              -> sends a reset email
//   POST {action:"setpassword", access_token, password} -> after reset link
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

async function gotrue(path, opts) {
  const r = await fetch(SB_URL + "/auth/v1/" + path, {
    method: (opts && opts.method) || "POST",
    headers: Object.assign({ apikey: SRK, "Content-Type": "application/json" }, (opts && opts.headers) || {}),
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}
function sessionOf(j) {
  if (!j || !j.access_token || !j.user) return null;
  return {
    ok: true,
    uid: j.user.id,
    email: j.user.email || "",
    session: {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Date.now() + (parseInt(j.expires_in, 10) || 3600) * 1000,
    },
  };
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(200).json({ ok: false, error: "POST only" }); return; }
  if (!SB_URL || !SRK) { res.status(200).json({ ok: false, configured: false }); return; }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch (e) { body = {}; } }
    body = body || {};
    const action = String(body.action || "");
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (action === "signup" || action === "login") {
      if (!EMAIL_RE.test(email)) { res.status(200).json({ ok: false, error: "Enter a valid email address." }); return; }
      if (password.length < 8) { res.status(200).json({ ok: false, error: "Password needs at least 8 characters." }); return; }
      if (action === "signup") {
        const c = await gotrue("admin/users", { body: { email: email, password: password, email_confirm: true, user_metadata: { app: "prop-agent" } } });
        if (c.status >= 300) {
          const msg = (c.json && (c.json.msg || c.json.message || "")) || "";
          if (/already|exists|registered/i.test(msg)) { res.status(200).json({ ok: false, error: "That email already has an account — log in instead." }); return; }
          res.status(200).json({ ok: false, error: "Couldn't create the account. " + msg.slice(0, 120) }); return;
        }
      }
      const t = await gotrue("token?grant_type=password", { body: { email: email, password: password } });
      const s = sessionOf(t.json);
      if (!s) {
        res.status(200).json({ ok: false, error: action === "login" ? "Email or password didn't match." : "Account created, but the first log-in failed — try Log in." });
        return;
      }
      res.status(200).json(s);
      return;
    }
    if (action === "refresh") {
      const rt = String(body.refresh_token || "");
      if (!rt) { res.status(200).json({ ok: false, error: "no refresh token" }); return; }
      const t = await gotrue("token?grant_type=refresh_token", { body: { refresh_token: rt } });
      const s = sessionOf(t.json);
      res.status(200).json(s || { ok: false, error: "session expired" });
      return;
    }
    if (action === "recover") {
      if (EMAIL_RE.test(email)) { try { await gotrue("recover", { body: { email: email } }); } catch (e) {} }
      res.status(200).json({ ok: true }); // same answer either way — never reveals whether the email exists
      return;
    }
    if (action === "setpassword") {
      const at = String(body.access_token || "");
      if (!at || password.length < 8) { res.status(200).json({ ok: false, error: "Password needs at least 8 characters." }); return; }
      const u = await gotrue("user", { method: "PUT", headers: { Authorization: "Bearer " + at }, body: { password: password } });
      if (u.status >= 300) { res.status(200).json({ ok: false, error: "That reset link has expired — request a new one." }); return; }
      res.status(200).json({ ok: true });
      return;
    }
    res.status(200).json({ ok: false, error: "unknown action" });
  } catch (e) {
    res.status(200).json({ ok: false, error: "Auth service hiccup — try again in a moment." });
  }
};
