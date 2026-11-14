<template>
  <UModal
    :open="open"
    :title="title"
    fullscreen
    :close="{ color: 'neutral', variant: 'soft' }"
    :ui="{ header: 'grid grid-cols-[1fr_auto_1fr] gap-3', wrapper: 'sr-only', close: 'static col-start-1 row-start-1 size-10 justify-self-start rounded-full', body: 'min-h-0 p-0 sm:p-0' }"
    @update:open="emit('update:open', $event)"
    @after:leave="emit('after:leave')"
  >
    <template #actions>
      <UTabs
        :model-value="viewport ?? undefined"
        :items="[{ label: 'Desktop view', value: 'desktop', icon: 'i-lucide-monitor' }, { label: 'Mobile view', value: 'mobile', icon: 'i-lucide-smartphone' }]"
        :content="false"
        size="sm"
        color="neutral"
        variant="link"
        :ui="{ label: 'sr-only', list: 'border-0 gap-1 p-0', trigger: 'size-10 rounded-lg data-[state=active]:bg-elevated', indicator: 'hidden', leadingIcon: 'size-5' }"
        aria-label="Preview device"
        class="hidden col-start-2 row-start-1 lg:block"
        @update:model-value="emit('update:viewport', $event)"
      />
      <div v-if="publicUrl" class="col-start-3 row-start-1 justify-self-end">
        <ShareButton :title="contentTitle" :url="publicUrl" data-testid="preview-share" />
      </div>
    </template>
    <template #body>
      <slot>
        <UAlert v-if="error" color="error" variant="soft" :title="`${title} could not be opened`" :description="error" class="m-6" />
        <div v-else class="flex h-full min-h-0 justify-center overflow-auto bg-muted">
          <iframe
            v-if="open && src"
            :src="src"
            :title="title"
            sandbox="allow-same-origin allow-scripts allow-forms"
            class="h-full min-h-0 w-full border-0 bg-default"
            :class="viewport === 'mobile' ? 'max-w-[390px]' : undefined"
            data-testid="content-preview-frame"
          />
        </div>
      </slot>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import ShareButton from '~/components/tenant/ShareButton.vue'

defineProps<{
  open: boolean
  title: string
  contentTitle: string
  src: string | null
  viewport: 'desktop' | 'mobile' | null
  publicUrl: string | null
  error?: string
}>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  'update:viewport': [value: string | number]
  'after:leave': []
}>()
</script>
