<template>
  <div class="rounded-2xl border border-default bg-default p-6 shadow-2xs">
    <div class="mb-4 flex items-center justify-between gap-3">
      <h2 class="text-base font-semibold text-highlighted">{{ title }}</h2>
      <UBadge v-if="badge" color="neutral" variant="soft" size="xs" :label="badge" />
    </div>

    <div v-if="items.length" class="overflow-x-auto">
      <table class="w-full table-fixed text-left text-sm">
        <thead class="text-xs text-muted border-b border-default">
          <tr>
            <th scope="col" class="w-3/5 pb-2.5 font-medium">{{ labelHeading ?? 'Name' }}</th>
            <th scope="col" class="pb-2.5 text-right font-medium">{{ valueHeading ?? 'Count' }}</th>
            <th scope="col" class="w-24 pb-2.5 pl-4 text-right font-medium">Share</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="item in items" :key="item.key ?? item.label" class="group hover:bg-muted/30">
            <td class="py-2.5 pr-4 font-medium text-highlighted truncate">
              <div class="flex items-center gap-2">
                <span v-if="item.prefix" class="shrink-0 text-base leading-none">{{ item.prefix }}</span>
                <span class="truncate">{{ item.label }}</span>
                <span v-if="item.detail" class="text-xs font-normal text-muted truncate">· {{ item.detail }}</span>
              </div>
            </td>
            <td class="py-2.5 text-right tabular-nums text-highlighted">
              {{ item.formattedValue ?? item.value }}
            </td>
            <td class="py-2.5 pl-4 text-right">
              <div class="flex items-center justify-end gap-2">
                <div class="hidden sm:block h-1.5 w-12 rounded-full bg-muted overflow-hidden">
                  <div
                    class="h-full rounded-full bg-primary"
                    :style="{ width: `${Math.max(0, Math.min(100, item.percent ?? 0))}%` }"
                  />
                </div>
                <span class="text-xs tabular-nums text-muted min-w-8">{{ item.percent ?? 0 }}%</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-else class="py-4 text-center text-sm text-muted">
      {{ emptyMessage ?? 'No data recorded yet.' }}
    </p>
  </div>
</template>

<script setup lang="ts">
export interface BreakdownItem {
  key?: string
  label: string
  detail?: string
  prefix?: string
  value: number | string
  formattedValue?: string
  percent?: number
}

defineProps<{
  title: string
  badge?: string
  labelHeading?: string
  valueHeading?: string
  items: BreakdownItem[]
  emptyMessage?: string
}>()
</script>
