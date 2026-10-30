<template>
  <!--
    Account settings: a row per section, each a leaf below. Where there is a
    pane it opens on Personal information, the way the reference does.
  -->
  <DashboardIndexPanel id="account-profile" title="Account settings" :auto-open="`${level.path.value}/personal`">
    <EditorNavigationList :groups="groups" :active-item="openRow" @act="runRowAction" />
  </DashboardIndexPanel>

  <!-- OTP Verification Modal -->
  <UModal v-model:open="verifyModalOpen" :ui="{ content: 'max-w-sm' }">
    <template #content>
      <div class="p-6 space-y-4">
        <div>
          <h3 class="text-lg font-semibold text-highlighted">Enter the code</h3>
          <p class="mt-1 text-sm text-muted">Sent to {{ formatPhone(phoneInput) }} on WhatsApp.</p>
        </div>
        
        <UAlert v-if="verifyError" color="error" variant="soft" :description="verifyError" />

        <UInput
          v-model="otpCode"
          placeholder="000000"
          class="font-mono text-center text-lg tracking-widest"
          maxlength="6"
          :disabled="otpVerifying"
          @keydown.enter="verifyPhone"
        />

        <div class="flex justify-end gap-2 pt-2">
          <UButton variant="ghost" color="neutral" :disabled="otpVerifying" @click="verifyModalOpen = false">
            Cancel
          </UButton>
          <UButton
            :loading="otpVerifying"
            :disabled="otpCode.length !== 6"
            @click="verifyPhone"
          >
            Verify
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>

<script lang="ts">
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { PlatformThemePreference } from '~/composables/usePlatformTheme'

export const DETAIL_LABELS: Record<string, string> = {
  personal: 'Personal information',
  login: 'Login & security',
  notifications: 'Notifications',
  appearance: 'Appearance',
  calendar: 'Profile & availability',
}

/** The signed-in person's account, for the three leaves that edit parts of it. */
export interface AccountEditor {
  sessionData: ComputedRef<{
    user?: { id: string; name?: string | null; email?: string | null; image?: string | null; phoneNumber?: string | null; phoneNumberVerified?: boolean | null; emailVerified?: boolean | null } | null
    session?: { token?: string | null } | null
  } | null | undefined>
  // personal information: rows that edit in place
  editing: Ref<'photo' | 'name' | 'phone' | null>
  toggleEdit: (row: 'photo' | 'name' | 'phone') => void
  photoPreview: Ref<string | null>
  photoSaving: Ref<boolean>
  photoError: Ref<string>
  pickPhoto: (event: Event) => Promise<void>
  nameInput: Ref<string>
  nameDirty: ComputedRef<boolean>
  nameSaving: Ref<boolean>
  nameError: Ref<string | null>
  nameTouched: Ref<boolean>
  saveNameInline: () => Promise<void>
  phoneInput: Ref<string>
  phoneDirty: ComputedRef<boolean>
  phoneSaving: Ref<boolean>
  phoneError: Ref<string | null>
  phoneTouched: Ref<boolean>
  requestPhoneVerify: () => Promise<void>
  // login & security
  loginProviderStatus: (provider: LoginProvider) => 'connected' | 'not-connected' | 'error'
  connectingProvider: Ref<LoginProvider | null>
  connectError: Ref<string | null>
  connectProvider: (provider: LoginProvider) => Promise<void>
  sessions: Ref<Array<{ token: string; current: boolean; userAgent?: string | null; ipAddress?: string | null; updatedAt: string | Date }>>
  sessionsError: Ref<string | null>
  revoking: Ref<string | null>
  revokeDevice: (token: string) => Promise<void>
  describeDevice: (userAgent?: string | null) => string
  formatExactDateTime: (value: string | Date, options?: { includeTime?: boolean }) => string
  deleteError: Ref<string>
  deleting: Ref<boolean>
  deleteConfirmText: Ref<string>
  confirmDeleteAccount: () => Promise<void>
  // appearance
  themeInput: Ref<PlatformThemePreference>
  themeOptions: Array<{ label: string; value: PlatformThemePreference; description?: string }>
  saveDisabled: ComputedRef<boolean>
  revert: () => void
  save: () => Promise<void>
}

/** The providers a person can add as another way to sign in to the same account. */
export const LOGIN_PROVIDERS = [{ id: 'google', label: 'Google' }, { id: 'apple', label: 'Apple' }] as const
export type LoginProvider = typeof LOGIN_PROVIDERS[number]['id']

export const accountEditorKey = Symbol('account-editor') as InjectionKey<AccountEditor>
</script>

<script setup lang="ts">
import { dashboardScopeHeaderModelKey } from '~/lib/components/workspace/dashboard/dashboardScopeHeaderContext'
// -nocheck
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { authClient } from '~/lib/auth-client'
import { parsePhoneOrThrow, formatPhone } from '~/utils/phone'


// The level runs while setup is still synchronous: it injects the record the
// `<RouterView>` above rendered, and an `await` before it would bind nothing.
const level = useRouteLevel()
// The organizations this account belongs to, read off the layout's one list of them.
const scopeHeaderModel = inject(dashboardScopeHeaderModelKey, null)
const organizationsSummary = computed(() => {
  const count = (scopeHeaderModel?.value.peers ?? []).filter(peer => peer.id).length
  return count === 0 ? 'New organization' : count === 1 ? '1 organization' : `${count} organizations`
})
const profilePath = level.path
const session = authClient.useSession()
const sessionData = computed(() => session.value.data)
async function refreshSession() {
  await session.value.refetch()
  if (session.value.error) throw new Error(session.value.error.message || 'Your session could not be refreshed.')
}

const { logOut, organization } = useDashboardMenu()
const { formatExactDateTime } = useHumanTime()

// Whether this account can sign in with Google or Apple, shown in the Login
// leaf beside the address, where either can be added as another way into the
// same account. An error stays distinct from "not connected": defaulting a
// failed lookup to false would misreport a real linked account as unlinked.
const { data: linkedAccounts, error: linkedAccountsError } = await useAsyncData('account-linked-accounts', async () => {
  const { data, error } = await authClient.listAccounts()
  if (error) throw createError({ statusCode: error.status, statusMessage: error.message || 'Linked accounts could not be loaded' })
  return data
})
function loginProviderStatus(provider: LoginProvider) {
  if (linkedAccountsError.value) return 'error' as const
  return linkedAccounts.value?.some((account: { providerId: string }) => account.providerId === provider) ? 'connected' as const : 'not-connected' as const
}
// Better Auth links the provider account and returns here; a refusal (for
// example an Apple ID already signed in as another account) comes back as `error`.
const route = useRoute()
const connectingProvider = ref<LoginProvider | null>(null)
const connectError = ref<string | null>(typeof route.query.error === 'string' ? oauthErrorMessage(route.query.error, route.query.error_description) : null)
async function connectProvider(provider: LoginProvider) {
  connectingProvider.value = provider
  connectError.value = null
  const callbackURL = route.path
  const { error } = await authClient.linkSocial({ provider, callbackURL, errorCallbackURL: callbackURL })
  if (error) {
    connectError.value = error.message || 'That sign-in could not be added.'
    connectingProvider.value = null
  }
}

// Device history: the sessions Better Auth holds for this user. The current
// one is the token in hand; every other row can be logged out from here.
interface DeviceSession { token: string; userAgent?: string | null; ipAddress?: string | null; updatedAt: string | Date }
const sessions = ref<Array<DeviceSession & { current: boolean }>>([])
const sessionsError = ref<string | null>(null)
const revoking = ref<string | null>(null)

async function loadSessions() {
  const { data, error } = await authClient.listSessions()
  if (error) {
    sessionsError.value = error.message || 'Devices could not be loaded.'
    return
  }
  const current = sessionData.value?.session?.token
  sessions.value = ((data ?? []) as DeviceSession[])
    .map(item => ({ ...item, current: item.token === current }))
    .sort((a, b) => Number(b.current) - Number(a.current) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

async function revokeDevice(token: string) {
  revoking.value = token
  try {
    const { error } = await authClient.revokeSession({ token })
    if (error) throw new Error(error.message || 'Logging out that device failed.')
    await loadSessions()
  } catch (cause) {
    sessionsError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    revoking.value = null
  }
}

function describeDevice(userAgent?: string | null) {
  const ua = userAgent ?? ''
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : null
  return [os, browser].filter(Boolean).join(' · ') || 'Unknown device'
}

// Appearance is a preference of the person, kept on this device.
const { preference: themePreference, setPreference: setThemePreference } = usePlatformTheme()
type ThemePreference = 'system' | 'light' | 'dark'
const THEME_OPTIONS: { label: string; description: string; value: ThemePreference }[] = [
  { label: 'System', description: 'Follow your device appearance.', value: 'system' },
  { label: 'Light', description: 'Always use the light dashboard.', value: 'light' },
  { label: 'Dark', description: 'Always use the dark dashboard.', value: 'dark' },
]
const themeInput = ref<ThemePreference>(themePreference.value)
watch(themePreference, saved => { themeInput.value = saved })
const themeDirty = computed(() => themeInput.value !== themePreference.value)
// Photo
//
// Better Auth owns `user.image`, so the upload posts the file to our own route,
// which stores it in Cloudflare Images and writes the URL back through Better
// Auth. Saving happens on pick — there is one control and nothing to commit.
const photoPreview = ref<string | null>(null)
const photoSaving = ref(false)
const photoError = ref('')

async function pickPhoto(event: Event) {
  const file = (event.target as HTMLInputElement | null)?.files?.[0]
  if (!file) return
  photoSaving.value = true
  photoError.value = ''
  let imageSaved = false
  const body = new FormData()
  body.append('file', file)
  try {
    const result = await applicationFetch<{ image: string; previousImageCleanupError?: string }>('/api/user/avatar', {
      method: 'POST',
      body,
      validate: (value): value is { image: string; previousImageCleanupError?: string } => isRecord(value)
        && typeof value.image === 'string' && Boolean(value.image.trim())
        && (!Object.hasOwn(value, 'previousImageCleanupError') || typeof value.previousImageCleanupError === 'string'),
    })
    photoPreview.value = result.image
    imageSaved = true
    photoError.value = result.previousImageCleanupError ?? ''
    await refreshSession()
    editing.value = null
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'Upload failed. Please try again.'
    photoError.value = [photoError.value, imageSaved ? `Your new photo is saved, but your session could not be refreshed: ${reason}` : reason].filter(Boolean).join(' ')
  } finally {
    photoSaving.value = false
  }
}

// Display Name
const nameInput = ref(sessionData.value?.user?.name || '')
const nameDirty = computed(() => nameInput.value.trim() !== (sessionData.value?.user?.name || ''))
const nameSaving = ref(false)
// Which Personal information row is open for editing. One at a time, the way
// the reference expands one row and leaves the rest as they are.
const editing = ref<'photo' | 'name' | 'phone' | null>(null)
function toggleEdit(row: 'photo' | 'name' | 'phone') {
  if (editing.value === row) {
    cancelEdit()
    editing.value = null
    return
  }
  cancelEdit()
  editing.value = row
}
const detailKey = computed(() => level.child.value)
const openKey = computed(() => detailKey.value ?? 'personal')

// The current token arrives with the session fetch; until it has, every
// device would read as another device, with a Log out it must not have.
watch(() => [openKey.value === 'login', sessionData.value?.session?.token] as const, ([open, token]) => { if (open && token) void loadSessions() }, { immediate: true })

const { preferences: notificationPreferences, load: loadNotificationPreferences } = useNotificationPreferences(() => sessionData.value?.user?.id)
await loadNotificationPreferences()

/** How many categories currently reach this person at all. */
const notificationSummary = computed(() => {
  const preferences = notificationPreferences.value
  if (!preferences) return ''
  const settings = Object.values(preferences)
  const on = settings.filter(setting => setting.email || setting.whatsapp || setting.push).length
  return on === settings.length ? 'All on' : `${on} of ${settings.length} on`
})

const groups = computed<EditorNavigationGroup[]>(() => [
  {
    id: 'account',
    items: [
      { id: 'personal', icon: 'i-lucide-contact-round', label: 'Personal information', summary: [sessionData.value?.user?.name, sessionData.value?.user?.phoneNumber].filter(Boolean).join(' · ') || 'Name, photo, WhatsApp number', to: `${profilePath.value}/personal` },
      { id: 'login', icon: 'i-lucide-shield-check', label: 'Login & security', summary: sessionData.value?.user?.email ?? '', to: `${profilePath.value}/login` },
      { id: 'notifications', icon: 'i-lucide-bell', label: 'Notifications', summary: notificationSummary.value, to: `${profilePath.value}/notifications` },
      // Inside an organization, availability is that organization's; Personal names one first.
      ...((scopeHeaderModel?.value.peers ?? []).some(peer => peer.id) ? [{ id: 'calendar', icon: 'i-lucide-calendar-clock', label: 'Profile & availability', summary: 'Public profile, hours, time off and Google Calendar', to: organization.value ? `${profilePath.value}/calendar/${encodeURIComponent(organization.value.id)}` : `${profilePath.value}/calendar` }] : []),
      { id: 'appearance', icon: 'i-lucide-sun-moon', label: 'Appearance', summary: `${themePreference.value.charAt(0).toUpperCase()}${themePreference.value.slice(1)} theme`, to: `${profilePath.value}/appearance` },
      { id: 'payments', icon: 'i-lucide-credit-card', label: 'Payments', summary: 'Your payments and refunds', to: `${profilePath.value}/payments` },
      { id: 'organizations', icon: 'i-lucide-building-2', label: 'Organizations', summary: organizationsSummary.value, to: `${profilePath.value}/organizations` },
      { id: 'log-out', icon: 'i-lucide-log-out', label: 'Log out', action: {} },
    ],
  },
])

// The row whose screen is open. Profile & availability opens an organization's
// screen below its own URL, so the open row is the one the path sits under.
const openRow = computed(() => groups.value[0]!.items.find(item => item.to && (route.path === item.to || route.path.startsWith(`${item.to}/`)))?.id ?? null)

function runRowAction(id: string) {
  if (id === 'log-out') void logOut()
}

// Personal information and Login & security carry their own controls on
// each row; only Appearance commits from the footer.
const saveDisabled = computed(() => !themeDirty.value)

async function saveDetail() {
  if (saveDisabled.value) return
  setThemePreference(themeInput.value)
  await level.close()
}

const nameError = ref<string | null>(null)
const phoneError = ref<string | null>(null)



function cancelEdit() {
  nameInput.value = sessionData.value?.user?.name || ''
  phoneInput.value = sessionData.value?.user?.phoneNumber || ''
  nameTouched.value = false
  phoneTouched.value = false
  nameError.value = null
  phoneError.value = null
  themeInput.value = themePreference.value
  deleteConfirmText.value = ''
  deleteError.value = ''
}

async function saveName() {
  if (!nameDirty.value) return false
  nameSaving.value = true
  nameError.value = null
  try {
    await authClient.updateUser({ name: nameInput.value.trim() }, { throw: true })
    await refreshSession()
    return true
  } catch (_err) {
    const msg = _err instanceof Error ? _err.message : String(_err)
    nameError.value = msg
    return false
  } finally {
    nameSaving.value = false
  }
}

async function saveNameInline() {
  if (await saveName()) editing.value = null
}

// The session resolves asynchronously, so nameInput starts as '' before
// the real name arrives. Gating the sync on nameDirty breaks the moment that
// happens: dirty is computed against sessionData too, so populating the name
// alone (no user input at all) flips '' !== 'RealName' to dirty and the sync
// never runs — the field is stuck blank. nameTouched tracks only genuine user
// edits (set from @input, a native DOM event a programmatic ref assignment
// never dispatches), independent of what the comparison side is doing.
const nameTouched = ref(false)
watch(() => sessionData.value?.user?.name, (newVal) => {
  if (newVal !== undefined && !nameTouched.value) nameInput.value = newVal || ''
}, { immediate: true })

// Phone Number
const phoneInput = ref(sessionData.value?.user?.phoneNumber || '')
const phoneDirty = computed(() => phoneInput.value.trim() !== (sessionData.value?.user?.phoneNumber || ''))
const phoneSaving = ref(false)
const verifyModalOpen = ref(false)
const otpCode = ref('')
const otpVerifying = ref(false)
const verifyError = ref('')

async function requestPhoneVerify() {
  if (phoneSaving.value || !phoneDirty.value || !phoneInput.value.trim()) return
  phoneSaving.value = true
  phoneError.value = null
  try {
    const phoneNumber = parsePhoneOrThrow(phoneInput.value)
    const res = await authClient.phoneNumber.sendOtp({ phoneNumber })
    if (res.error) throw new Error(res.error.message || 'Failed to send OTP')
    phoneInput.value = phoneNumber
    
    otpCode.value = ''
    verifyError.value = ''
    verifyModalOpen.value = true
  } catch (_err) {
    const msg = _err instanceof Error ? _err.message : String(_err)
    phoneError.value = msg
  } finally {
    phoneSaving.value = false
  }
}

async function verifyPhone() {
  if (otpCode.value.length !== 6) return
  otpVerifying.value = true
  verifyError.value = ''
  try {
    const res = await authClient.phoneNumber.verify({
      phoneNumber: phoneInput.value.trim(),
      code: otpCode.value.trim(),
      updatePhoneNumber: true,
    })
    if (res.error) throw new Error(res.error.message || 'Invalid code')
    
    await refreshSession()
    verifyModalOpen.value = false
    editing.value = null
  } catch (_err) {
    verifyError.value = _err instanceof Error ? _err.message : String(_err)
  } finally {
    otpVerifying.value = false
  }
}

const phoneTouched = ref(false)
watch(() => sessionData.value?.user?.phoneNumber, (newVal) => {
  if (newVal !== undefined && !phoneTouched.value) phoneInput.value = newVal || ''
}, { immediate: true })

// Danger Zone
const deleteConfirmText = ref('')
const deleting = ref(false)
const deleteError = ref('')

// Better Auth owns account deletion and session/cookie invalidation. The
// dashboard adds only the explicit destructive confirmation.
async function confirmDeleteAccount() {
  if (deleteConfirmText.value !== 'DELETE') return
  deleting.value = true
  deleteError.value = ''

  try {
    const { error } = await authClient.deleteUser()
    if (error) throw new Error(error.message || 'Account deletion failed. Please try again.')
    await navigateTo('/', { replace: true })
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : 'Account deletion failed. Please try again.'
  } finally {
    deleting.value = false
  }
}

useSeoMeta({ title: 'Account settings | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
provide(accountEditorKey, {
  sessionData,
  editing, toggleEdit,
  photoPreview, photoSaving, photoError, pickPhoto,
  nameInput, nameDirty, nameSaving, nameError, nameTouched, saveNameInline,
  phoneInput, phoneDirty, phoneSaving, phoneError, phoneTouched, requestPhoneVerify,
  loginProviderStatus, connectingProvider, connectError, connectProvider, sessions, sessionsError, revoking, revokeDevice, describeDevice, formatExactDateTime,
  deleteError, deleting, deleteConfirmText, confirmDeleteAccount,
  themeInput, themeOptions: [...THEME_OPTIONS], saveDisabled,
  revert: cancelEdit,
  save: saveDetail,
})
</script>
