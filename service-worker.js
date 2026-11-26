const CACHE_NAME = 'farmer-daily-shell-v29';
const SAFE_SHELL = [
  '/offline.html',
  '/styles.css',
  '/themes.css',
  '/reading.css',
  '/farm-intelligence.css',
  '/farm-intelligence.js',
  '/connected-farm.js',
  '/connected-farm.css',
  '/calendar-connections.js',
  '/calendar-connections.css',
  '/messaging.js',
  '/messaging.css',
  '/ai-brief.js',
  '/ai-brief.css',
  '/brief-voice.js',
  '/brief-voice.css',
  '/focused-views.js',
  '/focused-views.css',
  '/onboarding.css',
  '/pwa.css',
  '/weather.css',
  '/weather-ui.js',
  '/membership.js',
  '/membership.css',
  '/app.js',
  '/farm-workspace.js',
  '/farm-workspace.css',
  '/work-plan.js',
  '/field-map.js',
  '/field-map.css',
  '/field-flow.js',
  '/field-flow.css',
  '/field-geometry.js',
  '/build-progress.js',
  '/phase-one.js',
  '/phase-one.css',
  '/phase-schedule.js',
  '/vendor/leaflet.js',
  '/vendor/leaflet.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SAFE_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Notifications originate only from the running app, not a background push feed.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/?view=farmer#today'));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // OAuth returns and their isolated assets must never be cached or handled by
  // the app shell, including when the current Microsoft session has expired.
  if (url.pathname.startsWith('/calendar-callback')) return;
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/.auth/') || url.pathname.startsWith('/admin')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
    return;
  }

  if (!SAFE_SHELL.includes(url.pathname)) return;
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    }))
  );
});
