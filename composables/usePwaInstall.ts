import { ref, computed, readonly } from 'vue'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const installPromptEvent = ref<BeforeInstallPromptEvent | null>(null)
const isInstalled = ref(false)
let listenerRegistered = false

export function usePwaInstall() {
  if (import.meta.client && typeof window !== 'undefined' && !listenerRegistered) {
    listenerRegistered = true

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true)

    if (isStandalone) {
      isInstalled.value = true
    }

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault()
      installPromptEvent.value = event as BeforeInstallPromptEvent
    })

    window.addEventListener('appinstalled', () => {
      isInstalled.value = true
      installPromptEvent.value = null
    })
  }

  const canInstall = computed(() => Boolean(installPromptEvent.value) && !isInstalled.value)

  async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const prompt = installPromptEvent.value
    if (!prompt) return 'unavailable'
    await prompt.prompt()
    const { outcome } = await prompt.userChoice
    if (outcome === 'accepted') {
      isInstalled.value = true
    }
    installPromptEvent.value = null
    return outcome
  }

  return {
    canInstall,
    isInstalled: readonly(isInstalled),
    promptInstall,
  }
}
