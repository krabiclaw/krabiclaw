<template>
  <div v-if="tiers.length && destination" class="mx-auto grid max-w-4xl gap-8 lg:grid-cols-2">
    <article
      v-for="tier in tiers"
      :key="`${tier.title}-${tier.amount}`"
      class="relative rounded-2xl p-8 shadow-lg"
      :class="tier.featured ? 'bg-[var(--tenant-primary-dark,var(--blawby-primary-dark,#1e293b))] text-white' : 'bg-elevated text-highlighted border border-default'"
    >
      <div v-if="tier.featured" class="absolute -top-4 left-1/2 -translate-x-1/2">
        <span class="inline-flex items-center rounded-full bg-primary px-4 py-1 text-sm font-medium text-on-primary">
          Most Popular
        </span>
      </div>
      <div class="text-center">
        <div
          class="mx-auto flex size-16 items-center justify-center rounded-xl"
          :class="tier.featured ? 'bg-primary/20' : 'bg-muted'"
        >
          <TenantFeatureIcon
            :name="tier.icon"
            class="size-8"
            :class="tier.featured ? 'text-primary' : 'text-highlighted'"
          />
        </div>
        <h2 class="mt-6 text-xl font-semibold">{{ tier.title }}</h2>
        <p class="mt-2 text-sm opacity-80">{{ tier.description }}</p>
        <div class="mt-4 text-4xl font-bold">${{ tier.amount }}</div>
        <TenantButton :to="destination" class="mt-6 w-full" @click="$emit('click', { label: tier.title, amount: tier.amount })">
          Donate ${{ tier.amount }}
        </TenantButton>
      </div>
    </article>

    <article class="relative rounded-2xl border border-default bg-elevated p-8 text-highlighted shadow-lg">
      <div class="text-center">
        <div class="mx-auto flex size-16 items-center justify-center rounded-xl bg-muted">
          <TenantFeatureIcon name="HeartIcon" class="size-8 text-primary" />
        </div>
        <h2 class="mt-6 text-xl font-semibold">Custom Amount</h2>
        <p class="mt-2 text-sm text-muted">Choose your own donation amount</p>
        <TenantButton :to="destination" class="mt-6 w-full" @click="$emit('click', { label: 'Custom Amount', amount: null })">
          Donate custom amount
        </TenantButton>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockTextOrNull, blockRecords } from '~/utils/tenant-page-block-data'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

const tiers = computed(() => blockRecords(props.block.data.tiers).map(tier => ({
  amount: Number(tier.amount) || 0,
  title: blockText(tier.title),
  description: blockText(tier.description),
  featured: tier.featured === true,
  icon: blockText(tier.icon),
})).filter(tier => tier.amount > 0 && tier.title && tier.icon))
const destination = computed(() => blockTextOrNull(props.block.data.destination))

defineEmits<{ click: [choice: { label: string; amount: number | null }] }>()
</script>
