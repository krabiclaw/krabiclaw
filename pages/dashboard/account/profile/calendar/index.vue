<template>
 <!-- Personal has no organization of its own, so availability starts by naming one. Inside an organization, Account settings opens that organization's availability directly. -->
 <DashboardIndexPanel id="availability-organizations" title="Profile & availability">
  <UAlert v-if="state.error" color="error" :description="getErrorMessage(state.error,'Your organizations could not be loaded.')" />
  <EditorNavigationList :groups="groups" />
 </DashboardIndexPanel>
</template>
<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import {authClient} from '~/lib/auth-client'
definePageMeta({layout:'dashboard'})
const level=useRouteLevel()
const organizations=authClient.useListOrganizations()
const state=computed(()=>unref(organizations))
const groups=computed(()=>[{id:'organizations',items:(state.value.data??[]).map(org=>({id:org.id,label:org.name,lead:{image:org.logo,icon:'i-lucide-building-2'},to:`${level.path.value}/${encodeURIComponent(org.id)}`}))}])
</script>
