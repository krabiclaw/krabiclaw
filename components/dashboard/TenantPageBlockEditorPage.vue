<template>
  <!--
    One section of the page. A block with several concerns is an index whose
    rows are those concerns; a block with one concern is that concern, and is
    the leaf itself. Which one is a property of the block's type.
  -->
  <DashboardLeafPanel
    v-if="isLeaf"
    id="organization-page-block"
    :title="blockLabel"
    :saving="saving"
    :disabled="saveDisabled"
    :save-label="saveLabel"
    :error="loadError ?? errorMessage"
    @cancel="revertDraft"
    @save="saveOpenSection"
  >
    <UFormField v-if="isNew" label="Section type" required class="mb-6">
      <USelect
        :model-value="newType"
        :items="typeOptions"
        value-key="value"
        label-key="label"
        class="w-full"
        placeholder="Choose a section type"
        @update:model-value="chooseType($event)"
      />
    </UFormField>
    <UAlert
      v-if="block && !sections.length"
      color="neutral"
      variant="soft"
      icon="i-lucide-minus"
      title="Divider"
      description="This section draws a line between the sections around it. Reorder or remove it from the Sections list."
    />
    <TenantPageBlockFields
      v-else-if="singleSection && block"
      :organization-id="organizationId"
      :page-id="pageId"
      :block-id="blockId"
      :section-key="singleSection.key"
      @split-insert="splitMarkdown"
    />
  </DashboardLeafPanel>

  <DashboardIndexPanel v-else id="organization-page-block" :title="blockLabel" :auto-open="navigationGroups[0]?.items.find(item => item.to)?.to ?? null" :create="newBlock && sections.length ? firstStep : null">
    <UFormField v-if="isNew && !loadError" label="Section type" required class="mb-6">
      <USelect
        :model-value="newType"
        :items="typeOptions"
        value-key="value"
        label-key="label"
        class="w-full"
        placeholder="Choose a section type"
        @update:model-value="chooseType($event)"
      />
    </UFormField>
    <UAlert v-if="loadError || errorMessage" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="loadError ?? errorMessage" />
    <EditorNavigationList v-if="navigationGroups.length" :groups="navigationGroups" :active-item="level.child.value" />
    <!-- A type with nothing to fill in, such as a divider, is made from its type alone. -->
    <template v-if="isNew && newBlock && !sections.length" #footer>
      <DashboardPanelFooter :save-label="saveLabel" :loading="saving" :disabled="walkSaveDisabled" @cancel="leaveNewBlock" @save="saveWalk" />
    </template>
  </DashboardIndexPanel>
</template>

<script lang="ts">
import type { ComputedRef, InjectionKey, Ref } from 'vue'
import {
  TENANT_PAGE_BLOCK_REGISTRY,
  createTenantPageBlock,
  isTenantPageBlockAllowed,
  type TenantPageBlock,
  type TenantPageBlockType,
} from '~/utils/tenant-page-blocks'
import { TENANT_PAGE_RECORD_NOUNS, tenantPageBlockLabel, tenantPageBlockSections, type TenantPageBlockSection } from '~/utils/tenant-page-block-sections'

/** The block and the way its leaves commit, for the section and record levels below it. */
export interface TenantPageBlockEditor {
  block: ComputedRef<TenantPageBlock | null>
  sections: ComputedRef<readonly TenantPageBlockSection[]>
  /** Why the page could not be read; the page level's, for the leaves below this one. */
  loadError: Ref<string | null>
  saving: Ref<boolean>
  saveDisabled: Ref<boolean>
  saveLabel: Ref<string | undefined>
  errorMessage: Ref<string>
  revert: () => void
  save: () => void
  splitMarkdown: (payload: { after: string; blockType: 'image' | 'faq' | 'how_to' }) => void
}

export const tenantPageBlockEditorKey = Symbol('tenant-page-block-editor') as InjectionKey<TenantPageBlockEditor>
</script>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import TenantPageBlockFields from '~/components/dashboard/TenantPageBlockFields.vue'
import { getErrorMessage, showNotFound } from '~/utils/errors'
import { tenantPageEditorKey } from '~/components/dashboard/TenantPageEditorPage.vue'
import { createTenantPageEditorData, tenantPageBlockSummary, validateTenantPageBlock } from '~/utils/tenant-page-editor'

const props = defineProps<{ organizationId: string; pageId: string; blockId: string }>()

const level = useRouteLevel()
const { error, draft, dirty, revert, commit } = useTenantPageDraft(props.organizationId, props.pageId)
// The page level reads the page and reports when it could not, as a missing
// page or as the failure this level and its leaves show.
const { loadError } = inject(tenantPageEditorKey)!
const newBlock = useTenantPageNewBlock(props.organizationId, props.pageId)

const isNew = computed(() => props.blockId === 'new')
const saving = ref(false)
const errorMessage = ref('')

const block = computed<TenantPageBlock | null>(() => (isNew.value
  ? newBlock.value
  : draft.value.blocks.find(candidate => candidate.id === props.blockId) ?? null))

const blockLabel = computed(() => (isNew.value ? newTitle.value : block.value ? tenantPageBlockLabel(block.value.type) : 'Section'))
const sections = computed<readonly TenantPageBlockSection[]>(() => (block.value ? tenantPageBlockSections(block.value) : []))
/** A block with one concern is that concern; there is no row to open it with. */
const singleSection = computed(() => (sections.value.length === 1 ? sections.value[0]! : null))
/** A divider, or a block of one non-list concern, is edited here rather than a level down. */
const isLeaf = computed(() => !isNew.value && Boolean(block.value) && (!sections.value.length || (singleSection.value?.kind === 'leaf')))

// A section that is not there is not a page; a level below a block that has
// no such concern is not one either. A page that was not read has no sections
// to look in, and that is the page level's failure to report, not a 404 here.
watchEffect(() => {
  if (error.value) return
  if (!isNew.value && !block.value) return showNotFound('Section not found')
  const open = level.child.value
  if (!open) return
  const known = sections.value.some(section => section.key === open)
    || (singleSection.value?.kind === 'list' && singleSection.value.collection === open)
  if (!known) showNotFound()
})

const typeOptions = computed(() => Object.values(TENANT_PAGE_BLOCK_REGISTRY)
  .filter(definition => isTenantPageBlockAllowed(definition, draft.value.recipe, draft.value.page_type))
  .map(definition => ({ label: definition.label, value: definition.type, icon: definition.icon })))
const newType = computed(() => newBlock.value?.type)

function chooseType(value: unknown) {
  const type = String(value) as TenantPageBlockType
  if (!isTenantPageBlockAllowed(type, draft.value.recipe, draft.value.page_type)) return
  newBlock.value = createTenantPageBlock(type, createTenantPageEditorData(type), draft.value.blocks.length)
}

function sectionSummary(section: TenantPageBlockSection): { summary: string; placeholder: boolean } {
  const current = block.value
  if (!current) return { summary: 'Nothing yet', placeholder: true }
  if (section.kind === 'list') {
    const records = Array.isArray(current.data[section.collection!]) ? (current.data[section.collection!] as unknown[]).length : 0
    const noun = TENANT_PAGE_RECORD_NOUNS[section.collection!].one.toLowerCase()
    if (!records) return { summary: `No ${noun}s yet`, placeholder: true }
    return { summary: records === 1 ? `1 ${noun}` : `${records} ${noun}s`, placeholder: false }
  }
  if (section.key === 'image') {
    const has = current.media.some(item => item.slot === 'media')
    return { summary: has ? 'Chosen' : 'No image yet', placeholder: !has }
  }
  const summary = tenantPageBlockSummary({ ...current, data: sectionData(current, section) })
  return { summary: summary || 'Nothing yet', placeholder: !summary }
}

/** The fields this row stands for, so its preview reads that row rather than the block. */
function sectionData(current: TenantPageBlock, section: TenantPageBlockSection): Record<string, unknown> {
  const keys: Record<string, string[]> = {
    title: ['title'],
    copy: current.type === 'hero' ? ['eyebrow', 'title', 'subtitle'] : ['title', 'description'],
    message: ['title', 'body'],
    settings: ['title'],
    button: current.type === 'hero' ? ['cta_label', 'cta_url'] : ['label', 'url'],
    destination: ['destination'],
    locations: ['location_ids'],
    calculator: ['calculator'],
  }
  const picked: Record<string, unknown> = {}
  for (const key of keys[section.key] ?? []) picked[key] = current.data[key]
  return picked
}

const navigationGroups = computed<EditorNavigationGroup[]>(() => {
  if (!sections.value.length) return []
  return [{
    id: 'block',
    items: sections.value.map((section) => {
      const { summary, placeholder } = sectionSummary(section)
      return { id: section.key, label: section.label, icon: section.icon, summary, placeholder, to: `${level.path.value}/${section.key}` }
    }),
  }]
})

// ── Adding a section ────────────────────────────────────
// The type, then whatever the block will not be accepted without. What "will not
// be accepted" means is `validateTenantPageBlock` and nothing else.
const walkLabels = computed<Record<string, string>>(() => {
  const labels: Record<string, string> = { type: 'Type' }
  for (const section of sections.value) labels[section.key] = section.label
  return labels
})
const walkOrder = computed<string[]>(() => ['type', ...sections.value.map(section => section.key)])
const newBlockInvalid = computed(() => Boolean(newBlock.value && validateTenantPageBlock(newBlock.value).length))
const openWalkKey = computed(() => level.child.value ?? 'type')

const { title: newTitle, firstStep, saveLabel, saveDisabled: walkSaveDisabled, save: saveWalk } = useCreateWalk({
  recordPath: level.path,
  isNew,
  openKey: openWalkKey,
  labels: walkLabels,
  order: walkOrder,
  missing: (key) => {
    if (key === 'type') return !newBlock.value
    // Only the first section blocks creating: the rest of what a block can hold
    // is edited once it exists, like every other record.
    return newBlockInvalid.value && key === sections.value[0]?.key
  },
  noun: 'section',
  saving,
  commit: create,
})

const saveDisabled = computed(() => (isNew.value
  ? walkSaveDisabled.value
  : !dirty.value || Boolean(block.value && validateTenantPageBlock(block.value).length)))

function saveOpenSection() {
  if (isNew.value) return void saveWalk()
  void save()
}

async function create() {
  const pending = newBlock.value
  if (!pending) return
  saving.value = true
  errorMessage.value = ''
  try {
    draft.value.blocks = [...draft.value.blocks, { ...pending, position: draft.value.blocks.length }]
    const page = await commit()
    const created = page.blocks.find(candidate => candidate.id === pending.id)
    if (!created) throw new Error('The section was not created.')
    newBlock.value = null
    // The section it became, not the `new` form it was.
    await navigateTo(`${level.to.value}/${created.id}`, { replace: true })
  } catch (cause) {
    // The page was not written, so the draft must not keep pretending it was.
    revert()
    errorMessage.value = getErrorMessage(cause, 'Failed to add this section')
  } finally {
    saving.value = false
  }
}

/** Saving from a leaf below this level commits the page and puts this level back. */
async function save() {
  saving.value = true
  errorMessage.value = ''
  try {
    await commit()
    if (isLeaf.value) await navigateTo(level.to.value ?? '/dashboard')
    else await level.close()
  } catch (cause) {
    errorMessage.value = getErrorMessage(cause, 'Failed to save this page')
  } finally {
    saving.value = false
  }
}

/** Cancel on a block being made from its type alone leaves the making, as dismissing a step does. */
async function leaveNewBlock() {
  revertDraft()
  await navigateTo(level.to.value ?? '/dashboard')
}

function revertDraft() {
  errorMessage.value = ''
  if (isNew.value) newBlock.value = null
  else revert()
}

/**
 * The rich editor can split the text it is holding and ask for another section
 * after it. The page already knows how to hold one more block, so that is all
 * this does — no second insertion path, and the same single save.
 */
function splitMarkdown(payload: { after: string; blockType: 'image' | 'faq' | 'how_to' }) {
  const current = block.value
  if (!current) return
  const index = draft.value.blocks.findIndex(candidate => candidate.id === current.id)
  if (index < 0) return
  const inserted = createTenantPageBlock(payload.blockType, createTenantPageEditorData(payload.blockType), index + 1)
  const next = [...draft.value.blocks]
  next.splice(index + 1, 0, inserted)
  if (payload.after.trim()) {
    next.splice(index + 2, 0, createTenantPageBlock('markdown', { ...createTenantPageEditorData('markdown'), markdown: payload.after }, index + 2))
  }
  draft.value.blocks = next.map((candidate, position) => ({ ...candidate, position }))
}

/** Leaving the add flow empties its draft, so the next Add starts blank. */
onBeforeRouteLeave((to) => {
  if (!isNew.value) return
  if (to.path === level.path.value || to.path.startsWith(`${level.path.value}/`)) return
  newBlock.value = null
})

provide(tenantPageBlockEditorKey, {
  block,
  sections,
  loadError,
  saving,
  saveDisabled,
  saveLabel,
  errorMessage,
  revert: revertDraft,
  save: saveOpenSection,
  splitMarkdown,
})
</script>
