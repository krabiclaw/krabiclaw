<template>
  <div class="pointer-events-none relative z-10 aspect-[1920/56] p-0" aria-hidden="true" data-parity-section="shield-divider">
    <svg
      class="absolute inset-x-0 top-0 w-full"
      viewBox="0 0 1920 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path :fill="fill" :d="SHIELD_PATH" />
    </svg>
  </div>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blawbyShieldVariant, blawbySurface } from '~/types/blawby'

const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

const SHIELD_PATH = 'M0 0H1920V23.4197C1920 40.325 1907.32 54.2924 1890.45 55.3984C1744.66 64.9576 1103.56 109.281 970.166 157.83C963.441 160.277 956.559 160.277 949.834 157.83C816.436 109.281 175.342 64.9576 29.5456 55.3984C12.6765 54.2924 0 40.325 0 23.4197V0Z'

const fill = computed(() => blawbySurface(blawbyShieldVariant(props.page.path)))
</script>
