<template>
  <div ref="tabsRef" class="sticky top-0 z-30 border-b border-default bg-default">
    <div class="tenant-container flex h-11 items-center justify-center-safe gap-6 overflow-x-auto scrollbar-none">
      <button
        type="button"
        v-for="tab in tabs"
        :key="tab.key"
        :class="[
          'shrink-0 rounded-full px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest transition-all cursor-pointer',
          modelValue === tab.key
            ? 'bg-inverted text-inverted'
            : 'text-muted hover:bg-muted hover:text-default'
        ]"
        @click="handleClick(tab.key)"
      >
        {{ tab.label }}
      </button>
      <slot name="extra" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { shallowRef } from 'vue'

export interface Tab {
  key: string
  label: string
  sectionId?: string
}

const props = defineProps<{
  tabs: Tab[]
  modelValue: string
  enableScrollDetection?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'height': [value: number]
}>()

const tabsRef = shallowRef<Element | null>(null)
let observer: IntersectionObserver | null = null
let timeoutId: ReturnType<typeof setTimeout> | null = null

function handleClick(key: string) {
  emit('update:modelValue', key)
  const tab = props.tabs.find(t => t.key === key)
  if (tab?.sectionId) {
    const element = document.getElementById(tab.sectionId)
    if (element) {
      const navHeight = tabsRef.value?.getBoundingClientRect().height ?? 44
      const elementPosition = element.getBoundingClientRect().top + window.pageYOffset
      window.scrollTo({ top: elementPosition - navHeight, behavior: 'smooth' })
    }
  }
}

function setupObserver() {
  observer?.disconnect()
  observer = null
  if (timeoutId) {
    clearTimeout(timeoutId)
    timeoutId = null
  }

  if (!props.enableScrollDetection) return

  const sections = props.tabs
    .map(t => t.sectionId ? document.getElementById(t.sectionId) : null)
    .filter(Boolean) as Element[]

  if (sections.length > 0) {
    const targetRatios = new Map<string, number>()

    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          targetRatios.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0)
        })

        if (timeoutId) clearTimeout(timeoutId)
        timeoutId = setTimeout(() => {
          let highestId: string | null = null
          let highestRatio = -1

          for (const [id, ratio] of targetRatios.entries()) {
            if (ratio > highestRatio && ratio > 0) {
              highestRatio = ratio
              highestId = id
            }
          }

          if (highestId) {
            const tab = props.tabs.find(t => t.sectionId === highestId)
            if (tab && tab.key !== props.modelValue) {
              emit('update:modelValue', tab.key)
            }
          }
        }, 100)
      },
      {
        rootMargin: '-44px 0px -60% 0px',
        threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
      }
    )

    sections.forEach((section) => observer?.observe(section))
  }
}

watch(
  () => props.tabs,
  () => {
    nextTick(() => {
      setupObserver()
      updateHeight()
    })
  },
  { deep: true }
)

function updateHeight() {
  if (tabsRef.value) {
    emit('height', tabsRef.value.getBoundingClientRect().height)
  }
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  setupObserver()
  updateHeight()
  if (tabsRef.value) {
    resizeObserver = new ResizeObserver(() => {
      updateHeight()
    })
    resizeObserver.observe(tabsRef.value)
  }
  window.addEventListener('resize', updateHeight)
})

onUnmounted(() => {
  observer?.disconnect()
  resizeObserver?.disconnect()
  window.removeEventListener('resize', updateHeight)
  if (timeoutId) clearTimeout(timeoutId)
})
</script>
