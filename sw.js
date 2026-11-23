/* Prop Agent service worker — hosted version.

   Handles push notifications (game starts, leg hits/misses, line moves) sent
   by hosted/api/send-push.js. Tapping a notification opens the app.

   NOTE: push on iPhone only works when Prop Agent is installed via
   "Add to Home Screen" — see the in-app hint in the Agent profile. */

self.addEventListener("push", function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : "" }; }
  var title = data.title || "Stat Agent";
  var options = {
    body: data.body || "",
    icon: "/api/icons?s=logo",
    badge: "/api/icons?s=logo",
    image: (data && data.image) || undefined,
    data: { url: (data && data.url) || "/", game: (data && data.game) || null, tab: (data && data.tab) || null },
    tag: (data && data.type) || "score-agent"
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function(event) {
  event.notification.close();
  var nd = (event.notification && event.notification.data) || {};
  var url = nd.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if ("focus" in list[i]) {
          try { list[i].postMessage({ saGame: nd.game || null, saTab: nd.tab || null }); } catch (e) {}
          return list[i].focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

/* Installability: Chrome only offers the app install (and fires
   beforeinstallprompt for the Download button) when the service worker
   handles fetch events. This handler is network-only — it changes
   nothing about what loads, it just passes every request through. */
self.addEventListener("fetch", function(event) {
  event.respondWith(fetch(event.request));
});

/* No offline caching here on purpose: the app's live ESPN feed and baked
   catalog are already cached by the app itself (localStorage), and an
   aggressive cache would risk serving a stale board. */
