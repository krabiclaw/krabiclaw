<template>
  <!-- Zaraz holds the choice in its consent cookie. Until a visitor chooses,
       its Google Analytics purpose stays off and its events stay queued. -->
  <div
    v-if="visible"
    role="region"
    :aria-label="t('legal.analytics_notice_label')"
    class="consent-notice"
  >
    <div class="consent-banner">
      <button type="button" class="consent-close" aria-label="Close and accept cookies" @click="choose(true)">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
      <p class="consent-copy">
        {{ t('legal.analytics_notice') }}
        <a :href="privacyUrl">{{ t('legal.analytics_notice_link') }}</a>.
      </p>
      <div class="consent-actions">
        <button type="button" class="consent-choice consent-accept" @click="choose(true)">{{ t('legal.accept') }}</button>
        <button type="button" class="consent-choice consent-reject" @click="choose(false)">{{ t('legal.reject') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ZARAZ_ANALYTICS_PURPOSE_ID, ZARAZ_CONSENT_COOKIE_NAME } from '~/utils/zaraz-consent'

const { t } = useI18n()
const privacyUrl = new URL('/policies/privacy', useRuntimeConfig().public.siteUrl).href
// Local visual preview uses the real banner without a Cloudflare consent runtime.
const visible = ref(import.meta.dev && useRoute().query.previewConsent === 'true')

function showNotice() {
  const consent = window.zaraz?.consent
  if (!consent?.APIReady) return
  const answered = document.cookie.split('; ').some(cookie => cookie.startsWith(`${ZARAZ_CONSENT_COOKIE_NAME}=`))
  if (answered) return
  visible.value = true
}

function choose(accepted: boolean) {
  const consent = window.zaraz?.consent
  if (!consent?.APIReady) return
  consent.set({ [ZARAZ_ANALYTICS_PURPOSE_ID]: accepted })
  if (accepted) consent.sendQueuedEvents()
  visible.value = false
}

onMounted(() => {
  document.addEventListener('zarazConsentAPIReady', showNotice)
  showNotice()
})
onBeforeUnmount(() => document.removeEventListener('zarazConsentAPIReady', showNotice))
</script>

<style scoped>
.consent-notice { position: fixed; inset: auto 0 0; z-index: 50; padding: 12px; display: flex; justify-content: center; }
.consent-banner { position: relative; display: flex; align-items: center; gap: 16px; width: 100%; max-width: 1024px; padding: 16px 52px 16px 20px; border: 1px solid var(--ui-border); border-radius: 16px; background: var(--ui-bg-elevated); color: var(--ui-text); box-shadow: 0 8px 32px #0003; font-size: 14px; }
.consent-copy { flex: 1; min-width: 0; margin: 0; line-height: 1.5; }
.consent-copy a { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
.consent-actions { display: flex; flex-shrink: 0; gap: 8px; }
.consent-choice { padding: 8px 16px; border: 0; border-radius: 8px; font: inherit; font-weight: 600; line-height: 1.5; cursor: pointer; }
.consent-accept { background: var(--action); color: var(--action-foreground); }
.consent-reject { background: var(--ui-error); color: #fff; }
.consent-close { position: absolute; top: 8px; right: 8px; display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
.consent-choice:hover, .consent-close:hover { filter: brightness(.9); }
.consent-choice:focus-visible, .consent-close:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
@media (max-width: 640px) {
  .consent-banner { flex-direction: column; align-items: stretch; gap: 12px; padding: 16px; }
  .consent-copy { padding-right: 28px; }
  .consent-choice { flex: 1; }
}
</style>
