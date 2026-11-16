/* Prop Agent service worker — hosted version.

   Handles push notifications (game starts, leg hits/misses, line moves) sent
   by hosted/api/send-push.js. Tapping a notification opens the app.

   NOTE: push on iPhone only works when Prop Agent is installed via
   "Add to Home Screen" — see the in-app hint in the Agent profile. */

self.addEventListener("push", function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : "" }; }
  var title = data.title || "Prop Agent";
  var options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: (data && data.url) || "/" },
    tag: (data && data.type) || "prop-agent"
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function(event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if ("focus" in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

/* No offline caching here on purpose: the app's live ESPN feed and baked
   catalog are already cached by the app itself (localStorage), and an
   aggressive cache would risk serving a stale board. */
