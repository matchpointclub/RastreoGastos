// Service worker mínimo: no cachea nada ni hace la app "offline",
// solo existe para poder usar registration.showNotification(), que es
// el único método que Android (Chrome y derivados) permite para mostrar
// notificaciones del sistema desde una página web.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Al tocar la notificación, si ya hay una pestaña de la app abierta la
// enfoca; si no, abre una nueva.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});