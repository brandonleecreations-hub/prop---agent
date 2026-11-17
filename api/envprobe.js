// TEMPORARY diagnostic (added 2026-11-16, remove after use): reports only the
// NAMES of env vars related to the props keys — never values — so we can see
// whether PARLAY_API_KEY actually exists in this project's Production env.
module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const names = Object.keys(process.env)
    .filter((k) => /PARLAY|PRIZE|PROP|PICKS/i.test(k))
    .sort();
  res.status(200).json({ ok: true, names });
};
