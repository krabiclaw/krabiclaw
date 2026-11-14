import { computed, inject, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch, type InjectionKey, type Ref } from 'vue'
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
  /** Last successful reconnect in the current workspace or account scope. */
  reconnectEpoch: Ref<number>
  accessEnded: Ref<number>
  connect: () => void
  waitForFirstOpen: (signal: AbortSignal) => Promise<void>
}

const dashboardInvalidationKey: InjectionKey<DashboardInvalidationConnection> = Symbol('dashboard-invalidations')
const CONNECT_TIMEOUT_MS = 8_000
const INITIAL_READ_WAIT_MS = 350
const HEARTBEAT_INTERVAL_MS = 20_000
const HEARTBEAT_TIMEOUT_MS = 8_000

function useInvalidationSocket(path: Readonly<Ref<string | null>>, organizationId: Readonly<Ref<string | null | undefined>>, reader: Readonly<Ref<string | undefined>>): DashboardInvalidationConnection {
  // `nuxt dev` cannot carry this socket: its dev server answers the upgrade
  // with a plain 200 (docs/local-development.md). Realtime runs under
  // `yarn dev:worker`, staging and production; here the dashboard stays on its
  // reads instead of retrying a connection that cannot open and reporting it.
  if (import.meta.dev) {
    return { status: ref('closed'), event: shallowRef(null), connectionEpoch: ref(0), reconnectEpoch: ref(0), accessEnded: ref(0), connect: () => {}, waitForFirstOpen: async () => {} }
  }

  const status = ref<DashboardInvalidationStatus>('closed')
  const event = shallowRef<DashboardInvalidation | null>(null)
  const connectionEpoch = ref(0)
  const reconnectEpoch = ref(0)
  const accessEnded = ref(0)
  let opened = false
  let receivedAccessChange = false
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
    if (stopped || reconnectTimer || !path.value || !window.navigator.onLine) return
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
    if (!import.meta.client || stopped || !path.value) return
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return

    clearReconnectTimer()
    clearHealthTimer()
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${scheme}//${window.location.host}${path.value}`
    receivedAccessChange = false
    const nextSocket = new WebSocket(url)
    socket = nextSocket
    status.value = 'connecting'
    healthTimer = setTimeout(() => failConnection(nextSocket), CONNECT_TIMEOUT_MS)

    nextSocket.addEventListener('open', () => {
      if (socket !== nextSocket) return
      reconnectAttempt = 0
      connectionEpoch.value += 1
      if (opened) reconnectEpoch.value = connectionEpoch.value
      opened = true
      status.value = 'open'
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
        nextSocket.close(4002, 'Invalid dashboard invalidation')
        return
      }
      if (!isDashboardInvalidation(parsed)) {
        nextSocket.close(4002, 'Invalid dashboard invalidation')
        return
      }
      if (seenEventIds.has(parsed.event_id)) return
      seenEventIds.add(parsed.event_id)
      if (seenEventIds.size > 1000) {
        const first = seenEventIds.values().next().value
        if (first) seenEventIds.delete(first)
      }
      if (parsed.type === 'access.changed') receivedAccessChange = true
      event.value = parsed
    })

    nextSocket.addEventListener('close', (closed) => {
      if (socket !== nextSocket) return
      clearHealthTimer()
      socket = null
      if (closed.code === 1008 && !receivedAccessChange) {
        if (organizationId.value) {
          event.value = { type: 'access.changed', organization_id: organizationId.value, event_id: crypto.randomUUID(), occurred_at: new Date().toISOString() }
        } else accessEnded.value++
      }
      if (stopped || !path.value) {
        status.value = 'closed'
        return
      }
      scheduleReconnect()
    })

    nextSocket.addEventListener('error', () => {
      nextSocket.close()
    })
  }

  /** Start a cold read after its subscription, unless the socket is slow or unavailable. */
  async function waitForFirstOpen(signal: AbortSignal) {
    if (!import.meta.client || signal.aborted || status.value === 'open' || status.value === 'failed' || !window.navigator.onLine) return
    connect()
    await new Promise<void>(resolve => {
      const stop = watch(status, value => {
        if (value === 'open' || value === 'failed' || value === 'closed') finish()
      }, { flush: 'sync' })
      const timer = setTimeout(finish, INITIAL_READ_WAIT_MS)
      signal.addEventListener('abort', finish, { once: true })
      function finish() {
        clearTimeout(timer)
        stop()
        signal.removeEventListener('abort', finish)
        resolve()
      }
    })
  }

  function resetConnection() {
    clearReconnectTimer()
    clearHealthTimer()
    const activeSocket = socket
    socket = null
    activeSocket?.close(1000, 'Dashboard scope changed')
    reconnectAttempt = 0
    opened = false
    reconnectEpoch.value = 0
    seenEventIds.clear()
    event.value = null
    status.value = path.value ? 'connecting' : 'closed'
    if (mounted && path.value) connect()
  }

  function handleOffline() {
    if (stopped) return
    clearReconnectTimer()
    clearHealthTimer()
    const activeSocket = socket
    socket = null
    activeSocket?.close()
    status.value = path.value ? 'failed' : 'closed'
  }

  function handleOnline() {
    if (!stopped && path.value) connect()
  }

  watch(path, resetConnection, { flush: 'sync' })
  watch(reader, (next, previous) => {
    // Learning the identity of the session already used in the handshake does not change it.
    if (previous !== undefined && next !== undefined && next !== previous) resetConnection()
  }, { flush: 'sync' })

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

  return { status, event, connectionEpoch, reconnectEpoch, accessEnded, connect, waitForFirstOpen }
}

export function provideDashboardInvalidations(organizationSlug: Readonly<Ref<string | null>>, personal: Readonly<Ref<boolean>>, reader: Readonly<Ref<string | undefined>>, sessionPending: Readonly<Ref<boolean>>): DashboardInvalidationConnection {
  const path = computed(() => {
    if (!reader.value && !sessionPending.value) return null
    if (organizationSlug.value) return `/api/dashboard/guest-inbox/socket?org=${encodeURIComponent(organizationSlug.value)}`
    return personal.value ? '/api/dashboard/guest-inbox/socket?scope=account' : null
  })
  const connection = useInvalidationSocket(path, useDashboardOrganization().organizationId, reader)
  provide(dashboardInvalidationKey, connection)
  return connection
}

export function useDashboardInvalidations(): DashboardInvalidationConnection {
  const connection = inject(dashboardInvalidationKey, null)
  if (!connection) throw new Error('Dashboard invalidations require the dashboard layout')
  return connection
}
