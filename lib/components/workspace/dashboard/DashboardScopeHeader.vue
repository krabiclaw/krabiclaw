<template>
  <div class="flex w-full items-center gap-1" :class="collapsed ? 'justify-center' : ''">
    <UDropdownMenu
      v-if="!collapsed"
      :items="menuItems"
      :content="{ align: 'start', collisionPadding: 12 }"
      :ui="{ content: 'w-(--reka-dropdown-menu-trigger-width) min-w-64' }"
    >
      <UButton
        :avatar="currentAvatar"
        :label="model.current.label"
        color="neutral"
        variant="ghost"
        class="min-w-0 flex-1 data-[state=open]:bg-elevated"
        :ui="{ label: 'truncate text-left' }"
      />
    </UDropdownMenu>
    <DashboardSidebarCollapseButton />
  </div>
</template>

<script setup lang="ts">
export interface DashboardScopeHeaderPeer {
  /** The organization, so a list can look up what the switcher does not load (its mark). */
  id?: string
  label: string
  to?: string
  active: boolean
  onSelect?: () => void
}

// This component renders ONLY the current-level switcher (dropdown of peers +
// createAction). It deliberately does NOT render `model.parent` — that's
// consumed by the layout to build a normal nav item instead (see
// layouts/dashboard.vue's parentNavItem()), matching the reviewed reference
// pattern of a back-row sized like every other nav item, not custom chrome
// inside the switcher header. Do not add parent-rendering back here.
export interface DashboardScopeHeaderModel {
  current: { label: string; avatar?: string; avatarFit: 'cover' | 'contain' }
  parent: { label: string; to: string } | null
  peers: DashboardScopeHeaderPeer[]
  createAction?: { label: string; to: string }
}

const props = defineProps<{ model: DashboardScopeHeaderModel; collapsed?: boolean }>()

// No glyph stands in for a missing mark. A business without a `logo`
// placement shows its name and nothing else, so it is distinguishable from one
// that has a mark.
const currentAvatar = computed(() => props.model.current.avatar
  ? { src: props.model.current.avatar, ui: props.model.current.avatarFit === 'contain' ? { image: 'object-contain bg-elevated p-0.5' } : undefined }
  : undefined)

interface ScopeMenuItem {
  label: string
  icon?: string
  to?: string
  onSelect?: () => void
}

const menuItems = computed(() => {
  const peerItems: ScopeMenuItem[] = props.model.peers.map((peer) => ({
    label: peer.label,
    icon: peer.active ? 'i-lucide-check' : undefined,
    to: peer.to,
    onSelect: peer.onSelect
  }))
  const groups: ScopeMenuItem[][] = [peerItems]
  if (props.model.createAction) {
    groups.push([{ label: props.model.createAction.label, icon: 'i-lucide-plus', to: props.model.createAction.to }])
  }
  return groups
})
</script>
