<template>
  <section class="dev-perf-section" aria-label="Tenant theme CSS render test">
    <h2>Tenant theme CSS render test</h2>
    <p>
      This mode applies the <code>tenant-theme</code> class and the same
      palette custom properties the tenant layout carries
      (<code>sitePaletteStyle</code>), without rendering any tenant
      component, to isolate theme-color CSS scoping cost from
      component-tree cost.
    </p>
    <div class="tenant-theme dev-perf-tenant-css-frame" :style="tenantThemeStyles">
      <p>Static text under tenant-theme styling.</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { DEFAULT_SITE_PALETTE, sitePaletteStyle } from '~/shared/site-palette'

const tenantThemeStyles = sitePaletteStyle(DEFAULT_SITE_PALETTE)
</script>
