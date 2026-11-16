// Prop Agent — push notification sender (rebuilt).
// GET  /api/send-push  -> { ok, publicKey } so the page can subscribe.
// POST /api/send-push  -> { action:"test", subscription, title, body, url, type }
//                         sends one web-push to that subscription.
// Requires Vercel env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
// (VAPID_SUBJECT like "mailto:you@example.com"). Without them it reports
// { ok:false, configured:false } and the app simply runs without push.

let webPush = null;
try { webPush = require("web-push"); } catch (e) { webPush = null; }

function configured() {
  return !!(webPush && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "GET") {
    res.status(200).json({
      ok: true,
      configured: configured(),
      publicKey: configured() ? process.env.VAPID_PUBLIC_KEY : null,
    });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST only" });
    return;
  }
  if (!configured()) {
    res.status(200).json({ ok: false, configured: false, error: "push not configured" });
    return;
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const sub = body.subscription;
    if (!sub || !sub.endpoint) {
      res.status(400).json({ ok: false, error: "subscription required" });
      return;
    }
    webPush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:admin@example.com",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    const payload = JSON.stringify({
      title: body.title || "Prop Agent",
      body: body.body || "",
      url: body.url || "/",
      type: body.type || "prop-agent",
    });
    await webPush.sendNotification(sub, payload);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
