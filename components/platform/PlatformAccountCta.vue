<template>
  <span v-if="sessionError" role="alert" class="text-sm text-error">Unable to load account</span>
  <div v-else-if="account" v-bind="$attrs" class="flex shrink-0 items-center gap-2">
    <!-- Signed in: the avatar is the whole control, the way it is on every
         consumer app an owner already uses. No label, because a word in English
         is not something a Thai-speaking owner can act on; their own face is. -->
    <details v-if="user" ref="accountMenu" class="relative shrink-0">
      <summary
        class="flex size-8 shrink-0 cursor-pointer list-none items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden"
        :aria-label="`Account: ${user.name}`"
      >
        <img
          v-if="user.image"
          :src="user.image"
          :alt="user.name"
          class="size-8 shrink-0 aspect-square rounded-full object-cover"
          width="32"
          height="32"
        >
        <span
          v-else
          aria-hidden="true"
          class="flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated text-[13px] font-semibold text-default"
        >{{ userInitials }}</span>
      </summary>
      <div class="absolute right-0 top-full z-50 mt-2 w-60 rounded-2xl border border-default bg-default p-1.5 shadow-xl">
        <div class="flex items-center gap-2.5 rounded-xl px-3 py-2">
          <img
            v-if="user.image"
            :src="user.image"
            :alt="user.name"
            class="size-8 shrink-0 rounded-full object-cover"
            width="32"
            height="32"
          >
          <span
            v-else
            aria-hidden="true"
            class="flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated text-[13px] font-semibold text-default"
          >{{ userInitials }}</span>
          <div class="min-w-0">
            <div class="truncate text-[13px] font-semibold text-default">{{ user.name }}</div>
            <div class="truncate text-[11px] text-muted">{{ user.email }}</div>
          </div>
        </div>
        <NuxtLink :to="postLoginUrl" external class="block rounded-xl px-3 py-2 text-[13px] font-medium text-default no-underline transition-colors hover:bg-muted" @click="closeMenu">
          Dashboard
        </NuxtLink>
        <NuxtLink to="/dashboard/account/profile" class="block rounded-xl px-3 py-2 text-[13px] font-medium text-default no-underline transition-colors hover:bg-muted" @click="closeMenu">
          Account settings
        </NuxtLink>
        <button type="button" class="block w-full cursor-pointer rounded-xl px-3 py-2 text-left text-[13px] font-medium text-default transition-colors hover:bg-muted" @click="signOut">
          Log out
        </button>
      </div>
    </details>
    <div v-else class="items-center gap-2" :class="hideSignedOutOnMobile ? 'hidden nav:flex' : 'flex'">
      <!-- Below 620px only the signed-out text link gives way; `Start free`
           and the signed-in avatar stay at every width. -->
      <NuxtLink to="/login" class="text-[15px] font-medium no-underline [@media(max-width:620px)]:hidden">Sign in</NuxtLink>
      <PlatformButton :to="to" size="sm">{{ label }}</PlatformButton>
    </div>
  </div>
  <PlatformButton v-else :to="user ? postLoginUrl : to" :external="Boolean(user)" v-bind="$attrs">
    {{ user && !selectedPlan ? 'Dashboard' : label }}
  </PlatformButton>
</template>

<script setup lang="ts">
import { buildPostLoginUrl } from '~/shared/auth/return-target'
import { authClient } from '~/lib/auth-client'

defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{ account?: boolean, hideSignedOutOnMobile?: boolean, to?: string, label?: string }>(), {
  account: false,
  hideSignedOutOnMobile: false,
  to: '/signup',
  label: 'Start free',
})
// The session is read on the client only: the server has none, and the
// client's fetch can finish before this hydrates, so reading it during
// hydration rendered "Dashboard" over the server's "Start free". Both sides
// render signed-out until mounted; the account branch follows after.
const session = authClient.useSession()
const mounted = ref(false)
onMounted(() => { mounted.value = true })
const user = computed(() => mounted.value ? session.value.data?.user ?? null : null)
const sessionError = computed(() => mounted.value ? session.value.error : null)
// The marketing stylesheet carries no Nuxt UI, so the avatar is the surface's
// own markup: the photo when there is one, the owner's initials when there is
// not, in the same footprint either way.
const userInitials = computed(() => (user.value?.name ?? '')
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map(part => part[0]?.toUpperCase() ?? '')
  .join('') || '?')
const selectedPlan = computed(() => new URL(props.to, 'https://blawby.internal').searchParams.get('plan'))
const postLoginUrl = computed(() => buildPostLoginUrl({ plan: selectedPlan.value ?? undefined }))

const accountMenu = ref<HTMLDetailsElement | null>(null)
function closeMenu() {
  if (accountMenu.value) accountMenu.value.open = false
}
async function signOut() {
  closeMenu()
  await authClient.signOut()
  await navigateTo('/login')
}

function onDocumentPointerDown(event: MouseEvent) {
  if (!accountMenu.value?.open) return
  if (!accountMenu.value.contains(event.target as Node)) closeMenu()
}
function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeMenu()
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
})
</script>
