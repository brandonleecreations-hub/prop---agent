// Prop Agent — social probe (temporary): reports the exact columns of the
// follows / profile_likes / tickets / profiles tables from PostgREST's
// OpenAPI spec so the follow + public-picks endpoints can be built against
// the real schema. Uses the service role key server-side only.
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!SB_URL || !SRK) { res.status(200).json({ ok: false, configured: false }); return; }
  try {
    const r = await fetch(SB_URL + "/rest/v1/", { headers: { apikey: SRK, Authorization: "Bearer " + SRK } });
    const j = await r.json().catch(() => null);
    const defs = (j && j.definitions) || {};
    const out = {};
    ["follows", "profile_likes", "tickets", "profiles"].forEach((t) => {
      const d = defs[t];
      if (!d) { out[t] = null; return; }
      const cols = {};
      Object.keys(d.properties || {}).forEach((c) => {
        const p = d.properties[c] || {};
        cols[c] = (p.format || p.type || "") + (d.required && d.required.indexOf(c) > -1 ? "!" : "");
      });
      out[t] = cols;
    });
    res.status(200).json({ ok: true, tables: out });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};
