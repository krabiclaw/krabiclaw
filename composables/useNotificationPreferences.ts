import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationCategorySetting,
} from '~/shared/notification-categories'

export type NotificationPreferenceMap = Record<NotificationCategory, NotificationCategorySetting>

function isPreferenceMap(value: unknown): value is { preferences: NotificationPreferenceMap } {
  if (!isRecord(value) || !isRecord(value.preferences)) return false
  return NOTIFICATION_CATEGORIES.every((category) => {
    const setting = (value.preferences as Record<string, unknown>)[category]
    return isRecord(setting) && typeof setting.email === 'boolean' && typeof setting.whatsapp === 'boolean' && typeof setting.push === 'boolean'
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
  // and then save — one person's settings under another person's session.
  const key = computed(() => `account-notification-preferences:${toValue(userId) ?? 'anonymous'}`)
  const state = useState<NotificationPreferenceMap | null>(key.value, () => null)
  const error = useState<string | null>(`${key.value}:error`, () => null)

  async function load(force = false) {
    if (state.value && !force) return
    error.value = null
    try {
      const response = await applicationFetch<{ preferences: NotificationPreferenceMap }>(
        '/api/user/notification-preferences',
        { validate: isPreferenceMap },
      )
      state.value = response.preferences
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Could not load your notification settings.'
    }
  }

  async function save(category: NotificationCategory, setting: NotificationCategorySetting) {
    const response = await applicationFetch<{ preferences: NotificationPreferenceMap }>(
      '/api/user/notification-preferences',
      { method: 'PATCH', body: { category, ...setting }, validate: isPreferenceMap },
    )
    state.value = response.preferences
  }

  return { preferences: state, error, load, save }
}
