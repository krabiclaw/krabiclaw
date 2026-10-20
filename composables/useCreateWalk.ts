import type { MaybeRefOrGetter, Ref } from 'vue'

/** The words for a record being made, wherever one is: its title and the action that makes it. */
export function newRecordLabels(noun: string) {
  return { title: `New ${noun}`, action: `Create ${noun}` }
}

/**
 * Creating a record walks the sections its endpoint will not accept empty, in
 * order. Its index is titled `New post` and opens the first outstanding section
 * at once (`firstStep`, for DashboardIndexPanel's `create`); each leaf names
 * where it goes next — `Next: Body` while sections remain, `Create post` on the
 * last one — and the commit runs once nothing is outstanding. An existing
 * record saves the open section outright, and is blocked only while that
 * section itself is incomplete.
 */
export function useCreateWalk<K extends string>(options: {
  recordPath: Ref<string>
  isNew: Ref<boolean>
  openKey: Ref<K>
  labels: Record<K, string> | Ref<Record<K, string>>
  /**
   * Read on every evaluation, because a record whose type is chosen inside the
   * walk does not know its own sections until then: a page section's order is
   * `type` alone until a type is picked, and the sections that type requires
   * afterwards.
   */
  order: MaybeRefOrGetter<readonly K[]>
  /** Whether this section still blocks creating. */
  missing: (key: K) => boolean
  /** Names the record in `Create <noun>`. */
  noun: MaybeRefOrGetter<string>
  saving: Ref<boolean>
  /** What blocks saving an existing record; by default an incomplete open section. */
  existingBlocked?: (outstanding: readonly K[]) => boolean
  commit: () => Promise<void>
}) {
  const route = useRoute()
  const label = (key: K) => toValue(options.labels)[key]
  const outstanding = computed(() => toValue(options.order).filter(key => options.missing(key)))
  const nextOutstanding = computed(() => outstanding.value.find(key => key !== options.openKey.value) ?? null)
  const openSectionIncomplete = computed(() => outstanding.value.includes(options.openKey.value))

  const words = computed(() => newRecordLabels(toValue(options.noun)))
  // The section a new record opens on: the first still outstanding, else the last.
  const firstStep = computed(() => {
    if (!options.isNew.value) return null
    const order = toValue(options.order)
    const step = outstanding.value[0] ?? order.at(-1)
    return step ? { path: `${options.recordPath.value}/${step}`, query: route.query } : null
  })
  const saveLabel = computed(() => {
    if (!options.isNew.value) return undefined
    return nextOutstanding.value ? `Next: ${label(nextOutstanding.value)}` : words.value.action
  })
  const saveDisabled = computed(() => options.saving.value
    || (options.isNew.value
      ? openSectionIncomplete.value
      : options.existingBlocked ? options.existingBlocked(outstanding.value) : openSectionIncomplete.value))

  async function save() {
    if (saveDisabled.value) return
    if (options.isNew.value && nextOutstanding.value) {
      await navigateTo({ path: `${options.recordPath.value}/${nextOutstanding.value}`, query: route.query })
      return
    }
    await options.commit()
  }

  return { outstanding, nextOutstanding, title: computed(() => words.value.title), firstStep, saveLabel, saveDisabled, save }
}
