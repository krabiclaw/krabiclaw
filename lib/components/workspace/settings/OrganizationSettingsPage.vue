<template>
  <!--
    Website is the site: its content lists, its Brand, and the settings a guest
    never sees, one flat list. Brand is what a guest sees, a list of settings
    one level below it. Each setting is a leaf below its list.
  -->
  <DashboardIndexPanel :id="surface === 'brand' ? 'organization-brand' : 'organization-website'" :title="navbarTitle" :auto-open="navigationGroups[0]?.items.find(item => item.to)?.to ?? null">
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="loadError" />
    <EditorNavigationList v-else :groups="navigationGroups" :active-item="detailKey" />
  </DashboardIndexPanel>

  <!-- Translating the brand is a row on the Brand list; this is the sheet it opens. -->
  <DashboardResourceLocalization
    v-if="surface === 'brand'"
    row-trigger
    :organization-id="organizationId"
    resource-type="organization"
    :resource-id="organizationId"
    resource-label="brand"
    :fields="brandLocalizationFields"
    :language-settings-path="`${settingsPath}/localization`"
  />
</template>

<script lang="ts">
import type { ComputedRef, InjectionKey, Reactive, Ref } from 'vue'
import type { CurrencyCode } from '~/shared/currencies'
import type { OrganizationFontPreset } from '~/shared/organization-fonts'
import type { SitePalette } from '~/shared/site-palette'
import type { LogoPresentation } from '~/shared/media-placement-contract'

export interface OrganizationSettingsForm {
  name: string
  brand_description: string
  announcementEnabled: boolean
  announcementAssetId: string | null
  announcementHeadline: string
  announcementDescription: string
  announcementCtaLabel: string
  announcementCtaUrl: string
  announcementDismissible: boolean
  announcementFormat: 'modal' | 'banner'
  logoAssetId: string | null
  logoPresentation: LogoPresentation
  logoDarkAssetId: string | null
  logoDarkPresentation: LogoPresentation
  faviconAssetId: string | null
  socialShareAssetId: string | null
  contact_email: string
  /** Null on the platform template, whose palette is fixed. */
  palette: SitePalette | null
  font_preset: OrganizationFontPreset
  default_currency: CurrencyCode | null
  status: OrganizationStatus
  seo_title: string
  seo_description: string
  canonical_url: string
  native_consultations: boolean
}

/** Live and Draft are the tenant's; Suspended is KrabiClaw's hold. */
export type OrganizationStatus = 'active' | 'inactive' | 'suspended'

export interface OrganizationSettingsResponse {
  theme?: string
  status: OrganizationStatus
  name?: string | null
  brand_description?: string | null
  announcement: { headline: string; description: string | null; cta_label: string | null; cta_url: string | null; dismissible: boolean; enabled: boolean } | null
  media?: Array<{ asset_id: string; slot: string; public_url?: string | null; presentation?: LogoPresentation | null }>
  contact_email?: string | null
  palette: SitePalette | null
  palette_source: 'custom' | 'template' | null
  font_preset?: OrganizationFontPreset
  default_currency?: string | null
  seo_title: string | null
  seo_description: string | null
  canonical_url: string | null
  /** Null when the organization has no consultation settings, so no website booking to switch. */
  consultation_mode: 'native' | 'external_url' | 'native_disabled' | null
}

/**
 * The site's settings draft and everything a leaf shows or does beside its
 * one field. Brand and Website mount the same provider; a leaf reads what it
 * needs and commits through `save`, which writes only the open setting.
 */
export interface OrganizationSettingsEditor {
  form: Reactive<OrganizationSettingsForm>
  organizationId: string
  saving: Ref<boolean>
  saveDisabled: ComputedRef<boolean>
  editorError: ComputedRef<string | null>
  validationMessage: ComputedRef<string | null>
  nameCharactersRemaining: ComputedRef<number>
  descriptionCharactersRemaining: ComputedRef<number>
  theme: ComputedRef<string | undefined>
  /** Whether the site wears its own palette or its template's. */
  paletteSource: ComputedRef<'custom' | 'template' | null>
  /** Returns the site to its template's colors. */
  resetPalette: () => Promise<void>
  /** The saved website booking mode, or null where the organization has no consultation settings. */
  consultationMode: ComputedRef<OrganizationSettingsResponse['consultation_mode']>
  /** The saved logo assets' URLs, for previews before a new pick is saved. */
  logoUrl: (assetId: string | null) => string | null
  revert: () => void
  save: () => Promise<void>
}

export const organizationSettingsEditorKey = Symbol('organization-settings-editor') as InjectionKey<OrganizationSettingsEditor>
</script>

<script setup lang="ts">
import DashboardResourceLocalization from '~/components/dashboard/DashboardResourceLocalization.vue'
import EditorNavigationList, { type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { isCurrencyCode } from '~/shared/currencies'
import { ORGANIZATION_FONT_OPTIONS, isOrganizationFontPreset, resolveOrganizationFontPreset } from '~/shared/organization-fonts'
import { parseSitePalette } from '~/shared/site-palette'
import { getErrorMessage } from '~/utils/errors'
import { ORIGINAL_LOGO_PRESENTATION } from '~/shared/media-placement-contract'

const props = withDefaults(defineProps<{ surface?: 'brand' | 'settings' }>(), { surface: 'settings' })
const surface = computed(() => props.surface)
const dashboardApi = useDashboardApi()
const route = useRoute()
const editorError = ref<string | null>(null)
const dashboard = useDashboardOrganization()
const organizationDashboardPath = computed(() => `/dashboard/${String(route.params.orgSlug)}`)
const brandPath = computed(() => `${organizationDashboardPath.value}/website/brand`)
const settingsPath = computed(() => `${organizationDashboardPath.value}/website`)
// The level runs while setup is still synchronous: it injects the record the
// `<RouterView>` above rendered, and an `await` before it would bind nothing.
const level = useRouteLevel()

const organizationId = await useDashboardOrganizationId()

interface SettingsPageResource {
  settings: { success: boolean; settings: OrganizationSettingsResponse }
}

const isSettingsResponse = (value: unknown): value is { success: boolean; settings: OrganizationSettingsResponse } =>
  isRecord(value) && typeof value.success === 'boolean' && isRecord(value.settings)
  && (value.settings.name === undefined || value.settings.name === null || typeof value.settings.name === 'string')
  && (value.settings.announcement === null || (isRecord(value.settings.announcement) && typeof value.settings.announcement.headline === 'string'))
  && (value.settings.font_preset === undefined || isOrganizationFontPreset(value.settings.font_preset))
  && (value.settings.palette === null || isRecord(value.settings.palette))
  && (value.settings.default_currency === undefined || value.settings.default_currency === null || typeof value.settings.default_currency === 'string')
  && [value.settings.seo_title, value.settings.seo_description, value.settings.canonical_url].every(field => field === null || typeof field === 'string')
  && (value.settings.consultation_mode === null || value.settings.consultation_mode === 'native' || value.settings.consultation_mode === 'external_url' || value.settings.consultation_mode === 'native_disabled')
  && isOrganizationStatus(value.settings.status)
function isOrganizationStatus(value: unknown): value is OrganizationStatus {
  return value === 'active' || value === 'inactive' || value === 'suspended'
}


/** Which leaf is open, named by the route below this rail rather than counted here. */
const detailKey = computed(() => level.child.value)
const saving = ref(false)
const theme = computed(() => loadedSettings.value?.theme)
const paletteSource = computed(() => loadedSettings.value?.palette_source ?? null)
const originalSignature = ref('')
const form = reactive<OrganizationSettingsForm>({
  name: '', brand_description: '',
  announcementEnabled: true, announcementAssetId: null, announcementHeadline: '', announcementDescription: '', announcementCtaLabel: '', announcementCtaUrl: '', announcementDismissible: true, announcementFormat: 'modal',
  logoAssetId: null, logoPresentation: ORIGINAL_LOGO_PRESENTATION, logoDarkAssetId: null, logoDarkPresentation: ORIGINAL_LOGO_PRESENTATION,
  faviconAssetId: null, socialShareAssetId: null, contact_email: '', palette: null, font_preset: 'default',
  default_currency: null, status: 'inactive',
  seo_title: '', seo_description: '', canonical_url: '', native_consultations: false,
})
const brandLocalizationFields = computed(() => [
  { key: 'name', label: 'Brand name', source: loadedSettings.value?.name },
  { key: 'brand_description', label: 'Description', source: loadedSettings.value?.brand_description, multiline: true, rows: 6 },
])
const nameCharactersRemaining = computed(() => 50 - form.name.length)
const descriptionCharactersRemaining = computed(() => 500 - form.brand_description.length)

function explicitSummary(value: string | null | undefined, empty = 'Not set') { return value?.trim() || empty }
const STATUS_LABELS: Record<OrganizationStatus, string> = { active: 'Live', inactive: 'Draft', suspended: 'Suspended' }
const domainSummary = computed(() => dashboard.organization.value?.custom_domain || dashboard.organization.value?.public_url || 'Not connected')
const CONSULTATION_MODE_SUMMARIES = { native: 'Online service selector', external_url: 'External scheduler', native_disabled: 'Selector hidden' } as const
const brandItems = computed<EditorNavigationItem[]>(() => [
  { id: 'name', label: 'Brand name', summary: explicitSummary(loadedSettings.value?.name), icon: 'i-lucide-type', to: `${brandPath.value}/name` },
  { id: 'logo', label: 'Logo', summary: loadedSettings.value?.media?.some(item => item.slot === 'logo') ? 'Logo selected' : 'Not set', icon: 'i-lucide-image', to: `${brandPath.value}/logo` },
  { id: 'favicon', label: 'Favicon', summary: loadedSettings.value?.media?.some(item => item.slot === 'favicon') ? 'Icon selected' : 'Not set', icon: 'i-lucide-app-window', to: `${brandPath.value}/favicon` },
  { id: 'sharing-image', label: 'Social sharing image', summary: loadedSettings.value?.media?.some(item => item.slot === 'social_share') ? 'Image selected' : 'Not set', icon: 'i-lucide-panels-top-left', to: `${brandPath.value}/sharing-image` },
  { id: 'description', label: 'Description', summary: explicitSummary(loadedSettings.value?.brand_description), icon: 'i-lucide-align-left', to: `${brandPath.value}/description` },
  { id: 'announcement', label: 'Announcement', summary: loadedSettings.value?.announcement?.enabled ? explicitSummary(loadedSettings.value.announcement.headline) : 'Off', icon: 'i-lucide-megaphone', to: `${brandPath.value}/announcement` },
  // Colors are Saya's and Blawby's; KrabiClaw's platform template keeps its own.
  ...(loadedSettings.value?.palette ? [{ id: 'color', label: 'Colors', summary: paletteSource.value === 'custom' ? 'Your colors' : 'Template colors', icon: 'i-lucide-palette', to: `${brandPath.value}/color` }] : []),
  { id: 'font', label: 'Website font', summary: ORGANIZATION_FONT_OPTIONS.find(option => option.value === loadedSettings.value?.font_preset)?.label ?? 'Default', icon: 'i-lucide-type', to: `${brandPath.value}/font` },
  { id: 'contact', label: 'Contact details', summary: explicitSummary(loadedSettings.value?.contact_email), icon: 'i-lucide-mail', to: `${brandPath.value}/contact` },
  { id: 'translations', label: 'Translations', summary: 'Translate the brand name and description', icon: 'i-lucide-languages', to: `${brandPath.value}?editMode=translations` },
])
// Flat, values on the rows, the way Edit preferences reads. The site's content
// lists and its Brand lead, because they are what the site is made of; the
// settings a visitor never sees follow.
const settingsItems = computed<EditorNavigationItem[]>(() => [
  ...(dashboard.organizationPaths.value ? [
    { id: 'pages', label: 'Pages', icon: 'i-lucide-file-text', to: dashboard.organizationPaths.value.pages },
    { id: 'blog', label: 'Blog', icon: 'i-lucide-newspaper', to: dashboard.organizationPaths.value.blog },
    { id: 'posts', label: 'Posts', icon: 'i-lucide-megaphone', to: dashboard.organizationPaths.value.posts },
    { id: 'qa', label: 'Reviews and Q&A', icon: 'i-lucide-message-circle-question', to: dashboard.organizationPaths.value.qa },
    { id: 'brand', label: 'Brand', summary: explicitSummary(loadedSettings.value?.name), icon: 'i-lucide-palette', to: brandPath.value },
  ] : []),
  { id: 'status', label: 'Status', summary: loadedSettings.value ? STATUS_LABELS[loadedSettings.value.status] : 'Not set', icon: 'i-lucide-radio', to: `${settingsPath.value}/status` },
  { id: 'domains', label: 'Domains', summary: domainSummary.value, icon: 'i-lucide-globe-2', to: `${settingsPath.value}/domains` },
  { id: 'localization', label: 'Languages', summary: 'Languages the site is published in', icon: 'i-lucide-languages', to: `${settingsPath.value}/localization` },
  { id: 'currency', label: 'Currency', summary: explicitSummary(loadedSettings.value?.default_currency), icon: 'i-lucide-coins', to: `${settingsPath.value}/currency` },
  { id: 'search', label: 'Search appearance', summary: explicitSummary(loadedSettings.value?.seo_title), icon: 'i-lucide-search', to: `${settingsPath.value}/search` },
  ...(loadedSettings.value?.consultation_mode
    ? [{ id: 'booking', label: 'Schedule page', summary: CONSULTATION_MODE_SUMMARIES[loadedSettings.value.consultation_mode], icon: 'i-lucide-calendar-check', to: `${settingsPath.value}/booking` }]
    : []),
])

const navigationGroups = computed(() => [surface.value === 'brand'
  ? { id: 'brand', items: brandItems.value }
  : { id: 'settings', items: settingsItems.value }])
const navbarTitle = computed(() => surface.value === 'brand' ? 'Brand' : 'Website')

// Leaving a section resets its editor. This used to hang off the back button's
// click handler, which left browser back with stale editor state.
watch(() => route.path, (next, previous) => {
  if (previous && previous !== next) resetDraft()
})

function editorSignature(key: string | null) {
  switch (key) {
    case 'name': return JSON.stringify(form.name)
    case 'logo': return JSON.stringify([form.logoAssetId, form.logoPresentation, form.logoDarkAssetId, form.logoDarkPresentation])
    case 'favicon': return JSON.stringify(form.faviconAssetId)
    case 'sharing-image': return JSON.stringify(form.socialShareAssetId)
    case 'description': return JSON.stringify(form.brand_description)
    case 'announcement': return JSON.stringify([form.announcementEnabled, form.announcementAssetId, form.announcementHeadline, form.announcementDescription, form.announcementCtaLabel, form.announcementCtaUrl, form.announcementDismissible, form.announcementFormat])
    case 'color': return JSON.stringify(form.palette)
    case 'font': return JSON.stringify(form.font_preset)
    case 'contact': return JSON.stringify(form.contact_email)
    case 'currency': return JSON.stringify(form.default_currency)
    case 'status': return JSON.stringify(form.status)
    case 'search': return JSON.stringify([form.seo_title, form.seo_description, form.canonical_url])
    case 'booking': return JSON.stringify(form.native_consultations)
    default: return ''
  }
}
function isValidUrl(value: string) {
  if (!value.trim()) return true
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' } catch { return false }
}
// Nothing is a draft until settings have loaded: an unfilled form is not an edit.
const dirty = computed(() => loadedSettings.value !== null && editorSignature(detailKey.value) !== originalSignature.value)
const validationMessage = computed(() => {
  if (!dirty.value) return null
  switch (detailKey.value) {
    case 'name': return form.name.trim() ? null : 'Enter a brand name.'
    case 'announcement': {
      if (!form.announcementEnabled) return null
      if (!form.announcementHeadline.trim() || form.announcementHeadline.length > 120) return 'Enter a headline of 120 characters or fewer.'
      if (form.announcementDescription.length > 500) return 'Keep the description within 500 characters.'
      if (Boolean(form.announcementCtaLabel.trim()) !== Boolean(form.announcementCtaUrl.trim())) return 'A button needs both a label and a URL.'
      if (form.announcementCtaUrl.trim() && !isValidUrl(form.announcementCtaUrl)) return 'Enter a complete http or https button URL.'
      return null
    }
    case 'color': {
      try {
        parseSitePalette(form.palette)
        return null
      } catch (error) {
        return (error as Error).message.replace(/^palette\.(light|dark)\.(\w+) must be a #RRGGBB color$/, 'Enter a six-digit hex color for $2 ($1).')
      }
    }
    case 'font': return isOrganizationFontPreset(form.font_preset) ? null : 'Choose a supported website font.'
    case 'contact': return !form.contact_email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contact_email) ? null : 'Enter a valid email address.'
    case 'status': return form.status === 'suspended' ? 'This website is suspended. Contact support to restore it.' : null
    case 'search': return isValidUrl(form.canonical_url) ? null : 'Enter a complete http or https URL.'
    default: return null
  }
})
const saveDisabled = computed(() => {
  return !dirty.value || validationMessage.value !== null
})

function fillForm(settings: OrganizationSettingsResponse) {
  form.name = settings.name ?? ''
  form.brand_description = settings.brand_description ?? ''
  form.announcementEnabled = settings.announcement?.enabled ?? false
  form.announcementAssetId = settings.media?.find(item => item.slot === 'announcement')?.asset_id ?? null
  form.announcementHeadline = settings.announcement?.headline ?? ''
  form.announcementDescription = settings.announcement?.description ?? ''
  form.announcementCtaLabel = settings.announcement?.cta_label ?? ''
  form.announcementCtaUrl = settings.announcement?.cta_url ?? ''
  form.announcementDismissible = settings.announcement?.dismissible ?? true
  form.announcementFormat = settings.announcement?.format === 'banner' ? 'banner' : 'modal'
  const logo = settings.media?.find(item => item.slot === 'logo')
  const logoDark = settings.media?.find(item => item.slot === 'logo_dark')
  form.logoAssetId = logo?.asset_id ?? null
  form.logoPresentation = logo?.presentation ?? ORIGINAL_LOGO_PRESENTATION
  form.logoDarkAssetId = logoDark?.asset_id ?? null
  form.logoDarkPresentation = logoDark?.presentation ?? ORIGINAL_LOGO_PRESENTATION
  form.faviconAssetId = settings.media?.find(item => item.slot === 'favicon')?.asset_id ?? null
  form.socialShareAssetId = settings.media?.find(item => item.slot === 'social_share')?.asset_id ?? null
  form.contact_email = settings.contact_email ?? ''
  form.palette = settings.palette && structuredClone(settings.palette)
  form.font_preset = resolveOrganizationFontPreset(settings.font_preset)
  // A stored value that is not a supported code is not this form's to reinterpret:
  // showing it as USD invited the owner to save that over whatever is really there.
  form.default_currency = isCurrencyCode(settings.default_currency) ? settings.default_currency : null
  form.status = settings.status
  form.seo_title = settings.seo_title ?? ''
  form.seo_description = settings.seo_description ?? ''
  form.canonical_url = settings.canonical_url ?? ''
  form.native_consultations = settings.consultation_mode === 'native'
}
function resetDraft() {
  editorError.value = null
  if (loadedSettings.value) fillForm(loadedSettings.value)
  originalSignature.value = editorSignature(detailKey.value)
}

const settingsResourceKey = computed(() => `dashboard-organization-settings:${String(route.params.orgSlug)}`)
const { data: settingsResource, error: settingsResourceError, refresh: refreshSettingsResource } = await useAsyncData<SettingsPageResource>(settingsResourceKey, async () => {
  const [settings] = await Promise.all([
    dashboardApi<{ success: boolean; settings: OrganizationSettingsResponse }>('/api/dashboard/settings', { validate: isSettingsResponse }),
  ])
  return { settings }
})
// The saved settings are what the request answered; the form is the draft seeded from each answer.
const loadedSettings = computed(() => settingsResource.value?.settings.settings ?? null)
const loadError = computed(() => settingsResourceError.value ? getErrorMessage(settingsResourceError.value, 'Failed to load organization settings') : null)
watch(settingsResource, (resource) => {
  if (!resource) return
  fillForm(resource.settings.settings)
  originalSignature.value = editorSignature(detailKey.value)
}, { immediate: true })
watch(detailKey, () => resetDraft())

async function patchSettings(body: Record<string, unknown>) {
  const response = await dashboardApi<{ success: boolean; settings: OrganizationSettingsResponse }>('/api/dashboard/settings', { method: 'PATCH', body, validate: isSettingsResponse })
  // Website and Brand read the same settings resource; writing the response
  // through it keeps the other list's rows on the saved values.
  settingsResource.value = { settings: response }
  await dashboard.refresh()
}
async function refreshSettings() {
  await refreshSettingsResource()
  if (settingsResourceError.value) throw settingsResourceError.value
}
async function resetPalette() {
  saving.value = true
  editorError.value = null
  try { await patchSettings({ palette: null }) } catch (error) { editorError.value = getErrorMessage(error, 'Failed to reset the colors') } finally { saving.value = false }
}
function logoUrl(assetId: string | null) {
  return assetId ? loadedSettings.value?.media?.find(item => item.asset_id === assetId)?.public_url ?? null : null
}
async function saveCurrentEditor() {
  if (saveDisabled.value || !detailKey.value) return
  saving.value = true
  editorError.value = null
  try {
    switch (detailKey.value) {
      case 'name': await patchSettings({ name: form.name.trim() }); break
      case 'logo': await patchSettings({ media: [
        { asset_id: form.logoAssetId, slot: 'logo', presentation: form.logoAssetId ? form.logoPresentation : null },
        { asset_id: form.logoDarkAssetId, slot: 'logo_dark', presentation: form.logoDarkAssetId ? form.logoDarkPresentation : null },
      ] }); break
      case 'favicon': await patchSettings({ media: [{ asset_id: form.faviconAssetId, slot: 'favicon' }] }); break
      case 'sharing-image': await patchSettings({ media: [{ asset_id: form.socialShareAssetId, slot: 'social_share' }] }); break
      case 'description': await patchSettings({ brand_description: form.brand_description }); break
      case 'announcement': {
        await patchSettings({
          announcement: {
            headline: form.announcementHeadline.trim(),
            description: form.announcementDescription.trim() || null,
            cta_label: form.announcementCtaLabel.trim() || null,
            cta_url: form.announcementCtaUrl.trim() || null,
            dismissible: form.announcementDismissible,
            enabled: form.announcementEnabled,
            format: form.announcementFormat,
          },
          media: [{ asset_id: form.announcementAssetId, slot: 'announcement' }],
        })
        break
      }
      case 'color': await patchSettings({ palette: form.palette }); break
      case 'font': await patchSettings({ font_preset: form.font_preset }); break
      case 'contact': await patchSettings({ contact_email: form.contact_email.trim() }); break
      case 'currency': {
        if (!form.default_currency) throw new Error('Choose the currency this organization prices in.')
        await patchSettings({ default_currency: form.default_currency })
        break
      }
      case 'status': await patchSettings({ status: form.status }); break
      case 'search': await patchSettings({ seo_title: form.seo_title.trim() || null, seo_description: form.seo_description.trim() || null, canonical_url: form.canonical_url.trim() || null }); break
      case 'booking': {
        const current = loadedSettings.value?.consultation_mode
        if (!current) throw new Error('This website has no booking to switch.')
        // The one writer of the consultation mode, shared with MCP's set_consultation_mode.
        await dashboardApi(`/api/editor/organizations/${organizationId}/consultation`, {
          method: 'PUT', body: { mode: form.native_consultations ? 'native' : current === 'native' ? 'native_disabled' : current }, validate: isRecord,
        })
        await refreshSettings()
        break
      }
    }
  } catch (error) { editorError.value = getErrorMessage(error, 'Failed to save this setting') } finally { saving.value = false }
}
provide(organizationSettingsEditorKey, {
  form,
  organizationId,
  saving,
  saveDisabled,
  // A leaf opened on settings that failed to load shows why.
  editorError: computed(() => loadError.value ?? editorError.value),
  validationMessage,
  nameCharactersRemaining,
  descriptionCharactersRemaining,
  theme,
  paletteSource,
  resetPalette,
  consultationMode: computed(() => loadedSettings.value?.consultation_mode ?? null),
  logoUrl,
  // A cancelled leaf puts the loaded settings back before it closes.
  revert: resetDraft,
  save: saveCurrentEditor,
})
</script>
