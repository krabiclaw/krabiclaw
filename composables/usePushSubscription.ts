/**
 * This browser as one of the person's push devices (public/sw.js receives).
 *
 * The same path serves every ask and the settings switch: permission is asked
 * only from a click, the subscription is made with the dashboard's VAPID key,
 * and the subscription is registered with the person's current session — the
 * browser counterpart of the app's setPushEnabled.
 */

// The installed dashboard is scoped to /dashboard (public/manifest.webmanifest).
const SCOPE = '/dashboard/'

export type PushAvailability =
  /** No Push API: an iPhone browser outside the Home Screen app, or a browser without push. */
  | 'unsupported'
  /** The person blocked notifications for this site in the browser. */
  | 'blocked'
  | 'available'

interface PushState {
  availability: PushAvailability
  /** iOS without the Home Screen app is told to add it; any other browser is told it cannot. */
  ios: boolean
  /** This browser's subscription was registered with the current session on this page load. */
  subscribed: boolean
  /** The browser has not been asked yet, so an ask can open its permission prompt. */
  askable: boolean
}

function readAvailability(): PushAvailability {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  return Notification.permission === 'denied' ? 'blocked' : 'available'
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(SCOPE)
  return registration ? await registration.pushManager.getSubscription() : null
}

/** A worker registered from a page outside its scope never becomes `ready` there, so wait for it directly. */
async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: SCOPE })
  const worker = registration.installing ?? registration.waiting
  if (!registration.active && worker) {
    await new Promise<void>((resolve, reject) => {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated') resolve()
        if (worker.state === 'redundant') reject(new Error('The notification service worker could not be installed'))
      })
    })
  }
  return registration
}

function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

async function registerSubscription(subscription: PushSubscription): Promise<void> {
  const { endpoint, keys } = subscription.toJSON()
  if (!endpoint || !keys?.p256dh || !keys.auth) throw new Error('The browser returned a push subscription without its keys')
  await applicationFetch('/api/dashboard/devices', {
    method: 'POST',
    body: { endpoint, p256dh: keys.p256dh, auth: keys.auth },
    validate: (value): value is { status: 'registered' } => isRecord(value) && value.status === 'registered',
  })
}

/**
 * Drops this browser's subscription so a later sign-in on it starts with push
 * off. The server row went with the session (device_tokens.session_id cascades).
 */
export async function forgetPushSubscription(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const subscription = await currentSubscription()
  if (subscription && !await subscription.unsubscribe()) throw new Error('The browser kept its push subscription')
}

export function usePushSubscription() {
  const config = useRuntimeConfig()
  const state = useState<PushState>('push-subscription', () => ({ availability: 'unsupported', ios: false, subscribed: false, askable: false }))

  /** Reads the browser's permission; registration is only ever set by a registration that succeeded. */
  async function refresh(): Promise<void> {
    const availability = readAvailability()
    const held = availability === 'available' && Notification.permission === 'granted' && Boolean(await currentSubscription())
    state.value = {
      availability,
      ios: /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
      subscribed: held && state.value.subscribed,
      askable: availability === 'available' && Notification.permission === 'default',
    }
  }

  async function register(subscription: PushSubscription): Promise<void> {
    state.value = { ...state.value, subscribed: false }
    await registerSubscription(subscription)
    state.value = { ...state.value, subscribed: true }
  }

  /** Runs from a click. Resolves true when this browser now receives push. */
  async function enable(): Promise<boolean> {
    const publicKey = String(config.public.vapidPublicKey || '')
    if (!publicKey) throw new Error('Push notifications are not configured for this dashboard')
    if (readAvailability() !== 'available') {
      await refresh()
      return false
    }
    if (await Notification.requestPermission() !== 'granted') {
      await refresh()
      return false
    }
    const registration = await activeRegistration()
    const subscription = await registration.pushManager.getSubscription()
      ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) })
    await register(subscription)
    await refresh()
    return true
  }

  /** On each dashboard visit: a subscription this browser already holds belongs to the current session. */
  async function resume(): Promise<void> {
    await refresh()
    if (state.value.availability !== 'available' || Notification.permission !== 'granted') return
    const subscription = await currentSubscription()
    if (subscription) await register(subscription)
  }

  return { state: readonly(state), refresh, enable, resume }
}
