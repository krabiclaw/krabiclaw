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
  // and then save — one person's settings under another person's session. The
  // key is read on every access because the session often arrives after mount,
  // and a response is written under the account that asked for it.
  type Entry = { preferences: NotificationPreferenceMap | null; error: string | null }
  const accounts = useState<Record<string, Entry>>('account-notification-preferences', () => ({}))
  const key = () => toValue(userId) ?? 'anonymous'
  const write = (owner: string, entry: Partial<Entry>) => {
    accounts.value[owner] = { preferences: null, error: null, ...accounts.value[owner], ...entry }
  }
  const state = computed(() => accounts.value[key()]?.preferences ?? null)
  const error = computed(() => accounts.value[key()]?.error ?? null)

  async function load(force = false) {
    if (state.value && !force) return
    const owner = key()
    write(owner, { error: null })
    try {
      const response = await applicationFetch<{ preferences: NotificationPreferenceMap }>(
        '/api/user/notification-preferences',
        { validate: isPreferenceMap },
      )
      write(owner, { preferences: response.preferences })
    } catch (cause) {
      write(owner, { error: cause instanceof Error ? cause.message : 'Could not load your notification settings.' })
    }
  }

  async function save(category: NotificationCategory, setting: NotificationCategorySetting) {
    const owner = key()
    const response = await applicationFetch<{ preferences: NotificationPreferenceMap }>(
      '/api/user/notification-preferences',
      { method: 'PATCH', body: { category, ...setting }, validate: isPreferenceMap },
    )
    write(owner, { preferences: response.preferences })
  }

  return { preferences: state, error, load, save }
}
