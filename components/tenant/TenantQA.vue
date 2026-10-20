<template>
  <AppSection :bg="bg" :padding="padding">
    <div v-if="showTitle" class="flex flex-col gap-4 mb-12 md:flex-row md:items-end md:justify-between border-b border-default pb-8">
      <div>
        <h2 class="text-base font-semibold text-default tracking-wide uppercase">{{ $t('saya.qa.title') }}</h2>
        <p class="mt-2 text-4xl font-bold text-default italic">{{ $t('saya.qa.subtitle') }}</p>
      </div>
      <p v-if="description" class="text-muted max-w-md md:text-right">{{ description }}</p>
    </div>

    <div class="grid gap-6">
      <!-- Real Q&A items -->
      <div 
        v-for="item in displayedQA" 
        :key="item.id"
        class="bg-default border border-default rounded-3xl p-8 shadow-sm hover:shadow-md transition-shadow"
      >
        <div class="flex items-start gap-4 mb-6">
          <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-inverted text-sm font-bold text-inverted">
            Q
          </span>
          <div>
            <h3 class="text-lg font-bold text-default mb-1">{{ item.question }}</h3>
            <p class="text-[10px] text-muted font-bold uppercase tracking-widest">
              {{ $t('saya.qa.asked_by', { author: item.question_author || $t('saya.qa.guest'), date: formatDate(item.question_date || item.created_at) }) }}
            </p>
          </div>
        </div>

        <div v-if="item.answer" class="flex items-start gap-4 bg-muted rounded-2xl p-6">
          <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-inverted text-xs font-bold text-inverted">
            A
          </span>
          <div>
            <p class="text-default leading-relaxed text-sm mb-2">{{ item.answer }}</p>
            <p class="text-[10px] text-muted font-bold uppercase tracking-widest">
              {{ $t('saya.qa.response_from_owner', { date: formatDate(item.answer_date || item.updated_at) }) }}
            </p>
          </div>
        </div>
        <div v-else class="ml-14 italic text-muted text-sm">
          {{ $t('saya.qa.no_answer') }}
        </div>
      </div>

      <!-- Placeholder Q&A cards when no items -->
      <div v-if="qa.length === 0 && showEmptyState" class="flex flex-col items-center justify-center rounded-3xl border border-dashed border-default bg-muted/20 py-20 text-center">
        <div class="flex size-14 items-center justify-center rounded-full bg-elevated/50 text-muted shadow-sm">
          <svg viewBox="0 0 24 24" class="size-7" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M9.879 7.519c1.172-1.025 3.071-1.025 4.243 0c1.171 1.025 1.171 2.687 0 3.712q-.308.268-.67.442c-.746.361-1.452.999-1.452 1.827v.75M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0m-9 5.25h.008v.008H12z"/></svg>
        </div>
        <h3 class="mt-6 saya-display saya-italic text-3xl text-default">{{ $t('saya.qa.empty_title') }}</h3>
        <p class="mt-2 max-w-sm text-sm text-muted">{{ $t('saya.qa.empty_prompt') }}</p>
      </div>
    </div>

    <div v-if="showViewMore && limit && qa.length > limit" class="mt-12 text-center">
      <NuxtLink :to="localePath('/qa')" class="inline-flex items-center justify-center rounded ring-1 ring-inset ring-primary px-6 py-3 text-base font-medium text-primary no-underline transition hover:bg-primary/10">
        {{ $t('saya.qa.view_all') }}
      </NuxtLink>
    </div>
  </AppSection>
</template>

<script setup>
import AppSection from '~/components/ui/AppSection.vue'

const { localePath } = useI18n()

const props = defineProps({
  qa: {
    type: Array,
    default: () => []
  },
  limit: {
    type: Number,
    default: null
  },
  bg: {
    type: String,
    default: 'white'
  },
  padding: {
    type: String,
    default: 'lg'
  },
  showTitle: {
    type: Boolean,
    default: true
  },
  description: {
    type: String,
    default: null
  },
  showViewMore: {
    type: Boolean,
    default: false
  },
  showEmptyState: {
    type: Boolean,
    default: true
  }
})

const { formatDate } = useLocaleDate()

const displayedQA = computed(() => {
  return props.limit ? props.qa.slice(0, props.limit) : props.qa
})
</script>
