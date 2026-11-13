<script setup lang="ts">
definePageMeta({
  layout: 'dashboard',
  redirect: to => ({ path: `/dashboard/${String(to.params.org_slug)}/website/booking`, query: to.query, hash: to.hash }),
})
</script>
