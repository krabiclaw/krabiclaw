import japaneseFontsUrl from '~/assets/css/japanese-fonts.css?url'
import type { TenantOrganizationInfo } from '~/composables/useTenantOrganization'
import { sitePaletteStyle } from '~/shared/site-palette'

// A public layout's brand: the site's font preset (on its root and <html>, so
// text a layout teleports or the body renders outside it follows), the
// Japanese faces on a Japanese page, and, on Saya and Blawby, the site's
// palette with the visitor's light/dark preference. Every public template
// uses this; the dashboard does not, so it never wears a site's choices.
export function usePublicSiteBrand(organization: TenantOrganizationInfo | null = useTenantOrganization().organization) {
  const fontPreset = organization?.fontPreset
  const palette = organization?.palette
  const locale = useState<string>('public-locale', () => 'en')
  const paletteStyle = palette ? sitePaletteStyle(palette) : {}
  useHead(() => ({
    // <html> carries the palette too, for what renders outside the layout root
    // (the loading bar, body text).
    htmlAttrs: { ...(fontPreset && { 'data-font-preset': fontPreset }), ...(palette && { style: Object.entries(paletteStyle).map(([name, value]) => `${name}:${value}`).join(';') }) },
    link: locale.value === 'ja' ? [{ key: 'japanese-fonts', rel: 'stylesheet', href: japaneseFontsUrl }] : [],
  }))

  // The platform is dark by design and has no palette or mode control.
  if (palette && import.meta.client) {
    const theme = usePlatformTheme()
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')
    const onSystemThemeChange = () => theme.sync()
    onMounted(() => theme.restore())
    prefersDark.addEventListener('change', onSystemThemeChange)
    const stopThemeWatch = watch(theme.preference, theme.sync)
    onBeforeUnmount(() => {
      prefersDark.removeEventListener('change', onSystemThemeChange)
      stopThemeWatch()
    })
  }

  return { fontPreset, paletteStyle }
}
