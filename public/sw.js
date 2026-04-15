'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch (_) { data = { title: 'Find A Podcast', body: e.data.text() }; }

  const title   = data.title || 'Find A Podcast';
  const options = {
    body:    data.body    || 'You have new podcast matches waiting.',
    icon:    data.icon    || '/linkedin-logo.svg',
    badge:   data.badge   || '/linkedin-logo.svg',
    data:    { url: data.url || '/dashboard' },
    actions: [{ action: 'open', title: 'View Matches' }],
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/dashboard';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.includes('/dashboard'));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
