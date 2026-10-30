self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// No cacheamos credenciales ni respuestas privadas. La membresía requiere conexión.
self.addEventListener('push', event => {
 let data = { title: 'Gympanel', body: 'Tenés un nuevo aviso de tu gimnasio.', url: '/' };
 try { data = { ...data, ...event.data.json() }; } catch {}
 event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: data.url }, tag: 'gympanel-membership' }));
});
self.addEventListener('notificationclick', event => {
 event.notification.close();
 const url = new URL(event.notification.data?.url || '/', self.location.origin);
 if (url.origin !== self.location.origin) return;
 event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
   const existing = clients.find(client => client.url === url.href);
   if (existing) return existing.focus();
   return self.clients.openWindow(url.href);
 }));
});
