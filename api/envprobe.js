// TEMPORARY diagnostic (restored 2026-11-16): reports only the NAMES of env
// vars related to the props keys — never values.
module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const names = Object.keys(process.env)
    .filter((k) => /PARLAY|PRIZE|PROP|PICKS/i.test(k))
    .sort();
  res.status(200).json({ ok: true, names });
};
