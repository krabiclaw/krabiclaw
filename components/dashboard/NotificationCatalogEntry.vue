<template>
  <div v-if="entry" class="space-y-8">
    <section class="space-y-2">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-dimmed">Email</h2>
      <p class="text-sm text-muted">Subject: {{ entry.subject }}</p>
      <!--
        Sandboxed, because this is the real rendered message and it must not
        borrow the dashboard's styles or run anything.
      -->
      <iframe :srcdoc="entry.html" sandbox="" class="h-[70vh] w-full rounded-xl border border-default bg-white" title="Email preview" />
      <details class="text-sm text-muted">
        <summary class="cursor-pointer">Plain text</summary>
        <pre class="mt-2 whitespace-pre-wrap text-xs">{{ entry.text }}</pre>
      </details>
    </section>

    <section v-if="entry.whatsapp" class="space-y-2">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-dimmed">WhatsApp</h2>
      <p class="text-sm text-muted">Approved template: <code>{{ entry.whatsapp.template }}</code></p>
      <UCard variant="subtle" :ui="{ body: 'text-sm whitespace-pre-line' }">{{ entry.whatsapp.text }}</UCard>
      <p class="text-xs text-dimmed">
        These are the template's filled slots, not our own wording — Meta renders its approved copy around them.
      </p>
    </section>

    <UCard v-else as="section" variant="subtle" :ui="{ body: 'text-sm text-muted' }">
      Email only. A guest has no account and no number we may message unprompted.
    </UCard>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ id: string }>()
const { entries } = await useNotificationCatalog()
const entry = computed(() => entries.value.find(item => item.id === props.id))
</script>
