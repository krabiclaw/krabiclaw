<template>
  <DashboardIndexPanel id="organization-blog-new" title="New post" :auto-open="`${level.path.value}/headline`">
    <template #right>
      <UButton :label="createActionLabel" :loading="saving" @click="startOrCreate" />
    </template>
    <UAlert v-if="error" color="error" variant="soft" :description="error" />
    <EditorNavigationList :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script lang="ts">
import type { InjectionKey, Ref } from 'vue'

export interface BlogPostCreateEditor {
  draft: Ref<{ title: string; idempotency_key: string }>
  saving: Ref<boolean>
  error: Ref<string | null>
  saveLabel: Ref<string | undefined>
  saveDisabled: Ref<boolean>
  save: () => Promise<void>
  revert: () => void
}

export const blogPostCreateKey = Symbol('blog-post-create') as InjectionKey<BlogPostCreateEditor>
</script>

<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import { tenantBlogRepository } from '~/lib/components/workspace/blog/tenantBlogRepository'
import { initialBlogEditorBlocks } from '~/utils/blog-editor'
import { getErrorMessage } from '~/utils/errors'
import { isNavigationFailure } from 'vue-router'

const route = useRoute()
const level = useRouteLevel()
const organizationId = await useDashboardOrganizationId()
const orgSlug = String(route.params.orgSlug)
const repository = tenantBlogRepository({ organizationId, orgSlug })
const blankDraft = () => ({ title: '', idempotency_key: crypto.randomUUID() })
const draftKey = `blog-create:${organizationId}`
const draft = useState(draftKey, blankDraft)
const saving = ref(false)
const error = ref<string | null>(null)
const groups = computed(() => [{ id: 'new-article', items: [{
  id: 'headline', label: 'Headline', summary: draft.value.title || 'No headline',
  placeholder: !draft.value.title, to: `${level.path.value}/headline`,
}] }])
const { createActionLabel, saveLabel, saveDisabled, save, startOrCreate } = useCreateWalk({
  recordPath: level.path, isNew: computed(() => true), openKey: computed(() => 'headline' as const),
  labels: { headline: 'Headline' }, order: ['headline'], missing: () => !draft.value.title.trim(),
  noun: 'post', saving, commit,
})

async function commit() {
  saving.value = true
  error.value = null
  try {
    const post = await repository.create({ title: draft.value.title.trim(), content_blocks: initialBlogEditorBlocks(), idempotency_key: draft.value.idempotency_key })
    const navigation = await navigateTo(repository.editUrl(post.id), { replace: true })
    if (isNavigationFailure(navigation)) throw navigation
    clearNuxtState(draftKey)
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Failed to create the post.')
  } finally {
    saving.value = false
  }
}

provide(blogPostCreateKey, { draft, saving, error, saveLabel, saveDisabled, save, revert: () => { draft.value = blankDraft() } })
useSeoMeta({ title: 'New post | KrabiClaw Dashboard', robots: 'noindex, nofollow' })
</script>
