<template>
  <section :id="block.id" class="kc-mcp-connect" data-parity-section="connect">
    <div class="kc-mcp-connect__inner">
      <div class="kc-mcp-connect__heading">
        <h2>{{ title }}</h2>
        <p v-if="description">{{ description }}</p>
      </div>
      <ol class="kc-mcp-connect__steps">
        <li v-for="(step, index) in steps" :key="step.name">
          <span class="kc-mcp-connect__number">0{{ index + 1 }}</span>
          <h3>{{ step.name }}</h3>
          <TenantPageMarkdown :content="step.text" class="kc-mcp-connect__body" />
          <div v-if="stepUrl(step)" class="kc-mcp-connect__endpoint">
            <code>{{ stepUrl(step) }}</code>
            <button type="button" aria-label="Copy MCP server URL" @click="copy(stepUrl(step)!)">
              <PlatformIcon :name="copyFailed ? 'x' : copied ? 'check' : 'clipboard'" class="size-4" />
            </button>
          </div>
          <p v-if="copyFailed && stepUrl(step)" class="kc-mcp-connect__status" role="status">Your browser blocked the clipboard — select the URL above and copy it.</p>
          <p v-else-if="copied && stepUrl(step)" class="kc-mcp-connect__status" role="status">MCP server URL copied.</p>
        </li>
      </ol>
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockTextOrNull, blockRecords } from '~/utils/tenant-page-block-data'
/**
 * The connection steps and their MCP endpoint come from the page document.
 * The copy button uses the exact URL named in the relevant step.
 */
const props = defineProps<{ block: TenantPageBlock; page: PublicTenantPage }>()

const title = computed(() => blockTextOrNull(props.block.data.title))
const description = computed(() => blockTextOrNull(props.block.data.description))
const steps = computed(() => blockRecords(props.block.data.steps)
  .map(step => ({ name: blockText(step.name), text: blockText(step.text) }))
  .filter(step => step.name))

function stepUrl(step: { text: string }): string | null {
  const match = step.text.match(/https:\/\/[^\s)]+\/api\/mcp/)
  return match ? match[0] : null
}

const copied = ref(false)
const copyFailed = ref(false)
async function copy(url: string) {
  copyFailed.value = false
  try {
    await navigator.clipboard.writeText(url)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // The clipboard is denied often enough that throwing here would be wrong,
    // but the reader has to be told: the button previously did nothing at all
    // and said nothing, so they pasted whatever was already on the clipboard.
    copyFailed.value = true
    setTimeout(() => { copyFailed.value = false }, 4000)
  }
}
</script>

<style scoped>
.kc-mcp-connect { scroll-margin-top: 5rem; padding: clamp(4rem, 7.5vw, 7.5rem) 0; background: #f6f4ef; color: #171b31; }
.kc-mcp-connect__inner { width: min(86%, 86rem); margin: auto; }
.kc-mcp-connect__heading { display: grid; grid-template-columns: 1fr 1fr; align-items: end; gap: 4rem; }
.kc-mcp-connect h2 { max-width: 14ch; font-size: clamp(2.8rem, 5.3vw, 5rem); font-weight: 400; line-height: 1.04; letter-spacing: -.045em; margin: 0; white-space: pre-line; text-wrap: balance; }
.kc-mcp-connect__heading > p { max-width: 32rem; margin: 0; color: #62646c; font-size: clamp(1.1rem, 1.6vw, 1.4rem); line-height: 1.6; }
.kc-mcp-connect__steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3rem; list-style: none; padding: 0; margin: 4rem 0 0; }
.kc-mcp-connect__steps > li { min-width: 0; border-top: 1px solid #c9c6c0; padding-top: 1.5rem; }
.kc-mcp-connect__number { display: block; color: #945448; font-size: .9rem; margin-bottom: 1.75rem; }
.kc-mcp-connect h3 { font-size: clamp(1.4rem, 2.4vw, 2rem); font-weight: 400; line-height: 1.2; letter-spacing: -.025em; margin: 0 0 1rem; }
.kc-mcp-connect__body { color: #62646c; font-size: 1.05rem; line-height: 1.65; }
.kc-mcp-connect__body :deep(p) { margin: 0 0 1rem; }
.kc-mcp-connect__body :deep(a) { color: #944537; }
.kc-mcp-connect__endpoint { display: flex; align-items: start; gap: 1rem; margin-top: 1.5rem; padding: 1rem 0; border-top: 1px solid #d4d1c9; border-bottom: 1px solid #d4d1c9; }
.kc-mcp-connect__endpoint code { min-width: 0; color: #171b31; font-size: .8rem; line-height: 1.6; overflow-wrap: anywhere; user-select: all; }
.kc-mcp-connect__endpoint button { display: inline-flex; align-items: center; justify-content: center; flex: none; min-width: 2rem; min-height: 2rem; margin: -.4rem 0 -.4rem auto; padding: .4rem; border: 0; background: transparent; color: #171b31; cursor: pointer; }
.kc-mcp-connect__endpoint button:hover { background: #e7e3da; }
.kc-mcp-connect__status { margin: .75rem 0 0; color: #944537; font-size: .8rem; line-height: 1.5; }
@media (max-width: 767px) {
  .kc-mcp-connect__heading, .kc-mcp-connect__steps { grid-template-columns: 1fr; gap: 2rem; }
  .kc-mcp-connect__steps { margin-top: 3rem; }
  .kc-mcp-connect__number { margin-bottom: 1rem; }
}
</style>
