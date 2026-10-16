/* Blip service worker — Web Push notifications.
   Served from assets/ alongside the app icons, so the paths below are
   relative to this file. APP_URL is the app root (the scope's parent). */
const APP_URL = self.registration.scope.replace(/assets\/?$/, '');

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

function resolveUrl(raw){
  if (!raw) return APP_URL;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.charAt(0) === '/') return self.location.origin + raw;
  return APP_URL + raw.replace(/^\.\//, '');
}

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try { data = event.data.json() || {}; }
    catch (e) { data = { body: event.data.text() }; }
  }
  const title = data.title || 'Blip';
  /* One stacked notification per chat / caller: reuse the same tag so a new
     push replaces the previous one instead of piling up. */
  const tag = data.tag ||
    (data.chat_id ? 'chat-' + data.chat_id :
     (data.caller_id ? 'call-' + data.caller_id :
      (data.sender_id ? 'chat-' + data.sender_id : undefined)));
  const options = {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: tag,
    renotify: !!tag,
    data: Object.assign({}, data, { url: resolveUrl(data.url) })
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = resolveUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        try { await client.focus(); } catch (e) {}
        if ('navigate' in client) { try { await client.navigate(target); } catch (e) {} }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

/* The push service rotated our subscription: ask any open Blip window to
   re-subscribe and save the fresh keys. If no window is open, the app
   re-subscribes silently on its next launch. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows.forEach((client) => { try { client.postMessage({ type: 'blip-resubscribe' }); } catch (e) {} });
  })());
});
