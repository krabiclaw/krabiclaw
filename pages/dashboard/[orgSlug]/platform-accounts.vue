<template>
  <DashboardIndexPanel id="platform-accounts" title="Platform accounts" column="reading">
    <div>
      <div class="space-y-6">
        <p class="text-sm text-muted">
          Every account on the platform. Impersonating opens that person's dashboard exactly as they see it; use their
          own pages for domains, billing, members and inbox, then stop impersonating from the banner.
        </p>

        <UAlert v-if="impersonateError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="impersonateError" />

        <!-- A link from the onboarding email names one account and the business
             it opens. Showing it never impersonates; the button does. -->
        <template v-if="target">
          <UAlert v-if="targetError" color="error" variant="soft" title="Could not open this customer" :description="getErrorMessage(targetError, 'Failed to load this account.')" />
          <div v-else-if="targetUser && targetUser.id === target.userId" class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-default bg-elevated p-4" data-testid="focused-account">
            <div class="min-w-0">
              <p class="truncate text-base text-highlighted">{{ targetUser.name || targetUser.email }}</p>
              <p class="truncate text-sm text-muted">{{ targetUser.email }}</p>
            </div>
            <UButton
              size="sm"
              class="rounded-full"
              :disabled="targetUser.id === currentUserId"
              :loading="impersonatingUserId === targetUser.id"
              @click="impersonate(targetUser.id, target.organizationId)"
            >
              Impersonate and open their business
            </UButton>
          </div>
        </template>

        <UAlert v-if="loadError" color="error" variant="soft" title="Could not load accounts" :description="getErrorMessage(loadError, 'Failed to load accounts.')" />

        <ul v-else>
          <li v-for="user in users" :key="user.id" class="flex flex-wrap items-center justify-between gap-3 border-b border-default py-6 last:border-b-0">
            <div class="min-w-0">
              <p class="truncate text-base text-highlighted">{{ user.name || user.email }}</p>
              <p class="truncate text-sm text-muted">{{ user.email }}<span v-if="user.role && user.role !== 'user'"> · {{ user.role }}</span><span v-if="user.banned"> · banned</span></p>
            </div>
            <UButton
              size="sm"
              color="neutral"
              variant="soft"
              class="rounded-full"
              :disabled="user.id === currentUserId"
              :loading="impersonatingUserId === user.id"
              @click="impersonate(user.id)"
            >
              Impersonate
            </UButton>
          </li>
          <li v-if="!users.length" class="py-6 text-sm text-muted">No accounts yet.</li>
        </ul>
        <div v-if="total > pageSize" class="flex items-center justify-between gap-3">
          <p class="text-sm text-muted">Showing {{ offset + 1 }}–{{ offset + users.length }} of {{ total }}.</p>
          <div class="flex gap-2">
            <UButton color="neutral" variant="soft" :disabled="loading || offset === 0" @click="offset -= pageSize">Previous</UButton>
            <UButton color="neutral" variant="soft" :disabled="loading || offset + users.length >= total" @click="offset += pageSize">Next</UButton>
          </div>
        </div>
      </div>
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { canOpenPlatformAccounts } from '~/utils/platform-admin-access'

// Every account on the platform, and the one platform-only tool a Better Auth
// admin has: pick a person and act as them. It sits beside Team and Billing
// because it is about accounts rather than about a site — under a site's URL it
// read as "this site's people", which it has never been. It exists only inside
// KrabiClaw's own organization and only for a Better Auth admin; anywhere else
// it is not a page, the same rule that decides Menu's row.
definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })

const dashboard = useDashboardOrganization()
const session = authClient.useSession()
if (!dashboard.organization.value || !canOpenPlatformAccounts(dashboard.organization.value, (session.value.data?.user as { role?: string | null } | undefined)?.role)) {
  throw createError({ statusCode: 404, statusMessage: 'Page not found' })
}

useSeoMeta({ title: 'Platform accounts | KrabiClaw Dashboard', robots: 'noindex, nofollow' })

interface PlatformUser { id: string; name: string | null; email: string; role?: string | null; banned?: boolean | null }

const impersonateError = ref<string | null>(null)
const currentUser = computed(() => session.value.data?.user ?? null)
const refreshSession = () => session.value.refetch()
const currentUserId = computed(() => currentUser.value?.id ?? null)

const pageSize = 50
const offset = ref(0)
const impersonatingUserId = ref<string | null>(null)
const toPlatformUser = (user: { id: string, name?: string | null, email: string, role?: string | null, banned?: boolean | null }): PlatformUser =>
  ({ id: user.id, name: user.name ?? null, email: user.email, role: user.role ?? null, banned: user.banned ?? null })

// With a business named, Better Auth makes it the impersonated session's active
// organization, which it refuses unless the person belongs to it; refused, the
// impersonation is stopped rather than left open on some other business.
async function impersonate(userId: string, organizationId?: string) {
  impersonatingUserId.value = userId
  impersonateError.value = null
  try {
    const result = await authClient.admin.impersonateUser({ userId })
    if (result.error) throw new Error(result.error.message)
    if (organizationId) {
      const active = await authClient.organization.setActive({ organizationId })
        .catch((error: unknown) => ({ data: null, error: { message: error instanceof Error ? error.message : String(error) } }))
      if (active.error || !active.data) {
        const stopped = await authClient.admin.stopImpersonating()
        if (stopped.error) throw new Error(`${active.error?.message ?? 'The organization could not be opened'}, and impersonation could not be stopped: ${stopped.error.message}`)
        throw new Error(`This person cannot open that organization: ${active.error?.message ?? 'it was not found'}`)
      }
      await refreshSession()
      await navigateTo(`/dashboard/${active.data.slug}`)
      return
    }
    await refreshSession()
    await navigateTo('/dashboard')
  } catch (error) {
    impersonateError.value = error instanceof Error ? error.message : 'Failed to impersonate'
  } finally {
    impersonatingUserId.value = null
  }
}

const route = useRoute()
const target = computed(() => {
  const userId = typeof route.query.user === 'string' ? route.query.user : null
  const organizationId = typeof route.query.organization === 'string' ? route.query.organization : null
  return userId && organizationId ? { userId, organizationId } : null
})

// The page of accounts and, from an onboarding link, the one account it names load together.
const [{ data: page, pending: loading, error: loadError }, { data: targetUser, error: targetError }] = await Promise.all([
  useAsyncData(() => `platform-accounts:${offset.value}`, async () => {
    const result = await authClient.admin.listUsers({
      query: { limit: pageSize, offset: offset.value, sortBy: 'createdAt', sortDirection: 'desc' },
    })
    if (result.error) throw new Error(result.error.message)
    return { users: result.data.users.map(toPlatformUser), total: result.data.total }
  }),
  useAsyncData(() => `platform-account:${target.value?.userId ?? ''}`, async () => {
    const userId = target.value?.userId
    if (!userId) return null
    const result = await authClient.admin.listUsers({
      query: { filterField: 'id', filterValue: userId, filterOperator: 'eq', limit: 1 },
    })
    if (result.error) throw new Error(result.error.message ?? 'Failed to load this account.')
    const user = result.data.users[0]
    if (!user) throw new Error('This account no longer exists.')
    return toPlatformUser(user)
  }),
])
const users = computed(() => page.value?.users ?? [])
const total = computed(() => page.value?.total ?? 0)
</script>
