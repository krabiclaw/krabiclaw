<template>
  <section class="dev-perf-section dev-perf-platform-shell" aria-label="tenant shell render test">
    <h2>tenant shell render test</h2>
    <p>
      This mode renders the real tenant header and footer around static text.
    </p>
    <div class="dev-perf-shell-frame tenant-theme">
      <UTheme :ui="{}">
        <LazyTenantHeader :organization="null" :locations="[]" :sections="null" />
        <main class="dev-perf-shell-body">
          <h3>Static body</h3>
          <p>No production tenant page content is rendered here.</p>
        </main>
        <LazyTenantFooter
          :organization="null"
          :locations="[]"
          :locales="[]"
          :error="null"
          :config="{}"
          :sections="null"
        />
      </UTheme>
    </div>
  </section>
</template>
