<template>
  <UDashboardPanel :id="id" :ui="{ root: 'min-h-0', body: 'p-0 sm:p-0' }">
    <template v-if="exitLabel" #header>
      <div class="flex justify-end px-6 py-4 sm:px-10">
        <UButton type="button" color="neutral" variant="outline" class="rounded-full" :disabled="busy || exitDisabled" @click="$emit('exit')">
          {{ exitLabel }}
        </UButton>
      </div>
    </template>

    <template #body>
      <form :id="formId" class="mx-auto w-full pb-6"
        :class="full ? '' : ['px-6 pt-4 sm:px-8 sm:pt-5', wide ? 'max-w-3xl' : 'max-w-xl']"
        @submit.prevent="submit">
        <h1 v-if="title" ref="heading" tabindex="-1" class="text-3xl font-semibold leading-tight text-highlighted sm:text-4xl">{{ title }}</h1>
        <p v-if="detail" class="mt-2 text-muted">{{ detail }}</p>
        <div v-if="title" class="mt-6" :inert="busy">
          <slot />
        </div>
        <div v-else :inert="busy"><slot /></div>
      </form>
    </template>

    <template v-if="nextLabel && total" #footer>
      <div class="shrink-0 bg-default">
        <div class="grid h-1 gap-1" :style="{ gridTemplateColumns: 'repeat(' + total + ', 1fr)' }"
          role="progressbar" aria-label="Setup progress" :aria-valuemin="0" :aria-valuemax="total" :aria-valuenow="position + 1">
          <span v-for="index in total" :key="index" :class="index <= position + 1 ? 'bg-inverted' : 'bg-elevated'" />
        </div>
        <div class="flex items-center justify-between px-6 py-4 sm:px-10">
          <UButton v-if="position > 0 && backLabel" type="button" color="neutral" variant="link" class="underline" :disabled="busy" @click="$emit('back')">
            {{ backLabel }}
          </UButton>
          <UButton type="submit" :form="formId" color="neutral" size="lg" class="ml-auto px-6" :loading="busy" :disabled="disabled">
            {{ nextLabel }}
          </UButton>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  id: string
  title?: string
  detail?: string
  wide?: boolean
  full?: boolean
  position?: number
  total?: number
  nextLabel?: string
  backLabel?: string
  exitLabel?: string
  busy?: boolean
  disabled?: boolean
  exitDisabled?: boolean
}>(), { position: 0 })

const emit = defineEmits<{ next: []; back: []; exit: [] }>()
const formId = computed(() => props.id + '-form')
const heading = useTemplateRef('heading')
watch(() => props.title, (title, previous) => {
  if (title && previous) heading.value?.focus()
}, { flush: 'post' })

function submit() {
  if (props.nextLabel && !props.busy && !props.disabled) emit('next')
}
</script>
