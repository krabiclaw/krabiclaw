<template>
  <UModal v-model:open="modelValue" :ui="{ content: 'max-w-md p-6 sm:p-7 rounded-3xl' }">
    <template #content>
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-lg sm:text-xl font-semibold text-highlighted">Page tasks</h3>
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
      <p class="text-xs sm:text-sm text-muted mb-5 leading-relaxed">
        Complete these tasks to make sure your pages are ready for visitors.
      </p>

      <div v-if="tasks.length" class="space-y-3.5">
        <div
          v-for="task in tasks"
          :key="task.id"
          class="relative flex items-start gap-3.5 p-4 rounded-2xl bg-default border border-default shadow-xs"
          data-testid="page-task-item"
        >
          <!-- Thumbnail / Icon -->
          <div class="size-12 rounded-xl overflow-hidden bg-accented border border-default shrink-0 flex items-center justify-center">
            <img v-if="task.imageUrl" :src="task.imageUrl" alt="" class="size-full object-cover" />
            <UIcon v-else-if="task.headline.startsWith('Add photo')" name="i-lucide-image" class="size-6 text-muted" />
            <UIcon v-else name="i-lucide-file-text" class="size-6 text-muted" />
          </div>

          <!-- Middle details -->
          <div class="min-w-0 flex-1 pr-6">
            <h4 class="text-sm font-semibold text-highlighted leading-snug">{{ task.headline }}</h4>
            <p class="mt-1 text-xs text-muted leading-relaxed">{{ task.reason }}</p>
            <NuxtLink
              :to="task.to"
              class="mt-2.5 inline-block text-xs font-semibold text-highlighted underline underline-offset-2 hover:text-primary transition"
              @click="modelValue = false"
            >
              {{ task.actionLabel }}
            </NuxtLink>
          </div>

          <!-- Dismiss button -->
          <button
            type="button"
            class="absolute top-3 right-3 size-7 rounded-full flex items-center justify-center text-muted hover:text-highlighted hover:bg-accented transition"
            aria-label="Dismiss task"
            @click="emit('dismiss', task.id)"
          >
            <UIcon name="i-lucide-x" class="size-4" />
          </button>
        </div>
      </div>

      <div v-else class="text-center py-8">
        <UIcon name="i-lucide-check-circle" class="size-10 text-success mx-auto mb-2" />
        <p class="text-sm font-medium text-highlighted">All page tasks complete</p>
        <p class="text-xs text-muted mt-1">Your website pages are up to date and ready for visitors.</p>
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { PageTask } from '~/composables/useTenantPageDraft'

const modelValue = defineModel<boolean>({ default: false })

defineProps<{
  tasks: PageTask[]
}>()

const emit = defineEmits<{
  (e: 'dismiss', taskId: string): void
}>()
</script>
