<template>
  <DashboardLeafPanel
    id="organization-color"
    title="Colors"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <div v-if="palette" class="space-y-10">
      <section>
        <h2 class="text-base font-semibold text-highlighted">Start from a palette</h2>
        <p class="mt-1 text-sm text-muted">Each sets light and dark colors together. You can adjust any of them below.</p>
        <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="starter-palettes">
          <button
            v-for="starter in STARTER_PALETTES"
            :key="starter.id"
            type="button"
            class="rounded-lg border border-default p-2 text-left transition hover:border-accented focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            :aria-label="`Use the ${starter.label} palette`"
            @click="useStarter(starter.palette)"
          >
            <span class="flex h-10 overflow-hidden rounded-md">
              <span v-for="mode in SITE_PALETTE_MODES" :key="mode" class="flex flex-1" :style="{ background: starter.palette[mode].ground }">
                <span class="m-1.5 flex-1 rounded-sm" :style="{ background: starter.palette[mode].action }" />
                <span class="my-1.5 mr-1.5 w-2 rounded-sm" :style="{ background: starter.palette[mode].accent }" />
              </span>
            </span>
            <span class="mt-2 block text-sm font-medium text-highlighted">{{ starter.label }}</span>
          </button>
        </div>
      </section>

      <section>
        <h2 class="text-base font-semibold text-highlighted">Your colors</h2>
        <table class="mt-4 w-full text-sm" data-testid="palette-table">
          <thead>
            <tr class="text-left text-muted">
              <th class="pb-2 font-normal">Role</th>
              <th v-for="mode in SITE_PALETTE_MODES" :key="mode" class="pb-2 pl-3 font-normal capitalize">{{ mode }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr v-for="entry in SITE_PALETTE_ROLES" :key="entry.role">
              <td class="py-3 pr-3 align-top">
                <span class="block font-medium text-highlighted">{{ entry.label }}</span>
                <span class="block text-xs text-muted">{{ entry.rule }}</span>
              </td>
              <td v-for="mode in SITE_PALETTE_MODES" :key="mode" class="py-3 pl-3 align-top">
                <div class="flex items-center gap-2">
                  <UPopover>
                    <button
                      type="button"
                      class="size-8 shrink-0 rounded-md ring-1 ring-inset ring-accented"
                      :style="{ background: palette[mode][entry.role] }"
                      :aria-label="`Pick the ${mode} ${entry.label.toLowerCase()} color`"
                    />
                    <template #content>
                      <UColorPicker v-model="palette[mode][entry.role]" format="hex" class="p-3" />
                    </template>
                  </UPopover>
                  <UInput v-model="palette[mode][entry.role]" maxlength="7" class="w-28" :aria-label="`${entry.label} ${mode} hex color`" />
                </div>
                <p v-if="contrastFor(mode, entry.role)" class="mt-1 flex items-center gap-1 text-xs" :class="contrastFor(mode, entry.role)!.passes ? 'text-muted' : 'text-error'">
                  <UIcon :name="contrastFor(mode, entry.role)!.passes ? 'i-lucide-check' : 'i-lucide-triangle-alert'" class="size-3.5" />
                  {{ contrastFor(mode, entry.role)!.ratio }}:1
                  <span v-if="!contrastFor(mode, entry.role)!.passes">· below {{ contrastFor(mode, entry.role)!.minimum }}:1</span>
                </p>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="mt-3 text-xs text-muted">Borders, tints and hover states are made from these. Ratios are WCAG contrast against the ground; text needs 4.5:1, the action color 3:1.</p>
      </section>

      <section>
        <h2 class="text-base font-semibold text-highlighted">Preview</h2>
        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <div v-for="mode in SITE_PALETTE_MODES" :key="mode">
            <div class="tenant-theme rounded-lg p-5" :style="previewStyle(mode)" :data-font-template="editor.theme.value" :data-font-preset="editor.form.font_preset" :data-testid="`palette-preview-${mode}`">
              <p class="text-xs uppercase tracking-wide text-muted">{{ mode }}</p>
              <p class="mt-2 font-[family-name:var(--font-heading)] [font-weight:var(--font-heading-weight)] text-2xl text-highlighted">Welcome in</p>
              <p class="mt-1 text-sm text-default">Fresh plates every evening, by the sea.</p>
              <p class="mt-1 text-xs text-muted">Open daily · 17:00–23:00</p>
              <div class="mt-4 rounded-md border border-default bg-elevated p-3">
                <a href="#" class="text-sm font-medium text-primary underline" @click.prevent>View the menu</a>
              </div>
              <div class="mt-4 flex flex-wrap gap-2">
                <span class="inline-flex items-center rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary">Book a table</span>
                <span class="inline-flex items-center rounded-full border border-primary px-4 py-2 text-sm font-medium text-primary">Call us</span>
                <span class="inline-flex size-9 items-center justify-center rounded-full bg-secondary/15 text-secondary"><UIcon name="i-lucide-sparkles" class="size-4" /></span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <UButton v-if="editor.paletteSource.value === 'custom'" color="neutral" variant="outline" label="Use the default colors" :loading="editor.saving.value" @click="editor.resetPalette" />
    </div>
    <!-- No palette on loaded settings is the platform template; unloaded settings say nothing. -->
    <p v-else-if="editor.theme.value" class="text-base text-muted">KrabiClaw's own site keeps its colors.</p>
    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { SITE_PALETTE_MODES, SITE_PALETTE_ROLES, STARTER_PALETTES, paletteContrast, type SitePalette, type SitePaletteMode, type SitePaletteRole } from '~/shared/site-palette'
import { getOptimalForeground } from '~/utils/color-utils'
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
const palette = computed(() => editor.form.palette)
function useStarter(starter: SitePalette) {
  editor.form.palette = structuredClone(starter)
}
const HEX = /^#[0-9a-f]{6}$/i
const complete = computed(() => palette.value !== null && SITE_PALETTE_MODES.every(mode => SITE_PALETTE_ROLES.every(entry => HEX.test(palette.value![mode][entry.role]))))
// Each panel pins its own mode inline, whatever mode the dashboard is in.
function previewStyle(mode: SitePaletteMode) {
  if (!complete.value) return {}
  const colors = palette.value![mode]
  return {
    colorScheme: mode,
    ...Object.fromEntries(SITE_PALETTE_ROLES.map(entry => [`--site-${entry.role}`, colors[entry.role]])),
    '--site-on-action': getOptimalForeground(colors.action),
    '--site-on-accent': getOptimalForeground(colors.accent),
  }
}

// The pair each role is judged by: text against the ground, the action color
// as a control boundary, and the labels that sit on action and accent fills.
const ROLE_PAIRS: Partial<Record<SitePaletteRole, string[]>> = {
  text: ['text on ground', 'text on surface'],
  muted: ['secondary text on ground', 'secondary text on surface'],
  action: ['action on ground', 'button label on action'],
  accent: ['button label on accent'],
}
const checks = computed(() => complete.value ? paletteContrast(palette.value!) : [])
function contrastFor(mode: SitePaletteMode, role: SitePaletteRole) {
  const pairs = ROLE_PAIRS[role]
  if (!pairs) return null
  const relevant = checks.value.filter(check => check.mode === mode && pairs.includes(check.pair))
  if (!relevant.length) return null
  const worst = relevant.reduce((low, check) => (check.ratio / check.minimum < low.ratio / low.minimum ? check : low))
  return { ratio: worst.ratio, minimum: worst.minimum, passes: worst.ratio >= worst.minimum }
}
</script>
