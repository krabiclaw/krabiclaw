<template>
  <section v-if="people.length" class="pb-16" data-parity-section="team">
    <div class="tenant-container">
      <ul class="space-y-12 divide-y divide-default" role="list">
        <li v-for="person in people" :key="`${person.first_name}-${person.last_name}`" class="flex flex-col gap-10 pt-12 sm:flex-row items-center">
          <img v-if="person.media[0]?.public_url" :src="person.media[0].public_url" :alt="`${person.first_name} ${person.last_name}`" width="640" height="480" loading="lazy" class="w-full sm:w-2/5 flex-none rounded-2xl object-cover shadow-sm">
          <div class="max-w-xl flex-auto">
            <h3 class="tenant-display text-3xl font-bold text-highlighted sm:text-4xl">{{ person.first_name }} {{ person.last_name }}</h3>
            <p v-if="person.title" class="text-base leading-7 text-muted">{{ person.title }}</p>
            <div v-if="person.bio" class="mt-4 text-base leading-7 text-default">
              <div class="flex items-start gap-3">{{ person.bio }}</div>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockTextOrNull, blockRecords } from '~/utils/tenant-page-block-data'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

function itemMedia(index: number) {
  return props.block.media.filter(asset => asset.slot === `items.${index}.image`)
}

const people = computed(() => blockRecords(props.block.data.items).map((item, index) => ({
  first_name: blockText(item.first_name),
  last_name: blockText(item.last_name),
  title: blockTextOrNull(item.title),
  bio: blockTextOrNull(item.bio),
  media: itemMedia(index),
})).filter(person => person.first_name || person.last_name))
</script>
