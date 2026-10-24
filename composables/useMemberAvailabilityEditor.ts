import type { InjectionKey } from 'vue'
import type { readMemberScheduling } from '~/server/domain/member-scheduling'
import type { WorkingHours } from '~/shared/member-scheduling'

export type MemberSchedule = Awaited<ReturnType<typeof readMemberScheduling>>

function isSchedulingResponse(value: unknown): value is { scheduling: MemberSchedule } {
  if (!isRecord(value)) return false
  const row = value.scheduling
  if (row === null) return true
  if (!isRecord(row)) return false
  const hours = row.timezone === null
    ? row.weekly === null && row.time_off === null
    : typeof row.timezone === 'string' && Boolean(row.timezone)
      && Array.isArray(row.weekly) && row.weekly.every(slot => isRecord(slot) && Number.isInteger(slot.weekday) && typeof slot.start === 'string' && typeof slot.end === 'string')
      && Array.isArray(row.time_off) && row.time_off.every(interval => isRecord(interval) && typeof interval.start === 'string' && typeof interval.end === 'string')
  return hours && typeof row.updated_at === 'string'
    && Array.isArray(row.calendar_ids) && row.calendar_ids.every(id => typeof id === 'string')
    && (row.calendar_account_id === null || typeof row.calendar_account_id === 'string')
    && (row.public_name === null || typeof row.public_name === 'string')
    && (row.public_photo_url === null || typeof row.public_photo_url === 'string')
    && (row.public_bio === null || typeof row.public_bio === 'string')
    && (row.public_approved === 0 || row.public_approved === 1)
}

export const memberAvailabilityKey = Symbol('member-availability') as InjectionKey<ReturnType<typeof createMemberAvailabilityEditor>>

export function createMemberAvailabilityEditor(organizationId: string, memberId: string, admin: boolean, self: boolean) {
  const base = `/api/organizations/${organizationId}/members/${memberId}`
  const record = ref<MemberSchedule>(null)
  const loaded = ref(false), error = ref(''), saving = ref(false)
  const draft = ref({ timezone: null as string | null, weekly: null as WorkingHours[] | null, time_off: null as { start: string; end: string }[] | null, public_name: '', public_photo_url: null as string | null, public_bio: '', public_approved: false })
  const baseline = ref('')
  const recovery = ref<{ body: Record<string, unknown>; status: 'unread' | 'retry' | 'conflict' } | null>(null)
  const dirty = computed(() => recovery.value !== null || baseline.value !== JSON.stringify(draft.value))

  function revert() {
    recovery.value = null
    const value = record.value
    draft.value = {
      timezone: value?.timezone ?? null,
      weekly: value?.weekly?.map(slot => ({ ...slot })) ?? null,
      time_off: value?.time_off?.map(interval => ({ ...interval })) ?? null,
      public_name: value?.public_name ?? '',
      public_photo_url: value?.public_photo_url ?? null,
      public_bio: value?.public_bio ?? '',
      public_approved: Boolean(value?.public_approved),
    }
  }
  function reset(value: MemberSchedule) {
    record.value = value
    revert()
    baseline.value = JSON.stringify(draft.value)
  }
  async function run(action: () => Promise<void>) {
    error.value = ''
    saving.value = true
    try { await action() }
    catch (cause) { error.value = getErrorMessage(cause, 'Your profile and availability could not be saved.') }
    finally { saving.value = false }
  }
  async function load() {
    await run(async () => {
      const value = await applicationFetch(`${base}/scheduling`, { validate: isSchedulingResponse })
      reset(value.scheduling)
      loaded.value = true
    })
  }
  async function readFailedSave() {
    const pending = recovery.value
    if (!pending) return
    const saved = (await applicationFetch(`${base}/scheduling`, { validate: isSchedulingResponse })).scheduling
    const matchesAttempt = saved !== null && Object.entries(pending.body).every(([key, value]) => key === 'expected_updated_at'
      || JSON.stringify(key === 'public_approved' ? Boolean(saved?.public_approved) : saved?.[key as keyof NonNullable<MemberSchedule>]) === JSON.stringify(value))
    if (!matchesAttempt && (saved?.updated_at ?? null) !== pending.body.expected_updated_at) {
      recovery.value = { ...pending, status: 'conflict' }
      throw new Error('These settings changed after your edit. Use the saved values before editing again.')
    }
    const attempted = draft.value
    reset(saved)
    draft.value = attempted
    if (matchesAttempt) recovery.value = { ...pending, status: 'retry' }
  }
  async function save(concern: string) {
    await run(async () => {
      if (recovery.value?.status === 'conflict') throw new Error('These settings changed after your edit. Use the saved values before editing again.')
      if (recovery.value?.status === 'unread') await readFailedSave()
      const body: Record<string, unknown> = { expected_updated_at: record.value?.updated_at ?? null }
      if (concern === 'timezone') {
        if (!draft.value.timezone) throw new Error('Choose your timezone.')
        body.timezone = draft.value.timezone
        // The first Hours commit explicitly starts with no hours or time off.
        if (!record.value?.timezone) Object.assign(body, { weekly: [], time_off: [] })
      } else if (concern === 'weekly' || concern === 'time-off') {
        if (!record.value?.timezone) throw new Error('Choose your timezone in Hours first.')
        if (concern === 'weekly') {
          if (!draft.value.weekly) throw new Error('Working hours have not been loaded.')
          body.weekly = draft.value.weekly
        } else {
          if (!draft.value.time_off) throw new Error('Time off has not been loaded.')
          body.time_off = draft.value.time_off
        }
      } else if (concern === 'name') body.public_name = draft.value.public_name.trim() || null
      else if (concern === 'bio') body.public_bio = draft.value.public_bio || null
      else if (concern === 'photo') body.public_photo_url = draft.value.public_photo_url
      else if (concern === 'published' && admin) body.public_approved = draft.value.public_approved
      else throw new Error('This profile or availability field is unavailable.')
      try {
        reset((await applicationFetch(`${base}/scheduling`, { method: 'PUT', body, validate: isSchedulingResponse })).scheduling)
      } catch (cause) {
        recovery.value = { body, status: 'unread' }
        try { await readFailedSave() }
        catch (readCause) {
          throw new AggregateError([cause, readCause], `${getErrorMessage(cause, 'Your settings could not be saved.')} ${getErrorMessage(readCause, 'The current saved settings could not be read.')}`, { cause: readCause })
        }
        throw cause
      }
    })
  }
  async function calendar(enabled: boolean, accountId?: string) {
    await run(async () => {
      reset((await applicationFetch(`${base}/calendar`, { method: 'POST', body: { enabled, account_id: accountId }, validate: isSchedulingResponse })).scheduling)
    })
  }
  return { organizationId, memberId, admin, self, record, draft, loaded, error, saving, dirty, recovery, revert, load, save, calendar }
}

export function useMemberAvailabilityEditor() {
  const editor = inject(memberAvailabilityKey)
  if (!editor) throw new Error('Member availability context is missing')
  return editor
}
