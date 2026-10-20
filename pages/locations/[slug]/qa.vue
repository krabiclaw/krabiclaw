<template>
  <div class="min-h-screen bg-default text-default">

    <template v-if="location">
      <!-- Sub-nav (Level 2) -->
      <TenantSubNav 
        :location-slug="slug" 
        active="qa" 
      />

      <!-- Compact Page header -->
      <header class="mx-auto max-w-7xl px-4 pt-12 pb-10 sm:px-6 lg:px-8 text-center">
        <NuxtLink :to="localePath(`/locations/${slug}`)" class="saya-kicker mb-8 inline-block text-muted no-underline hover:text-default">
          ← {{ t('saya.qa_page.back_to', { title: location?.title }) }}
        </NuxtLink>
        
        <div class="flex flex-col gap-2">
          <h1 class="saya-display-md text-default">{{ t('saya.qa_page.title') }}</h1>
          <p class="text-sm text-muted">
            {{ t('saya.qa_page.subtitle', { location: location?.title }) }}
          </p>
        </div>
      </header>
    </template>


    <!-- Q&A list -->
    <section class="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
      <div v-if="sorted.length === 0" class="flex flex-col items-center justify-center rounded-3xl border border-dashed border-default bg-muted/30 py-20 text-center">
        <div class="flex size-14 items-center justify-center rounded-full bg-elevated/50 text-muted shadow-sm">
          <TenantIcon name="question-mark-circle" class="size-7" />
        </div>
        <h3 class="mt-6 saya-display saya-italic text-3xl text-default">{{ t('saya.qa_page.no_questions_title') }}</h3>
        <p class="mt-2 max-w-sm text-sm text-muted">{{ t('saya.qa_page.no_questions_desc') }}</p>
      </div>

      <div v-else class="flex flex-col gap-6">
        <article
          v-for="q in sorted"
          :key="q.id"
          class="rounded-3xl border border-default bg-default p-8 sm:p-9"
        >
          <!-- Question -->
          <div class="flex gap-5">
            <div class="saya-display saya-italic flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-lg text-default">Q</div>
            <div class="flex-1 min-w-0">
              <p class="text-base font-medium leading-snug text-default">{{ q.question }}</p>
              <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>{{ t('saya.qa_page.asked_by', { author: q.question_author || t('saya.qa.guest') }) }}</span>
                <span>·</span>
                <span>{{ formatQaDate(q.question_date) }}</span>
                <template v-if="q.upvote_count > 0">
                  <span>·</span>
                  <span class="inline-flex items-center gap-1">
                    <TenantIcon name="hand-thumb-up" class="size-3" />
                    {{ q.upvote_count }} {{ t('saya.qa_page.helpful') }}
                  </span>
                </template>
              </div>
            </div>
          </div>

          <!-- Answer -->
          <div
            v-if="q.answer"
            :class="[
              'ml-13 mt-5 flex gap-5 rounded-2xl p-5',
              q.is_owner_answer ? 'border-l-4 border-primary bg-elevated' : 'bg-muted'
            ]"
          >
            <div class="saya-display saya-italic flex size-7 shrink-0 items-center justify-center rounded-full bg-default text-sm text-inverted">A</div>
            <div class="flex-1 min-w-0">
              <p class="text-sm leading-relaxed text-default">{{ q.answer }}</p>
              <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span v-if="q.is_owner_answer" class="inline-flex items-center rounded-full border border-default px-2 py-0.5 text-xs font-semibold text-muted">
                  {{ organizationName }} · {{ t('saya.qa_page.owner') }}
                </span>
                <span v-else>{{ q.answer_author }}</span>
                <span>·</span>
                <span>{{ formatQaDate(q.answer_date) }}</span>
              </div>
            </div>
          </div>

          <!-- Awaiting answer -->
          <div v-else class="ml-13 mt-4 flex items-center gap-2 text-xs text-muted">
            <TenantIcon name="clock" class="size-3.5 opacity-50" />
            {{ t('saya.qa_page.awaiting_answer') }}
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'tenant' })

const { localePath, t } = useI18n()

const route = useRoute()
const { organization } = useTenantOrganization()
const slug = computed(() => String(route.params.slug))
const organizationName = computed(() => String((organization as ApiValue)?.name ?? '').trim())

const { location, qaList } = await usePublicPageData()
// A slug naming no location is a URL that does not exist. Rendering the page
// around a null location answered 200 with an empty shell — a soft 404 a
// crawler indexes. The sibling menu and product indexes already refuse it.
if (!location.value) throw createError({ statusCode: 404, statusMessage: 'Location not found' })
// A section with nothing on it is not a page; the navigation hides it by the same flag.
if (!location.value.sections.qa) throw createError({ statusCode: 404 })

const { formatDate } = useLocaleDate()

const qa = qaList

const sorted = computed(() =>
  [...qa.value].sort((a, b) => {
    if (a.is_owner_answer !== b.is_owner_answer) return (b.is_owner_answer ?? 0) - (a.is_owner_answer ?? 0)
    return (b.upvote_count ?? 0) - (a.upvote_count ?? 0)
  })
)

function formatQaDate(ts: string | null) {
  if (!ts) return ''
  return formatDate(ts)
}

useSocialMetadata(() => ({
  path: `/locations/${slug.value}/qa`,
  title: `Questions and answers · ${location.value?.title || slug.value}`,
  description: `Questions and answers for ${location.value?.title || slug.value} at ${organizationName.value}.`,
  socialImage: location.value?.social_image ?? null,
  breadcrumbs: [
    { name: 'Locations', url: '/locations' },
    { name: location.value?.title ?? slug.value, url: `/locations/${slug.value}` },
    { name: 'Q&A', url: `/locations/${slug.value}/qa` },
  ],
  faqItems: sorted.value
    .filter((q: ApiValue) => q.question && q.answer)
    .map((q: ApiValue) => ({
      question: String(q.question),
      answer: String(q.answer),
    })),
}))
</script>
