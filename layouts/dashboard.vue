<template>
  <ClientOnly>
    <!-- Save enables from UForm's dirty fields. A select marks its field on
         change and again on a debounced input; with the 300ms default a Save
         inside that window was re-dirtied after the submit cleared it. -->
    <UTheme :props="{ form: { validateOnInputDelay: 0 } }">
      <DashboardShell>
        <slot />
      </DashboardShell>
    </UTheme>
  </ClientOnly>
</template>
