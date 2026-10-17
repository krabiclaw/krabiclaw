<script setup lang="ts">
import { buildPostLoginUrl } from '~/shared/auth/return-target'

definePageMeta({ layout: false })

const route = useRoute()
// `/dashboard/app/*` routes map org-agnostic deep links (used in docs, marketing,
// and MCP responses) to the reader's active organization in `/dashboard/[orgSlug]/*`.
await navigateTo(buildPostLoginUrl({ redirect: route.fullPath }), {
  external: true,
  redirectCode: 302,
  replace: true,
})
</script>
