// The dashboard's push service worker (server/utils/web-push.ts sends to it).
// A push carries { title, body, url, tag }; a click opens that dashboard link.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  const alert = event.data.json()
  event.waitUntil(self.registration.showNotification(alert.title, {
    body: alert.body,
    icon: '/krabi-claw-logo.png',
    badge: '/krabi-claw-logo-192.png',
    ...(alert.tag ? { tag: alert.tag } : {}),
    data: { url: alert.url },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data.url
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = windows.find(client => client.url === url)
    if (open) {
      const refreshed = await open.navigate(url)
      if (refreshed) return refreshed.focus()
    }
    return self.clients.openWindow(url)
  })())
})
