<template>
  <nav aria-label="Breadcrumb" class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <ol class="flex items-center gap-2 overflow-x-auto whitespace-nowrap no-scrollbar">
      <li v-for="(crumb, i) in crumbs" :key="crumb.to" class="flex items-center gap-2">
        <NuxtLink
          v-if="i < crumbs.length - 1"
          :to="crumb.to"
          class="inline-flex items-center rounded-full bg-elevated/80 px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-muted backdrop-blur-md transition-all hover:bg-elevated hover:text-default"
        >
          {{ crumb.label }}
        </NuxtLink>
        <span v-else class="inline-flex items-center rounded-full bg-action px-4 py-2 text-[10px] text-on-action font-bold uppercase tracking-widest shadow-sm" aria-current="page">
          {{ crumb.label }}
        </span>
        <span v-if="i < crumbs.length - 1" class="text-muted/30" aria-hidden="true">
          <TenantIcon name="chevron-right" class="size-3" />
        </span>
      </li>
    </ol>
  </nav>
</template>

<script setup>
defineProps({
  crumbs: {
    type: Array,
    required: true
  }
})
</script>
