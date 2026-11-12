<template>
  <LinksPageEditor />
</template>

<script setup lang="ts">
import LinksPageEditor from '~/components/dashboard/LinksPageEditor.vue'

// A row on Pages: Pages is both its pane and its Back.
definePageMeta({ layout: 'dashboard' })
</script>
