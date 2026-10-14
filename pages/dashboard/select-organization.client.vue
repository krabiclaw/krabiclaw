<template>
  <!--
    Which organization this session is in. A person who belongs to more than one is
    asked rather than sent somewhere by list order (#905), so nothing here is
    preselected and nothing is entered until Better Auth says the session moved.
  -->
  <div class="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 px-4 py-12">
    <div>
      <h1 class="text-2xl font-semibold text-highlighted">Choose an organization</h1>
      <p class="mt-2 text-sm text-muted">You work on more than one. Pick the one to open.</p>
    </div>

    <UAlert
      v-if="listError"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      :description="getErrorMessage(listError, 'Your organizations could not be loaded.')"
    />

    <UAlert
      v-if="failure"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      :description="failure"
    />

    <!-- Rows on the page itself, a hairline between them, as every list in the dashboard is. -->
    <div v-if="organizations.length">
      <button
        v-for="organization in organizations"
        :key="organization.id"
        type="button"
        class="flex w-full items-center gap-4 border-b border-default py-6 text-left transition-colors last:border-b-0 hover:bg-elevated disabled:opacity-60"
        :disabled="Boolean(entering)"
        @click="enter(organization)"
      >
        <span class="min-w-0 flex-1 text-base text-highlighted">{{ organization.name }}</span>
        <UIcon
          v-if="entering === organization.id"
          name="i-lucide-loader-circle"
          class="size-5 shrink-0 animate-spin text-muted"
        />
        <UIcon v-else name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
      </button>
    </div>

    <p v-else-if="!listError" class="text-sm text-muted">This account belongs to no organization yet.</p>
  </div>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { buildPostLoginUrl } from '~/shared/auth/return-target'
import { isNewSalePlan } from '~/shared/billing-model'

// No organization scope yet, so no dashboard chrome and no scoped context.
definePageMeta({ layout: 'standalone' })
useSeoMeta({ title: 'Choose an organization | Krabiclaw', robots: 'noindex, nofollow' })

const route = useRoute()
if (route.query.plan !== undefined && !isNewSalePlan(route.query.plan)) {
  throw createError({ statusCode: 400, statusMessage: 'Unknown checkout plan', fatal: true })
}
const session = authClient.useSession()
const { data: organizationList, error: listError } = await useAsyncData('select-organization', async () => {
  const { data, error } = await authClient.organization.list()
  if (error) throw new Error(error.message || 'Your organizations could not be loaded.')
  return data
})
const organizations = computed(() => organizationList.value ?? [])
const failure = ref<string | null>(null)
const entering = ref<string | null>(null)

// The plan rides through the chooser so the billing destination stays decided
// in one place — `/api/post-login` — rather than being rebuilt here.
const plan = computed(() => isNewSalePlan(route.query.plan) ? route.query.plan : undefined)

async function enter(organization: { id: string }) {
  if (entering.value) return
  // Only an organization Better Auth listed may be chosen; a membership that ended
  // since is refused by setActive below.
  if (!organizations.value.some(candidate => candidate.id === organization.id)) {
    failure.value = 'That organization is no longer available to this account.'
    return
  }
  entering.value = organization.id
  failure.value = null
  const { error } = await authClient.organization.setActive({ organizationId: organization.id })
  if (error) {
    // Never navigate as though it became active.
    failure.value = error.message || 'Could not open that organization.'
    entering.value = null
    return
  }
  await session.value.refetch()
  await navigateTo(buildPostLoginUrl(plan.value ? { plan: plan.value } : {}), { external: true })
}
</script>
