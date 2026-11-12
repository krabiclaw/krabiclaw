<template>
  <USelectMenu v-model="country" :items="items" value-key="code" label-key="name" :filter-fields="filterFields">
    <template #leading>
      <span v-if="country" aria-hidden="true" class="flex size-5 items-center text-lg">{{ flagEmoji(country) }}</span>
    </template>
    <template #item-leading="{ item }">
      <span aria-hidden="true" class="flex size-5 items-center text-lg">{{ flagEmoji(item.code) }}</span>
    </template>
  </USelectMenu>
</template>

<script setup lang="ts">
import { flagEmoji } from '~/utils/phone'

withDefaults(defineProps<{ items: { code: string; name: string; dialCode?: string }[]; filterFields?: string[] }>(), {
  filterFields: () => ['name', 'code'],
})
const country = defineModel<string>()
</script>
