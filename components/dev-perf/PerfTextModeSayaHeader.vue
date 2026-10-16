<template>
  <section class="dev-perf-section dev-perf-platform-shell" aria-label="Saya header render test">
    <h2>Saya header render test</h2>
    <p>
      This mode renders the real Saya header around static text.
    </p>
    <div class="dev-perf-shell-frame saya-theme">
      <UTheme :ui="{}">
        <LazySayaHeader :organization="null" :locations="[]" :sections="null" />
        <main class="dev-perf-shell-body">
          <h3>Static body</h3>
          <p>The Saya header is the variable.</p>
        </main>
      </UTheme>
    </div>
  </section>
</template>
