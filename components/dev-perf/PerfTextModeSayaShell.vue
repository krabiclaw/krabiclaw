<template>
  <section class="dev-perf-section dev-perf-platform-shell" aria-label="Saya shell render test">
    <h2>Saya shell render test</h2>
    <p>
      This mode renders the real Saya header and footer around static text.
    </p>
    <div class="dev-perf-shell-frame saya-theme">
      <UTheme :ui="{}">
        <LazySayaHeader :organization="null" :locations="[]" :sections="null" />
        <main class="dev-perf-shell-body">
          <h3>Static body</h3>
          <p>No production tenant page content is rendered here.</p>
        </main>
        <LazySayaFooter
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
