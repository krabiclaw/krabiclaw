<template>
  <UModal v-model:open="modelValue" :ui="{ content: 'divide-none max-w-md p-6 sm:p-7 rounded-3xl shadow-2xl [&>*]:border-0' }">
    <template #content>
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <h3 class="text-lg sm:text-xl font-semibold text-highlighted">
            Translation tasks
          </h3>
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            square
            size="sm"
            aria-label="Close"
            @click="modelValue = false"
          />
        </div>

        <div v-if="tasks.length" class="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          <NuxtLink
            v-for="task in tasks"
            :key="task.id"
            :to="task.to"
            class="flex items-center justify-between p-4 sm:p-5 rounded-2xl bg-white dark:bg-neutral-900 shadow-[0_2px_12px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_12px_rgba(0,0,0,0.3)] hover:shadow-[0_4px_16px_rgba(0,0,0,0.09)] transition cursor-pointer group"
            data-testid="translation-task-item"
            @click="modelValue = false"
          >
            <div class="min-w-0 flex-1">
              <h4 class="text-sm sm:text-base font-semibold text-highlighted leading-snug">
                {{ task.headline }}
              </h4>
              <p class="mt-0.5 text-xs sm:text-sm text-muted">
                {{ task.reason }}
              </p>
            </div>
            <UIcon
              name="i-lucide-chevron-right"
              class="size-5 text-muted group-hover:text-highlighted group-hover:translate-x-0.5 transition shrink-0 ml-3"
            />
          </NuxtLink>
        </div>

        <div v-else class="text-center py-8">
          <UIcon name="i-lucide-check-circle" class="size-10 text-success mx-auto mb-2" />
          <h4 class="text-base font-semibold text-highlighted">
            All translations complete
          </h4>
          <p class="text-xs text-muted mt-1">
            Every field with content has been translated.
          </p>
        </div>
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
export interface TranslationTask {
  id: string
  headline: string
  reason: string
  to: string
  actionLabel: string
  locale: string
}

const modelValue = defineModel<boolean>({ default: false })

defineProps<{
  tasks: TranslationTask[]
}>()
</script>
