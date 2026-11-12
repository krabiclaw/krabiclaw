<template>
  <div class="relative isolate overflow-hidden rounded-xl border border-default bg-muted">
    <div ref="container" class="h-[25rem] w-full" data-testid="stay-setup-map" :aria-busy="!ready && !error" :data-pin-placed="!!pin" :data-map-zoom="zoom" />
    <div v-if="ready && !error && !approximate" class="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden="true">
      <span class="grid size-11 place-items-center rounded-full bg-black text-white shadow-md">
        <UIcon name="i-lucide-house" class="size-5" />
      </span>
    </div>
    <div v-else-if="ready && !error" class="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden="true">
      <span class="size-28 rounded-full border border-primary/50 bg-primary/15" />
    </div>
    <p v-if="error" role="alert" class="absolute inset-x-4 top-4 rounded-lg bg-default p-3 text-sm">{{ error }}</p>
    <p v-else-if="!ready" role="status" class="absolute inset-0 grid place-items-center text-sm text-muted">Loading map…</p>
  </div>
</template>

<script setup lang="ts">
import type { Map as MapLibreMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

type Pin = { latitude: number; longitude: number }

const props = defineProps<{
  pin: Pin | null
  city: string
  region: string
  country: string
  interactive?: boolean
  approximate?: boolean
}>()
const emit = defineEmits<{ move: [pin: Pin] }>()
const container = useTemplateRef('container')
const ready = ref(false)
const zoom = ref(2)
const error = ref('')
const controller = new AbortController()
let map: MapLibreMap | undefined

async function findCity(): Promise<[number, number] | undefined> {
  if (!props.city || !props.country) return
  const url = new URL('https://photon.komoot.io/api/')
  url.search = new URLSearchParams({ q: [props.city, props.region].filter(Boolean).join(', '), countrycode: props.country, limit: '1' }).toString()
  const result = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4500)]) })
  if (!result.ok) return
  const coordinates = (await result.json() as { features?: { geometry?: { coordinates?: unknown[] } }[] }).features?.[0]?.geometry?.coordinates
  if (typeof coordinates?.[0] === 'number' && typeof coordinates[1] === 'number') return [coordinates[0], coordinates[1]]
}

onMounted(async () => {
  try {
    const { Map, NavigationControl } = await import('maplibre-gl')
    if (controller.signal.aborted || !container.value) return
    const center = props.pin ? [props.pin.longitude, props.pin.latitude] as [number, number] : undefined
    const instance = new Map({
      container: container.value,
      style: 'https://tiles.openfreemap.org/styles/bright',
      center: center ?? [0, 20],
      zoom: center ? props.approximate ? 12 : 16 : 2,
      interactive: props.interactive,
      scrollZoom: false,
      dragRotate: false,
      touchPitch: false,
      maxPitch: 0,
    })
    map = instance
    zoom.value = instance.getZoom()
    instance.on('zoomend', () => { zoom.value = instance.getZoom() })
    instance.getCanvas().setAttribute('aria-label', props.interactive ? 'Map. Drag or use arrow keys to place the pin.' : 'Location preview map')
    instance.on('load', () => { ready.value = true; error.value = '' })
    instance.on('error', () => {
      if (!ready.value) error.value = 'The map could not load.'
    })
    if (props.interactive) {
      instance.addControl(new NavigationControl({ showCompass: false }))
      let previousCenter = instance.getCenter().wrap()
      instance.on('moveend', event => {
        const center = instance.getCenter().wrap()
        const moved = center.lat !== previousCenter.lat || center.lng !== previousCenter.lng
        previousCenter = center
        if (!moved || !event.originalEvent || instance.getZoom() < 10) return
        emit('move', { latitude: Number(center.lat.toFixed(6)), longitude: Number(center.lng.toFixed(6)) })
      })
    }
    if (!center) {
      // Only the town and region leave the app. A town center is a starting view, never a saved pin.
      const nearby = await findCity().catch(() => undefined)
      if (nearby && !controller.signal.aborted && instance.getZoom() === 2) instance.jumpTo({ center: nearby, zoom: 13 })
    }
  } catch {
    if (!controller.signal.aborted) error.value = 'The map could not load.'
  }
})

onBeforeUnmount(() => {
  controller.abort()
  map?.remove()
})
</script>
