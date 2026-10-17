<script setup lang="ts">
import { buildPostLoginUrl } from '~/shared/auth/return-target'

definePageMeta({ layout: false })

const route = useRoute()
// `/dashboard/app` resolves the reader's active organization via the canonical
// authenticated entry router and preserves any query or hash.
await navigateTo(buildPostLoginUrl({ redirect: route.fullPath }), {
  external: true,
  redirectCode: 302,
  replace: true,
})
</script>
