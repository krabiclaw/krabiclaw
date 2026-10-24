<template>
  <!-- A choice with nothing to choose is not a control. -->
  <UFormField v-if="!isEmptyChoice" :label="field.label" :required="field.required" :description="description">
    <!-- A list of plain strings — how_to's tools and supplies. -->
    <UInputTags
      v-if="field.kind === 'list'"
      :model-value="stringList"
      class="w-full"
      @update:model-value="writeStringList($event)"
    />

    <!-- Lazy: the rich text editor pulls TipTap/ProseMirror, ~211 KB over the
         wire. Only a markdown field opens it, so rendering a list of sections
         should not pay for it. -->
    <LazyRichTextEditor
      v-else-if="field.kind === 'markdown'"
      :model-value="stringValue"
      :mode="markdownMode"
      placeholder="Start writing in Markdown…"
      @update:model-value="write($event)"
      @split-insert="$emit('splitInsert', $event)"
    />

    <USelect
      v-else-if="field.kind === 'enum'"
      :model-value="enumValue"
      :items="options"
      value-key="value"
      label-key="label"
      class="w-full"
      @update:model-value="writeEnum($event)"
    />

    <TenantPageCalculatorField
      v-else-if="field.kind === 'calculator'"
      :organization-id="organizationId"
      :page-id="pageId"
      :block-id="blockId"
    />

    <TenantPageGalleryField
      v-else-if="field.kind === 'media' && field.slot === 'gallery'"
      :organization-id="organizationId"
      :page-id="pageId"
      :block-id="blockId"
    />

    <MediaPicker
      v-else-if="field.kind === 'media'"
      :organization-id="organizationId"
      :model-value="mediaAsset?.asset_id"
      :selected-summary="mediaAsset"
      :accept="field.accept ?? 'image'"
      @update:model-value="writeMedia($event)"
    />

    <USelectMenu
      v-else-if="field.kind === 'reference' && multipleReference"
      :model-value="stringList"
      :items="referenceOptions"
      value-key="value"
      label-key="label"
      multiple
      class="w-full"
      :placeholder="`Choose ${field.label.toLowerCase()}`"
      @update:model-value="writeStringList($event)"
    />

    <USelectMenu
      v-else-if="field.kind === 'reference'"
      :model-value="stringValue || undefined"
      :items="referenceOptions"
      value-key="value"
      label-key="label"
      class="w-full"
      :placeholder="`Choose a ${field.label.toLowerCase()}`"
      @update:model-value="write($event)"
    />

    <UInputNumber
      v-else-if="field.kind === 'number'"
      :model-value="numberValue"
      :min="field.min"
      :max="field.max"
      class="w-full"
      @update:model-value="writeNumber($event)"
    />

    <!-- A record is one object of named fields: a button is its label and its URL. -->
    <div v-else-if="field.kind === 'record'" class="flex flex-col gap-3">
      <UInput
        v-for="(child, childKey) in field.of"
        :key="childKey"
        :model-value="recordValue(String(childKey))"
        class="w-full"
        :placeholder="child.kind === 'url' ? '/contact or https://example.com' : child.label"
        :aria-label="child.label"
        @update:model-value="writeRecord(String(childKey), $event)"
      />
    </div>

    <UTextarea
      v-else-if="field.multiline"
      :model-value="stringValue"
      variant="none"
      :rows="1"
      autoresize
      class="w-full"
      @update:model-value="write($event)"
    />

    <UInput
      v-else
      :model-value="stringValue"
      :type="field.kind === 'url' ? 'text' : 'text'"
      :placeholder="field.kind === 'url' ? '/contact or https://example.com' : undefined"
      :autofocus="autofocus"
      class="w-full"
      @update:model-value="write($event)"
    />
  </UFormField>
</template>

<script setup lang="ts">
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'
import TenantPageGalleryField from '~/components/dashboard/TenantPageGalleryField.vue'
import TenantPageCalculatorField from '~/components/dashboard/TenantPageCalculatorField.vue'
import { isPlatformTemplate } from '~/utils/template-registry'
import type { TenantPageField } from '~/utils/tenant-page-blocks'

/**
 * One declared field, drawn as the control its kind calls for.
 *
 * Every control the editor has lived in one 200-line `v-if` chain keyed by
 * block type and then by section, which is why a field could be declared and
 * never shown, or shown and never saved: the chain and the contract were two
 * different documents. Here the contract is the only document — a field exists
 * because the registry declares it, and it is editable because it exists.
 */
const props = defineProps<{
  organizationId: string
  pageId: string
  blockId: string
  fieldKey: string
  field: TenantPageField
  autofocus?: boolean
  /** Records this field may reference, already loaded by the leaf that owns them. */
  referenceOptions?: { label: string; value: string }[]
}>()

defineEmits<{ splitInsert: [{ after: string; blockType: 'image' | 'faq' | 'how_to'; editorMode: 'rich' | 'source' }] }>()

const block = useTenantPageBlock(props.organizationId, props.pageId, () => props.blockId)
const dashboard = useDashboardOrganization()


const stringValue = computed(() => {
  const value = block.value.data[props.fieldKey]
  return value == null ? '' : String(value)
})

const stringList = computed(() => {
  const value = block.value.data[props.fieldKey]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
})

const multipleReference = computed(() => props.fieldKey.endsWith('_ids'))

const options = computed(() => {
  const platform = isPlatformTemplate({ themeId: dashboard.organization.value?.theme_id })
  return (props.field.options ?? []).filter(option => !option.platformOnly || platform)
})


const isEmptyChoice = computed(() => props.field.kind === 'enum' && options.value.length === 0)

const description = computed(() => {
  if (props.field.pairedWith) return 'Set this together with its pair, or leave both empty.'
  return undefined
})

/**
 * `level` is the block's own column, not its data. The level control used to
 * write `data.level`, which the writer deletes on save and no renderer reads,
 * so choosing a heading level did nothing at all.
 */
const enumValue = computed(() => (props.field.store === 'level'
  ? String(block.value.level ?? props.field.default ?? '')
  : stringValue.value || props.field.default || ''))

const markdownMode = computed<'rich' | 'source'>(() => (String(block.value.data.editor_mode) === 'source' ? 'source' : 'rich'))

// The whole placement, not just its id: it already carries the URLs the picker
// renders, which is what stops a populated picker fetching the asset it was
// handed.
const mediaAsset = computed(() => block.value.media
  .filter(item => item.slot === (props.field.slot ?? 'media'))
  .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))[0])

function write(value: unknown) {
  block.value.data[props.fieldKey] = value == null ? '' : String(value)
}

function writeEnum(value: unknown) {
  if (props.field.store !== 'level') {
    write(value)
    return
  }
  const level = Number(value)
  block.value.level = Number.isInteger(level) && level >= 1 && level <= 6 ? level : null
}

const numberValue = computed(() => {
  const value = Number(block.value.data[props.fieldKey] ?? props.field.default)
  return Number.isFinite(value) ? value : undefined
})

function writeNumber(value: unknown) {
  const number = Number(value)
  if (Number.isInteger(number)) block.value.data[props.fieldKey] = number
}

function recordValue(childKey: string): string {
  const record = block.value.data[props.fieldKey]
  const value = record && typeof record === 'object' && !Array.isArray(record) ? (record as Record<string, unknown>)[childKey] : ''
  return typeof value === 'string' ? value : ''
}

/** A record with every field empty is no record at all, not an object of blanks. */
function writeRecord(childKey: string, value: unknown) {
  const current = block.value.data[props.fieldKey]
  const next = { ...(current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {}), [childKey]: value == null ? '' : String(value) }
  block.value.data[props.fieldKey] = Object.values(next).every(item => !String(item ?? '').trim()) ? null : next
}

function writeStringList(value: unknown) {
  block.value.data[props.fieldKey] = Array.isArray(value) ? value.map(item => String(item)) : []
}

function writeMedia(assetId: string | null | undefined) {
  const slot = props.field.slot ?? 'media'
  block.value.media = [
    ...block.value.media.filter(item => item.slot !== slot),
    ...(assetId ? [{ asset_id: assetId, slot, sort_order: 0 }] : []),
  ]
}
</script>
