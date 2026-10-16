export default defineNuxtPlugin(() => {
  const route = useRoute()

  useHead(() => {
    if (!route.path.startsWith('/dashboard')) return {}

    return {
      meta: [
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        // `default`, not `black-translucent`: on iOS 26 the translucent style
        // paints the page from the top of the screen but sizes the layout
        // viewport as if the status bar were still there, so fixed chrome
        // overlaps the clock and `bottom: 0` lands a status-bar's height above
        // the home indicator, with a band below it no CSS can reach. With
        // `default` the web view starts under the status bar and ends at the
        // screen edge; the status bar takes `theme-color`.
        { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
        { name: 'apple-mobile-web-app-title', content: 'KrabiClaw' },
      ],
      link: [
        { rel: 'manifest', href: '/manifest.webmanifest' },
        { rel: 'apple-touch-icon', href: '/platform/apple-touch-icon.png' },
      ],
    }
  })
})
