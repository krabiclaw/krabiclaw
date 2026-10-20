<template>
  <section class="kc-pricing-comparison" data-parity-section="comparison">
    <div class="kc-pricing-comparison__inner">
      <h2>{{ blockText(block?.data.title) || 'Compare the details.' }}</h2>
      <p>Paid capabilities require an eligible subscription. Some features also need setup, permissions or a connected provider.</p>
      <div class="kc-pricing-comparison__scroll" tabindex="0" aria-label="Scrollable plan comparison">
        <table>
          <caption class="sr-only">Features and availability by plan</caption>
          <thead><tr><th scope="col">Feature</th><th v-for="plan in plans" :key="plan.id" scope="col">{{ plan.name }}</th></tr></thead>
          <tbody v-for="group in PRICING_COMPARISON" :key="group.title">
            <tr class="kc-pricing-comparison__group"><th :colspan="plans.length + 1" scope="colgroup">{{ group.title }}</th></tr>
            <tr v-for="row in group.rows" :key="row.label" :data-feature-id="row.id">
              <th scope="row">
                <details class="kc-pricing-comparison__detail">
                  <summary>{{ row.label }}<PlatformIcon name="question-circle" class="size-4" aria-hidden="true" /></summary>
                  <p>{{ row.detail }}</p>
                </details>
              </th>
              <td v-for="plan in plans" :key="plan.id">
                <span v-if="comparisonValue(row, plan.id) === 'Included'" class="kc-pricing-comparison__included">
                  <PlatformIcon name="check-solid" class="size-6" aria-hidden="true" />
                  <span class="sr-only">{{ comparisonValue(row, plan.id) }}</span>
                </span>
                <span v-else-if="row.planValue">{{ comparisonValue(row, plan.id) }}</span>
                <span v-else><span aria-hidden="true">—</span><span class="sr-only">{{ comparisonValue(row, plan.id) }}</span></span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
<script setup lang="ts">
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText } from '~/utils/tenant-page-block-data'
import { PRICING_COMPARISON, comparisonValue } from '~/shared/pricing-comparison'
defineProps<{ block?: TenantPageBlock }>()
const { plans } = await usePlans()
</script>
<style scoped>
.kc-pricing-comparison { background: #f9f8f4; color: #252b43; padding: 5rem 1.5rem 2rem; }
.kc-pricing-comparison__inner { max-width: 62rem; margin: auto; }
h2 { font-size: clamp(2.4rem, 4vw, 3.8rem); font-weight: 400; letter-spacing: -.04em; }
p { max-width: 65ch; color: #646878; line-height: 1.7; }
.kc-pricing-comparison__scroll { overflow-x: auto; contain: paint; margin-top: 3rem; }
table { border-collapse: collapse; width: 100%; min-width: 38rem; text-align: left; }
thead th { font-size: 1.2rem; padding: 1.4rem 1rem; }
th, td { border-bottom: 1px solid #d6d8de; padding: 1.4rem 1rem; vertical-align: top; }
tbody th { width: 40%; font-weight: 600; }
td { font-size: .9rem; }
.kc-pricing-comparison__detail p { display: block; font-weight: 400; color: #646878; line-height: 1.5; margin: .75rem 0 0; font-size: .85rem; }
.kc-pricing-comparison__detail summary { cursor: pointer; display: flex; gap: .5rem; align-items: center; list-style: none; }
.kc-pricing-comparison__detail summary::-webkit-details-marker { display: none; }
.kc-pricing-comparison__detail summary svg { flex: none; color: #646878; }
.kc-pricing-comparison__included { display: inline-flex; gap: .35rem; align-items: center; }
.kc-pricing-comparison__group th { padding-top: 2.5rem; background: #eeeee8; font-size: 1rem; letter-spacing: .03em; }
</style>
