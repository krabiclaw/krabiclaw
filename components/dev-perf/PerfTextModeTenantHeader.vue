<template>
  <section class="dev-perf-section dev-perf-platform-shell" aria-label="tenant header render test">
    <h2>tenant header render test</h2>
    <p>
      This mode renders the real tenant header around static text.
    </p>
    <div class="dev-perf-shell-frame tenant-theme">
      <UTheme :ui="{}">
        <LazyTenantHeader :organization="null" :locations="[]" :sections="null" />
        <main class="dev-perf-shell-body">
          <h3>Static body</h3>
          <p>The tenant header is the variable.</p>
        </main>
      </UTheme>
    </div>
  </section>
</template>
