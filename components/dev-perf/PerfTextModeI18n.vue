<template>
  <section class="dev-perf-section" aria-label="i18n render test">
    <h2>i18n render test</h2>
    <p>
      This mode calls <code>useI18n()</code> and renders one real
      <code>$t()</code> lookup, to isolate the cost of engaging the i18n
      runtime/locale message resolution during SSR.
    </p>
    <p>{{ t('site.header.menu') }} (locale: {{ locale }})</p>
  </section>
</template>

<script setup lang="ts">
const { locale, t } = useI18n()
</script>
