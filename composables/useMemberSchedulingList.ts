import type { MaybeRefOrGetter } from 'vue'
import type { memberSchedulingList } from '~/server/domain/member-scheduling'
import type { Serialize } from 'nitro/types'

type MembersResponse = Serialize<Awaited<ReturnType<typeof memberSchedulingList>>>

/** One scoped read for assignment controls and calendar filters. */
export function useMemberSchedulingList(organizationId: MaybeRefOrGetter<string | null | undefined>) {
  return useAsyncData(
    computed(() => `member-scheduling-list:${toValue(organizationId) ?? 'none'}`),
    () => {
      const id = toValue(organizationId)
      if (!id) return Promise.resolve(null)
      return applicationFetch(`/api/organizations/${encodeURIComponent(id)}/members/scheduling`, {
        validate: (value): value is MembersResponse => isRecord(value) && Array.isArray(value.members)
          && value.members.every(member => isRecord(member) && typeof member.id === 'string' && typeof member.name === 'string'
            && (member.image === null || typeof member.image === 'string') && typeof member.self === 'boolean'
            && (member.scheduling === null || isRecord(member.scheduling)))
          && Array.isArray(value.teams) && value.teams.every(team => isRecord(team) && typeof team.id === 'string' && typeof team.name === 'string' && Array.isArray(team.members)
            && team.members.every(member => isRecord(member) && typeof member.id === 'string' && typeof member.teamId === 'string' && typeof member.userId === 'string' && typeof member.createdAt === 'string')),
      })
    },
  )
}
