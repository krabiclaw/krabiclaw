import type { StayDetail } from '~/server/domain/stays'
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, shallowRef, toValue, watch, type InjectionKey, type MaybeRefOrGetter, type Ref, type ShallowRef } from 'vue'
import { isDashboardInvalidation, type DashboardInvalidation } from '~/shared/dashboard-invalidations'
import type { ConversationPage } from '~/shared/messages-contract'

export type DashboardInvalidationStatus = 'closed' | 'connecting' | 'open' | 'failed'

type SavedReservation = Omit<StayDetail, 'id'> & { booking_id: string; unit: 'nights' }

export interface DashboardInvalidationConnection {
  savedReservation: ShallowRef<SavedReservation | null>
  status: Ref<DashboardInvalidationStatus>
  readyForReuse: Readonly<Ref<boolean>>
  event: Ref<DashboardInvalidation | null>
  /** Last successful reconnect in the current workspace or account scope; reads made before it re-read once. The first open does not count. */
  reconnectEpoch: Ref<number>
  accessEnded: Ref<number>
  /** Heads being read before their conversation opens; an opening conversation takes its read from here. */
  conversationReads: Map<string, Promise<ConversationPage | undefined>>
  held: HeldReads
  connect: () => void
}

export interface HeldRead {
  key: string
  value?: unknown
  pending?: Promise<unknown>
  expiresAt?: number
  /** The events that make the read stale; `value` is what it holds, if anything yet. */
  dropsOn: (event: DashboardInvalidation, value: unknown) => boolean
}

/** The events Today and Insights re-read on: bookings, nights, reviews and messages change with them. */
export const businessChanged = (event: DashboardInvalidation) => event.type === 'business.changed' || event.type === 'stay.changed'
  || event.type === 'nights.changed' || event.type === 'access.changed' || ((event.type === 'MESSAGE_CREATE' || event.type === 'MESSAGE_UPDATE') && !event.team)

/**
 * Reads a return within the live connection shows again instead of repeating
 * them: held under a key (screen, reader, workspace and the filters that
 * identify the read) while the socket stays open for the same reader, until
 * they expire or an event they declare drops them. A read an event, a closed
 * socket or another reader overtook is not held. Taking a read removes it;
 * `limit` keeps only the newest held reads of the key's screen.
 */
function heldReads(status: Readonly<Ref<DashboardInvalidationStatus>>, reads: Map<string, HeldRead>) {
  const live = (read?: HeldRead) => read && 'value' in read && (read.expiresAt === undefined || read.expiresAt > Date.now()) ? read : undefined
  const screen = (key: string) => key.slice(0, key.indexOf(':'))
  return {
    get(key: string, keepUntil?: number) {
      const read = live(reads.get(key))
      if (read && keepUntil !== undefined) {
        read.expiresAt = keepUntil
        reads.delete(key)
        reads.set(key, read)
      }
      return read?.value
    },
    pending: (key: string) => reads.get(key)?.pending,
    current: (read: HeldRead) => reads.get(read.key) === read,
    take(key: string) {
      const read = live(reads.get(key))
      reads.delete(key)
      return read
    },
    begin(key: string, dropsOn: HeldRead['dropsOn']): HeldRead {
      const read = { ...reads.get(key), key, dropsOn }
      if (status.value === 'open') reads.set(key, read)
      return read
    },
    hold(read: HeldRead, value: unknown, expiresAt?: number, limit?: number) {
      if (reads.get(read.key) !== read || (expiresAt !== undefined && expiresAt <= Date.now())) return
      Object.assign(read, { value, expiresAt })
      reads.delete(read.key)
      reads.set(read.key, read)
      for (const [key, other] of reads) if (other.expiresAt !== undefined && other.expiresAt <= Date.now()) reads.delete(key)
      if (!limit) return
      const same = [...reads.values()].filter(other => 'value' in other && screen(other.key) === screen(read.key))
      for (const other of same.slice(0, Math.max(0, same.length - limit))) reads.delete(other.key)
    },
  }
}

export type HeldReads = ReturnType<typeof heldReads>

const dashboardInvalidationKey: InjectionKey<DashboardInvalidationConnection> = Symbol('dashboard-invalidations')
const CONNECT_TIMEOUT_MS = 8_000
const HEARTBEAT_INTERVAL_MS = 20_000
const HEARTBEAT_TIMEOUT_MS = 8_000

function useInvalidationSocket(path: Readonly<Ref<string | null>>, organizationId: Readonly<Ref<string | null | undefined>>, reader: Readonly<Ref<string | undefined>>): DashboardInvalidationConnection {
  const conversationReads = new Map<string, Promise<ConversationPage | undefined>>()
  const reads = new Map<string, HeldRead>()
  const status = ref<DashboardInvalidationStatus>('closed')
  const readyForReuse = computed(() => status.value === 'open' && Boolean(reader.value))
  const held = heldReads(status, reads)
  const savedReservation = shallowRef<SavedReservation | null>(null)
  // `nuxt dev` cannot carry this socket: its dev server answers the upgrade
  // with a plain 200. Realtime runs under
  // `yarn dev:worker`, staging and production; here the dashboard stays on its
  // reads instead of retrying a connection that cannot open and reporting it.
  if (import.meta.dev) {
    return { status, readyForReuse, event: shallowRef(null), reconnectEpoch: ref(0), accessEnded: ref(0), savedReservation, conversationReads, held, connect: () => {} }
  }

  const event = shallowRef<DashboardInvalidation | null>(null)
  let opens = 0
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
      opens += 1
      if (opened) reconnectEpoch.value = opens
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
      for (const [key, read] of reads) if (read.dropsOn(parsed, read.value)) reads.delete(key)
      event.value = parsed
    })

    nextSocket.addEventListener('close', (closed) => {
      if (socket !== nextSocket) return
      clearHealthTimer()
      socket = null
      status.value = path.value ? 'failed' : 'closed'
      if (closed.code === 1008 && !receivedAccessChange) {
        if (organizationId.value) {
          event.value = { type: 'access.changed', organization_id: organizationId.value, event_id: crypto.randomUUID(), occurred_at: new Date().toISOString() }
        } else accessEnded.value++
      }
      if (stopped || !path.value) return
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

  watch(path, () => { savedReservation.value = null; resetConnection() }, { flush: 'sync' })
  watch(status, value => {
    if (value !== 'open') reads.clear()
  }, { flush: 'sync' })
  watch(reader, (next, previous) => {
    reads.clear()
    savedReservation.value = null
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

  return { status, readyForReuse, event, reconnectEpoch, accessEnded, savedReservation, conversationReads, held, connect }
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

/** A CMS index can reuse its last authorized response while its workspace socket is live. */
export function useWebsiteIndexData<T>(key: MaybeRefOrGetter<string>, read: (signal?: AbortSignal) => Promise<T>, options: { server?: boolean; lazy?: boolean; immediate?: boolean } = {}) {
  const nuxt = useNuxtApp()
  const realtime = useDashboardInvalidations()
  const cacheKey = (name: string) => `website:${name}`
  const request = useAsyncData(key, async (_app, { signal }) => {
    const entry = realtime.held.begin(cacheKey(toValue(key)), businessChanged)
    const value = await read(signal)
    realtime.held.hold(entry, value, Date.now() + 30_000, 16)
    return value
  }, {
    ...options,
    dedupe: 'defer',
    getCachedData(name, app, { cause }) {
      if (cause !== 'initial') return undefined
      return (app.isHydrating ? app.payload.data[name] : realtime.held.get(cacheKey(name))) as T | undefined
    },
  })
  if (import.meta.client && nuxt.isHydrating) {
    const name = toValue(key)
    const value = nuxt.payload.data[name] as T | undefined
    const hold = () => {
      if (value === undefined || toValue(key) !== name || request.data.value !== value) return
      const entry = realtime.held.begin(cacheKey(name), businessChanged)
      realtime.held.hold(entry, value, Date.now() + 30_000, 16)
    }
    // The first session read clears holds made before the reader was known.
    if (realtime.readyForReuse.value) hold()
    else if (value !== undefined) {
      const stop = watch([realtime.readyForReuse, realtime.status], ([ready, status]) => {
        if (!ready && status !== 'failed') return
        stop()
        if (ready) hold()
      }, { flush: 'post' })
    }
  }
  return request
}
