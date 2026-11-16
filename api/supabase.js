// Prop Agent — Supabase config probe.
// Reports WHICH Supabase env vars exist in Vercel (names only, never values)
// and, with ?probe=1, lists the project's PostgREST tables so the client
// wiring can target the tables the original build created.
const URL_NAMES = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_PROJECT_URL", "PUBLIC_SUPABASE_URL"];
const KEY_NAMES = ["SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_KEY", "PUBLIC_SUPABASE_ANON_KEY"];

function pick(names) {
  for (const n of names) if (process.env[n]) return { name: n, value: process.env[n] };
  return null;
}

module.exports = async (req, res) => {
  const u = pick(URL_NAMES);
  const k = pick(KEY_NAMES);
  const present = Object.keys(process.env).filter((x) => /SUPABASE/i.test(x)).sort();
  const out = {
    configured: !!(u && k),
    urlVar: u ? u.name : null,
    keyVar: k ? k.name : null,
    supabaseVarsPresent: present,
  };
  if (u && k && req.query && req.query.probe) {
    try {
      const base = u.value.replace(/\/+$/, "");
      const r = await fetch(base + "/rest/v1/", {
        headers: { apikey: k.value, Authorization: "Bearer " + k.value },
      });
      const j = await r.json().catch(() => null);
      out.probeStatus = r.status;
      out.tables = j && j.paths
        ? Object.keys(j.paths).filter((p) => p !== "/").map((p) => p.slice(1))
        : [];
      if (j && j.definitions) out.tableColumns = Object.fromEntries(
        Object.entries(j.definitions).map(([t, d]) => [t, Object.keys((d && d.properties) || {})])
      );
    } catch (e) {
      out.probeError = String((e && e.message) || e);
    }
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(out);
};
