// Service worker de Papote : sert seulement à afficher les notifications
// (obligatoire sur téléphone Android) et à ouvrir la bonne conversation quand on clique dessus.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const chatId = e.notification.data?.chatId;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      if (chatId) win.postMessage({ openChat: chatId });
    } else {
      await self.clients.openWindow('./');
    }
  })());
});
