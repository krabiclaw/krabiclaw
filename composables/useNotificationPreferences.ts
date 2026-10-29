import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationCategorySetting,
} from '~/shared/notification-categories'

export type NotificationPreferenceMap = Record<NotificationCategory, NotificationCategorySetting>
export type NotificationCategoryLabelMap = Record<NotificationCategory, string>

interface PreferencesResponse {
  preferences: NotificationPreferenceMap
  labels: NotificationCategoryLabelMap
}

function isPreferencesResponse(value: unknown): value is PreferencesResponse {
  if (!isRecord(value) || !isRecord(value.preferences) || !isRecord(value.labels)) return false
  const { preferences, labels } = value as { preferences: Record<string, unknown>; labels: Record<string, unknown> }
  return NOTIFICATION_CATEGORIES.every((category) => {
    const setting = preferences[category]
    return isRecord(setting) && typeof setting.email === 'boolean' && typeof setting.whatsapp === 'boolean' && typeof setting.push === 'boolean'
      && typeof labels[category] === 'string'
  })
}

/**
 * One copy of the signed-in account's notification preferences.
 *
 * The index previews every category and the leaf edits one, so both read this
 * rather than fetching their own: a save in the leaf has to change what the row
 * behind it says, and two fetches would let those disagree.
 */
export function useNotificationPreferences(userId: MaybeRefOrGetter<string | null | undefined>) {
  // Keyed by account. A sign-out followed by a sign-in without a document
  // reload keeps the old key's payload alive, and an unscoped key would show —
  // and then save — one person's settings under another person's session. The
  // key is read on every access because the session often arrives after mount,
  // and a response is written under the account that asked for it.
  type Entry = { preferences: NotificationPreferenceMap | null; labels: NotificationCategoryLabelMap | null; error: string | null }
  const accounts = useState<Record<string, Entry>>('account-notification-preferences', () => ({}))
  const key = () => toValue(userId) ?? 'anonymous'
  const write = (owner: string, entry: Partial<Entry>) => {
    accounts.value[owner] = { preferences: null, labels: null, error: null, ...accounts.value[owner], ...entry }
  }
  const state = computed(() => accounts.value[key()]?.preferences ?? null)
  const labels = computed(() => accounts.value[key()]?.labels ?? null)
  const error = computed(() => accounts.value[key()]?.error ?? null)

  async function load(force = false) {
    if (state.value && !force) return
    const owner = key()
    write(owner, { error: null })
    try {
      const response = await applicationFetch<PreferencesResponse>(
        '/api/user/notification-preferences',
        { validate: isPreferencesResponse },
      )
      write(owner, { preferences: response.preferences, labels: response.labels })
    } catch (cause) {
      write(owner, { error: cause instanceof Error ? cause.message : 'Could not load your notification settings.' })
    }
  }

  async function save(category: NotificationCategory, setting: NotificationCategorySetting) {
    const owner = key()
    const response = await applicationFetch<PreferencesResponse>(
      '/api/user/notification-preferences',
      { method: 'PATCH', body: { category, ...setting }, validate: isPreferencesResponse },
    )
    write(owner, { preferences: response.preferences, labels: response.labels })
  }

  return { preferences: state, labels, error, load, save }
}
