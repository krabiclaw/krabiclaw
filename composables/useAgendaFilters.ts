import type { AgendaKind } from '~/server/utils/dashboard-agenda'
import { createSharedComposable } from '@vueuse/core'

export const AGENDA_FILTER_ALL = '__all__'

const QUERY_KEYS = { locationId: 'locationId', kind: 'kinds', assignedMemberId: 'assigned_member_id', range: 'range' } as const

/**
 * What Today and Calendar narrow the agenda by — one state, the URL query, so
 * moving between the two keeps it and the control (`AgendaFilters`) and the
 * page that reads it see the same answer. A value equal to `AGENDA_FILTER_ALL`
 * means "everything" and is absent from the URL.
 */
export const useAgendaFilters = createSharedComposable(() => {
  const route = useRoute()
  const router = useRouter()
  const read = (key: string) => typeof route.query[key] === 'string' && route.query[key] ? String(route.query[key]) : AGENDA_FILTER_ALL
  // Writes queue behind one another, so two controls changed in quick succession both land in the URL.
  // A write that fails is shown by the control and does not stop the next one.
  const failure = ref<unknown>(null)
  let writing: Promise<void> = Promise.resolve()
  const write = (patch: Partial<Record<keyof typeof QUERY_KEYS, string>>) => {
    writing = writing.then(() => {
      const query: Record<string, string | undefined> = { ...(router.currentRoute.value.query as Record<string, string>) }
      for (const [field, value] of Object.entries(patch) as [keyof typeof QUERY_KEYS, string][]) {
        query[QUERY_KEYS[field]] = value !== AGENDA_FILTER_ALL ? value : undefined
      }
      return router.replace({ query })
    }).then(() => { failure.value = null }, (cause: unknown) => { failure.value = cause })
  }
  const filters = reactive({
    locationId: computed({ get: () => read(QUERY_KEYS.locationId), set: (value: string) => write({ locationId: value }) }),
    kind: computed({ get: () => read(QUERY_KEYS.kind), set: (value: string) => write({ kind: value }) }),
    assignedMemberId: computed({ get: () => read(QUERY_KEYS.assignedMemberId), set: (value: string) => write({ assignedMemberId: value }) }),
  })
  const range = computed<'today' | 'upcoming'>({
    get: () => route.query.range === 'upcoming' ? 'upcoming' : 'today',
    set: value => write({ range: value === 'upcoming' ? 'upcoming' : AGENDA_FILTER_ALL }),
  })
  const signature = computed(() => `${filters.locationId}:${filters.kind}:${filters.assignedMemberId}`)
  const active = computed(() => filters.locationId !== AGENDA_FILTER_ALL || filters.kind !== AGENDA_FILTER_ALL || filters.assignedMemberId !== AGENDA_FILTER_ALL)
  /** The query the agenda API takes for the current filters. */
  const query = computed(() => ({
    locationId: filters.locationId !== AGENDA_FILTER_ALL ? filters.locationId : undefined,
    kinds: filters.kind !== AGENDA_FILTER_ALL ? (filters.kind as AgendaKind) : undefined,
    assigned_member_id: filters.assignedMemberId !== AGENDA_FILTER_ALL ? filters.assignedMemberId : undefined,
  }))
  const clear = () => write({ locationId: AGENDA_FILTER_ALL, kind: AGENDA_FILTER_ALL, assignedMemberId: AGENDA_FILTER_ALL })
  return { filters, signature, active, query, clear, failure, range }
})
