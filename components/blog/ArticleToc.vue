<template>
  <nav v-if="headings.length" aria-label="On this page" :class="collapsible ? 'rounded-xl border border-default p-4 text-sm' : 'sticky top-28 text-sm'">
    <button v-if="collapsible" type="button" class="flex min-h-11 w-full items-center justify-between gap-3 text-left font-semibold text-default focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary" :aria-expanded="expanded" :aria-controls="listId" @click="expanded = !expanded">
      On this page
      <span aria-hidden="true">{{ expanded ? '−' : '+' }}</span>
    </button>
    <p v-else class="mb-3 font-semibold text-default">On this page</p>
    <ul :id="listId" class="space-y-1" :class="collapsible && !expanded ? 'hidden' : ''">
      <li v-for="heading in headings" :key="heading.id">
        <a
          :href="`#${heading.id}`"
          class="block border-l-2 py-0.5 transition-colors no-underline"
          :class="[
            heading.depth === 3 ? 'pl-6' : 'pl-3',
            activeId === heading.id ? 'border-primary text-default font-medium' : 'border-default text-muted hover:text-default hover:border-muted',
          ]"
          @click="selectHeading(heading.id)"
        >
          {{ heading.text }}
        </a>
      </li>
    </ul>
  </nav>
</template>

<script setup lang="ts">
// The article's h2 and h3 headings with the ids its body renders them with
// (markdownHeadings in utils/markdown.ts reads them from the same slugger).
import type { MarkdownHeading } from '~/utils/markdown'

const props = withDefaults(defineProps<{ headings: MarkdownHeading[]; collapsible?: boolean }>(), { collapsible: false })
const expanded = ref(false)
const listId = useId()
const headings = computed(() => props.headings)

const activeId = ref<string | null>(null)
let observer: IntersectionObserver | null = null
// Clicking a TOC link triggers a smooth scroll into view — while that's in
// flight, the observer would otherwise see headings pass by and flicker the
// active state through them before settling. Suppress it until the scroll
// has had time to finish, so the clicked link is the one that stays active.
let suppressObserverUntil = 0

function selectHeading(id: string) {
  activeId.value = id
  expanded.value = false
  suppressObserverUntil = Date.now() + 800
}

function observeHeadings() {
  observer?.disconnect()
  if (!import.meta.client || !headings.value.length) return

  observer = new IntersectionObserver((entries) => {
    if (Date.now() < suppressObserverUntil) return
    const visible = entries.filter(entry => entry.isIntersecting)
    if (!visible.length) return
    // The "current" section is the visible heading closest to the top of the
    // viewport, not just whichever IntersectionObserver happened to list first.
    const topmost = visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]!
    activeId.value = topmost.target.id
  }, { rootMargin: '-96px 0px -70% 0px' })

  for (const heading of headings.value) {
    const el = document.getElementById(heading.id)
    if (el) observer.observe(el)
  }
}

onMounted(() => {
  // A deep link like .../doc#some-heading should highlight that heading
  // immediately, instead of waiting for the observer's first scroll event.
  if (import.meta.client && window.location.hash) {
    const heading = headings.value.find(h => window.location.hash === `#${encodeURIComponent(h.id)}` || window.location.hash === `#${h.id}`)
    if (heading) activeId.value = heading.id
  }
  nextTick(observeHeadings)
})
watch(() => props.headings, () => nextTick(observeHeadings))
onUnmounted(() => observer?.disconnect())
</script>
