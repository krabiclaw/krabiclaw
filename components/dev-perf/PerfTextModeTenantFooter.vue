<template>
  <section class="dev-perf-section dev-perf-platform-shell" aria-label="tenant footer render test">
    <h2>tenant footer render test</h2>
    <p>
      This mode renders the real tenant footer around static text.
    </p>
    <div class="dev-perf-shell-frame tenant-theme">
      <UTheme :ui="{}">
        <main class="dev-perf-shell-body">
          <h3>Static body</h3>
          <p>The tenant footer is the variable.</p>
        </main>
        <LazyTenantFooter
          :organization="null"
          :locations="[]"
          :error="null"
          :sections="null"
        />
      </UTheme>
    </div>
  </section>
</template>
