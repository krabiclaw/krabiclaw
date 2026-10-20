<template>
  <UCard as="section" variant="subtle" aria-label="Payments help">
    <h2 class="text-xl font-semibold text-highlighted">Need help?</h2>
    <div class="mt-2 divide-y divide-default">
      <NuxtLink v-for="article in articles" :key="article.path" :to="`https://krabiclaw.com${article.path}`" external class="flex items-center justify-between gap-4 py-4">
        <span class="text-base font-medium text-highlighted underline underline-offset-4">{{ article.title }}</span>
        <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
      </NuxtLink>
      <NuxtLink :to="`/dashboard/${route.params.orgSlug}/earnings/transactions`" class="flex items-center justify-between gap-4 py-4">
        <span class="text-base font-medium text-highlighted underline underline-offset-4">Go to your transactions</span>
        <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
      </NuxtLink>
    </div>
  </UCard>
</template>

<script setup lang="ts">
const route = useRoute()
const articles = [
  { title: 'When you’ll get your payout', path: '/docs/when-youll-get-your-payout' },
  { title: 'How refunds work', path: '/docs/how-refunds-work' },
  { title: 'Fees and invoices', path: '/docs/fees-and-invoices' },
  { title: 'Disputes', path: '/docs/disputes' },
  { title: 'Changing your bank account', path: '/docs/changing-your-bank-account' },
]
</script>
