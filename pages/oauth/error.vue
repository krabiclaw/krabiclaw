<template>
  <div class="space-y-6 rounded-lg border border-default bg-default p-6">
    <h1 class="text-xl font-semibold">Connection failed</h1>
    <UAlert color="error" variant="soft" :description="message" />
    <div v-if="isInvalidClient" class="space-y-3 rounded-md border border-default bg-elevated p-4 text-sm text-muted">
      <p class="font-medium text-default">Connecting an AI assistant?</p>
      <p>
        If this occurred while reconnecting ChatGPT, Claude, or another MCP client, your assistant is using an outdated connection ID.
      </p>
      <ol class="list-decimal list-inside space-y-1">
        <li>Remove the existing KrabiClaw action or connector in your AI assistant settings.</li>
        <li>Add a new connection using the MCP server URL: <code class="rounded bg-muted/20 px-1 py-0.5 font-mono text-xs text-default">https://krabiclaw.com/api/mcp</code></li>
      </ol>
      <div class="pt-1">
        <UButton to="/docs/mcp-setup" variant="outline" size="sm" icon="i-lucide-external-link">View MCP setup guide</UButton>
      </div>
    </div>
    <UButton to="/dashboard" block>Return to dashboard</UButton>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'access', auth: false })
useSeoMeta({ title: 'Connection failed | KrabiClaw', robots: 'noindex, nofollow' })
const route = useRoute()
const isInvalidClient = computed(() => route.query.error === 'invalid_client')
const message = computed(() => oauthErrorMessage(route.query.error, route.query.error_description)
  || 'The provider connection failed. Return to Settings → Integrations and start Connect again.')
</script>
