import { inject, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch, type InjectionKey, type Ref } from 'vue'
import { isDashboardInvalidation, type DashboardInvalidation } from '~/shared/dashboard-invalidations'

export type DashboardInvalidationStatus = 'closed' | 'connecting' | 'open' | 'failed'

export interface DashboardInvalidationConnection {
  status: Ref<DashboardInvalidationStatus>
  event: Ref<DashboardInvalidation | null>
  /**
   * Counts successful opens. Consumers reconcile both reconnect gaps and the
   * first gap between their initial read and the completed socket upgrade.
   */
  connectionEpoch: Ref<number>
  connect: () => void
}

const dashboardInvalidationKey: InjectionKey<DashboardInvalidationConnection> = Symbol('dashboard-invalidations')
const CONNECT_TIMEOUT_MS = 8_000
const HEARTBEAT_INTERVAL_MS = 20_000
const HEARTBEAT_TIMEOUT_MS = 8_000

export function provideDashboardInvalidations(organizationSlug: Readonly<Ref<string | null>>): DashboardInvalidationConnection {
  // `nuxt dev` cannot carry this socket: its dev server answers the upgrade
  // with a plain 200 (docs/local-development.md). Realtime runs under
  // `yarn dev:worker`, staging and production; here the dashboard stays on its
  // reads instead of retrying a connection that cannot open and reporting it.
  if (import.meta.dev) {
    const connection: DashboardInvalidationConnection = { status: ref('closed'), event: shallowRef(null), connectionEpoch: ref(0), connect: () => {} }
    provide(dashboardInvalidationKey, connection)
    return connection
  }

  const status = ref<DashboardInvalidationStatus>('closed')
  const event = shallowRef<DashboardInvalidation | null>(null)
  const connectionEpoch = ref(0)
  const seenEventIds = new Set<string>()
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let healthTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  let mounted = false
  let stopped = false

  function clearReconnectTimer() {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  function clearHealthTimer() {
    if (healthTimer) clearTimeout(healthTimer)
    healthTimer = null
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer || !organizationSlug.value || !window.navigator.onLine) return
    status.value = 'failed'
    const delay = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempt, 5))
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function failConnection(activeSocket: WebSocket) {
    if (socket !== activeSocket) return
    clearHealthTimer()
    socket = null
    status.value = 'failed'
    activeSocket.close(4000, 'Dashboard connection timed out')
    scheduleReconnect()
  }

  function scheduleHeartbeat(activeSocket: WebSocket) {
    clearHealthTimer()
    healthTimer = setTimeout(() => {
      if (socket !== activeSocket || activeSocket.readyState !== WebSocket.OPEN) return
      activeSocket.send('ping')
      healthTimer = setTimeout(() => failConnection(activeSocket), HEARTBEAT_TIMEOUT_MS)
    }, HEARTBEAT_INTERVAL_MS)
  }

  function connect() {
    if (!import.meta.client || stopped || !organizationSlug.value) return
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return

    clearReconnectTimer()
    clearHealthTimer()
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${scheme}//${window.location.host}/api/dashboard/guest-inbox/socket?org=${encodeURIComponent(organizationSlug.value)}`
    const nextSocket = new WebSocket(url)
    socket = nextSocket
    status.value = 'connecting'
    healthTimer = setTimeout(() => failConnection(nextSocket), CONNECT_TIMEOUT_MS)

    nextSocket.addEventListener('open', () => {
      if (socket !== nextSocket) return
      reconnectAttempt = 0
      status.value = 'open'
      connectionEpoch.value += 1
      scheduleHeartbeat(nextSocket)
    })

    nextSocket.addEventListener('message', (message) => {
      if (socket !== nextSocket) return
      if (message.data === 'pong') {
        scheduleHeartbeat(nextSocket)
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(String(message.data))
      } catch {
        nextSocket.close(1002, 'Invalid dashboard invalidation')
        return
      }
      if (!isDashboardInvalidation(parsed)) {
        nextSocket.close(1002, 'Invalid dashboard invalidation')
        return
      }
      if (seenEventIds.has(parsed.eventId)) return
      seenEventIds.add(parsed.eventId)
      if (seenEventIds.size > 1000) {
        const first = seenEventIds.values().next().value
        if (first) seenEventIds.delete(first)
      }
      event.value = parsed
    })

    nextSocket.addEventListener('close', () => {
      if (socket !== nextSocket) return
      clearHealthTimer()
      socket = null
      if (stopped || !organizationSlug.value) {
        status.value = 'closed'
        return
      }
      scheduleReconnect()
    })

    nextSocket.addEventListener('error', () => {
      nextSocket.close()
    })
  }

  function resetConnection() {
    clearReconnectTimer()
    clearHealthTimer()
    const activeSocket = socket
    socket = null
    activeSocket?.close(1000, 'Dashboard scope changed')
    reconnectAttempt = 0
    seenEventIds.clear()
    event.value = null
    status.value = organizationSlug.value ? 'connecting' : 'closed'
    if (mounted && organizationSlug.value) connect()
  }

  function handleOffline() {
    if (stopped) return
    clearReconnectTimer()
    clearHealthTimer()
    const activeSocket = socket
    socket = null
    activeSocket?.close()
    status.value = organizationSlug.value ? 'failed' : 'closed'
  }

  function handleOnline() {
    if (!stopped && organizationSlug.value) connect()
  }

  watch(organizationSlug, resetConnection, { flush: 'sync' })

  onMounted(() => {
    mounted = true
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    connect()
  })

  onBeforeUnmount(() => {
    stopped = true
    window.removeEventListener('offline', handleOffline)
    window.removeEventListener('online', handleOnline)
    clearReconnectTimer()
    clearHealthTimer()
    socket?.close(1000, 'Dashboard closed')
    socket = null
    status.value = 'closed'
  })

  const connection = { status, event, connectionEpoch, connect }
  provide(dashboardInvalidationKey, connection)
  return connection
}

export function useDashboardInvalidations(): DashboardInvalidationConnection {
  const connection = inject(dashboardInvalidationKey, null)
  if (!connection) throw new Error('Dashboard invalidations require the dashboard layout')
  return connection
}
