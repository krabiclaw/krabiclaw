<template>
  <!-- One conversation row's read state, the way each device marks it without
       opening the conversation: a swipe to the right on a touch screen (iOS
       Messages), the row's own menu on a right-click or long press, and an
       envelope that appears on hover for a mouse (Gmail). -->
  <slot v-if="!enabled" />
  <UContextMenu v-else :items="[{ label, icon, onSelect: () => emit('toggle') }]">
    <div
      ref="row"
      class="group relative touch-pan-y overflow-hidden rounded-xl"
      @pointerdown.capture="swiped = false"
      @click.capture="swallowSwipeClick"
    >
      <div
        v-if="offset > 0"
        class="absolute inset-y-0 left-0 flex items-center justify-center rounded-xl bg-primary text-inverted"
        :style="{ width: `${offset}px` }"
        aria-hidden="true"
      >
        <UIcon :name="icon" class="size-6" />
      </div>
      <div :style="offset ? { transform: `translateX(${offset}px)` } : undefined" :class="isSwiping ? undefined : 'transition-transform duration-200 motion-reduce:transition-none'">
        <slot />
      </div>
      <UTooltip :text="label">
        <UButton
          :icon="icon"
          color="neutral"
          variant="outline"
          size="sm"
          class="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-default opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:hidden"
          :aria-label="`${label}: ${name}`"
          @click.stop.prevent="emit('toggle')"
        />
      </UTooltip>
    </div>
  </UContextMenu>
</template>

<script setup lang="ts">
import { usePointerSwipe } from '@vueuse/core'

// A list whose read state is not the member's own (a guest's inbox) draws its rows without the actions.
const props = withDefaults(defineProps<{ unread: boolean; name: string; enabled?: boolean }>(), { enabled: true })
const emit = defineEmits<{ toggle: [] }>()

const label = computed(() => props.unread ? 'Mark as read' : 'Mark as unread')
const icon = computed(() => props.unread ? 'i-lucide-mail-open' : 'i-lucide-mail-plus')

// A swipe to the right past this distance marks the row, as iOS Messages does;
// a shorter one springs back.
const COMMIT = 88
const row = useTemplateRef<HTMLElement>('row')
const offset = ref(0)
const swiped = ref(false)
const { distanceX, isSwiping } = usePointerSwipe(row, {
  pointerTypes: ['touch'],
  threshold: 12,
  onSwipe() {
    offset.value = Math.max(0, Math.min(-distanceX.value, (row.value?.offsetWidth ?? 0) / 2))
    if (offset.value > 0) swiped.value = true
  },
  onSwipeEnd() {
    if (offset.value >= COMMIT) emit('toggle')
    offset.value = 0
  },
})
// The release that ends a swipe is not a tap on the conversation.
function swallowSwipeClick(event: MouseEvent) {
  if (!swiped.value) return
  swiped.value = false
  event.preventDefault()
  event.stopPropagation()
}
</script>
