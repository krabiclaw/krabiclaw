import { channexCreate, channexGet, channexList, ChannexError, type ChannexEnv } from './client'
import { ChannexDataError, integer, object, resource, string, type JsonRecord, type Resource } from './data'

export interface ChannexMessageThread {
  id: string
  propertyId: string
  channelId: string | null
  bookingId: string | null
  /** A conversation label supplied by Channex, not a verified guest name. */
  title: string
  provider: 'Airbnb' | 'AirBNB'
  isClosed: boolean
  messageCount: number
  insertedAt: string
  updatedAt: string
}

export interface ChannexMessage {
  id: string
  threadId: string
  sender: 'guest' | 'property' | 'system'
  text: string | null
  attachments: string[]
  insertedAt: string
  updatedAt: string
  meta?: JsonRecord | null
}

export interface ChannexMessagesInstallation {
  id: string
  propertyId: string
  applicationCode: 'channex_messages'
}

/** A malformed successful write remains uncertain; it must never be sent again blindly. */
export class ChannexMessageDataError extends ChannexError {
  override readonly statusCode = 502
  override readonly data: { code: 'INVALID_PROVIDER_RESPONSE'; resource: string; field: string; uncertain: boolean }

  constructor(resource: string, field: string, message: string, uncertain = false) {
    super(`Channex returned invalid ${resource}.${field}: ${message}`, 502, uncertain)
    this.data = { code: 'INVALID_PROVIDER_RESPONSE', resource, field, uncertain }
  }
}

function read<T>(label: string, field: string, parse: () => T, uncertain = false): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof ChannexDataError) throw new ChannexMessageDataError(label, field, error.message, uncertain)
    throw error
  }
}

function fail(label: string, field: string, message: string, uncertain = false): never {
  throw new ChannexMessageDataError(label, field, message, uncertain)
}

/**
 * The Messages API documents timestamps without offsets, including microseconds.
 * Validate their actual calendar/time and retain the provider's precision and
 * timezone representation. A missing offset does not establish a UTC instant.
 */
export function providerTimestamp(value: unknown, label: string, field: string, uncertain = false): string {
  const timestamp = read(label, field, () => string(value, field), uncertain)
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/.exec(timestamp)
  if (!parts) fail(label, field, 'Expected an ISO date and time', uncertain)
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3])
  const hours = Number(parts[4]), minutes = Number(parts[5]), seconds = Number(parts[6])
  const date = new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day
    || hours > 23 || minutes > 59 || seconds > 59) fail(label, field, 'Invalid calendar date or time', uncertain)
  const offset = parts[7]
  if (offset && offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) {
    fail(label, field, 'Invalid timezone offset', uncertain)
  }
  return timestamp
}

function relation(row: Resource, key: string, optional = false, uncertain = false): string | null {
  const label = `${row.type}:${row.id}`
  return read(label, `relationships.${key}`, () => {
    const relationships = object(row.relationships, 'relationships')
    if (optional && relationships[key] === undefined) return null
    const link = object(relationships[key], key)
    if (optional && link.data === null) return null
    const data = object(link.data, `${key}.data`)
    if (data.type !== key) throw new ChannexDataError(`Expected a ${key} relationship`)
    return string(data.id, `${key}.id`)
  }, uncertain)
}

export function parseChannexThread(value: unknown): ChannexMessageThread {
  const row = read('message_thread', 'data', () => resource(value, 'message_thread'))
  const label = `message_thread:${row.id}`
  const attributes = row.attributes
  const provider = read(label, 'provider', () => string(attributes.provider, 'provider'))
  if (provider !== 'Airbnb' && provider !== 'AirBNB') fail(label, 'provider', 'This message provider has no verified Airbnb mapping')
  if (typeof attributes.is_closed !== 'boolean') fail(label, 'is_closed', 'Expected a boolean')
  const title = read(label, 'title', () => string(attributes.title, 'title'))
  if (!title.trim()) fail(label, 'title', 'Expected a non-blank conversation label')
  return {
    id: row.id,
    propertyId: relation(row, 'property')!,
    channelId: relation(row, 'channel', true),
    bookingId: relation(row, 'booking', true),
    title,
    provider,
    isClosed: attributes.is_closed,
    messageCount: read(label, 'message_count', () => integer(attributes.message_count, 'message_count')),
    insertedAt: providerTimestamp(attributes.inserted_at, label, 'inserted_at'),
    updatedAt: providerTimestamp(attributes.updated_at, label, 'updated_at'),
  }
}

function attachmentUrl(value: unknown, env: ChannexEnv, label: string, field: string, uncertain: boolean): string {
  const link = read(label, field, () => string(value, field), uncertain)
  if (link !== link.trim()) fail(label, field, 'Attachment link contains surrounding whitespace', uncertain)
  const base = env.CHANNEX_BASE_URL?.trim().replace(/\/$/, '')
  if (!base || !URL.canParse(base) || new URL(base).protocol !== 'https:') throw new ChannexError('CHANNEX_BASE_URL must be an absolute HTTPS API URL', 500, false)
  if (!URL.canParse(link, `${base}/`)) fail(label, field, 'Attachment link is not a valid URL', uncertain)
  const url = new URL(link, `${base}/`)
  if (url.protocol !== 'https:' || url.username || url.password) fail(label, field, 'Attachment link must use HTTPS without embedded credentials', uncertain)
  return url.href
}

export function parseChannexMessage(value: unknown, env: ChannexEnv, uncertain = false): ChannexMessage {
  const row = read('message', 'data', () => resource(value, 'message'), uncertain)
  const label = `message:${row.id}`
  const attributes = row.attributes
  if (!Array.isArray(attributes.attachments)) fail(label, 'attachments', 'Expected an attachment-link array', uncertain)
  const attachments = attributes.attachments.map((link, index) => attachmentUrl(link, env, label, `attachments[${index}]`, uncertain))
  const text = attributes.message
  if (text !== null && typeof text !== 'string') fail(label, 'message', 'Expected text or null for an attachment-only message', uncertain)
  if ((text === null || !text.trim()) && attachments.length === 0) fail(label, 'message', 'A message needs text or an attachment', uncertain)
  const sender = attributes.sender
  if (sender !== 'guest' && sender !== 'property' && sender !== 'system') fail(label, 'sender', 'Expected guest, property or system', uncertain)
  const meta = attributes.meta === undefined || attributes.meta === null
    ? attributes.meta
    : read(label, 'meta', () => object(attributes.meta, 'meta'), uncertain)
  return {
    id: row.id,
    threadId: relation(row, 'message_thread', false, uncertain)!,
    sender,
    text,
    attachments,
    insertedAt: providerTimestamp(attributes.inserted_at, label, 'inserted_at', uncertain),
    updatedAt: providerTimestamp(attributes.updated_at, label, 'updated_at', uncertain),
    ...(meta === undefined ? {} : { meta }),
  }
}

function distinct<T extends { id: string }>(rows: T[], label: string): T[] {
  const ids = new Set<string>()
  for (const row of rows) {
    if (ids.has(row.id)) fail(label, 'id', 'The collection contains a duplicate resource ID')
    ids.add(row.id)
  }
  return rows
}

/** Collections may be empty. Ordering is explicit rather than Channex's changing default. */
export async function listChannexThreads(env: ChannexEnv, propertyId: string): Promise<ChannexMessageThread[]> {
  const rows = await channexList(env, '/message_threads', 'message_thread', { 'filter[property_id]': propertyId, 'order[inserted_at]': 'asc' })
  return distinct(rows.map(row => {
    const thread = parseChannexThread(row)
    if (thread.propertyId !== propertyId) fail(`message_thread:${thread.id}`, 'relationships.property', 'Thread does not belong to the requested property')
    return thread
  }), 'message_threads')
}

export async function getChannexThread(env: ChannexEnv, id: string): Promise<ChannexMessageThread> {
  const thread = parseChannexThread(await channexGet(env, `/message_threads/${encodeURIComponent(id)}`, 'message_thread'))
  if (thread.id !== id) fail(`message_thread:${thread.id}`, 'id', 'Thread does not match the requested ID')
  return thread
}

export async function listChannexMessages(env: ChannexEnv, threadId: string): Promise<ChannexMessage[]> {
  const rows = await channexList(env, `/message_threads/${encodeURIComponent(threadId)}/messages`, 'message', { 'order[inserted_at]': 'asc' })
  return distinct(rows.map(row => {
    const message = parseChannexMessage(row, env)
    if (message.threadId !== threadId) fail(`message:${message.id}`, 'relationships.message_thread', 'Message does not belong to the requested thread')
    return message
  }), 'messages')
}

export async function sendChannexMessage(env: ChannexEnv, threadId: string, text: string): Promise<ChannexMessage> {
  if (!text.trim()) throw new ChannexError('A channel reply needs text', 400, false)
  const row = await channexCreate(env, `/message_threads/${encodeURIComponent(threadId)}/messages`, { message: { message: text } }, 'message')
  const message = parseChannexMessage(row, env, true)
  if (message.threadId !== threadId) fail(`message:${message.id}`, 'relationships.message_thread', 'Reply belongs to a different thread', true)
  if (message.sender !== 'property') fail(`message:${message.id}`, 'sender', 'Reply was not returned as a property message', true)
  if (message.text !== text) fail(`message:${message.id}`, 'message', 'Reply content does not match the submitted text', true)
  return message
}

function installation(row: Resource, uncertain = false): { id: string; propertyId: string; applicationCode: string } {
  const label = `application_installation:${row.id}`
  const id = read(label, 'id', () => string(row.attributes.id, 'id'), uncertain)
  if (id !== row.id) fail(label, 'id', 'Installation attribute ID differs from its resource ID', uncertain)
  return {
    id,
    propertyId: read(label, 'property_id', () => string(row.attributes.property_id, 'property_id'), uncertain),
    applicationCode: read(label, 'application_code', () => string(row.attributes.application_code, 'application_code'), uncertain),
  }
}

async function installedMessages(env: ChannexEnv, propertyId: string, uncertain = false): Promise<ChannexMessagesInstallation | null> {
  const rows = await channexList(env, '/applications/installed', 'application_installation')
  const matches = rows.map(row => installation(row, uncertain)).filter(row => row.propertyId === propertyId && row.applicationCode === 'channex_messages')
  if (matches.length > 1) fail('application_installation', 'property_id', 'Property has more than one Messages installation', uncertain)
  const found = matches[0]
  return found ? { id: found.id, propertyId: found.propertyId, applicationCode: 'channex_messages' } : null
}

/** Read first, install once if absent, and confirm the installation through the list endpoint. */
export async function installChannexMessages(env: ChannexEnv, propertyId: string): Promise<ChannexMessagesInstallation> {
  const existing = await installedMessages(env, propertyId)
  if (existing) return existing
  const row = await channexCreate(env, '/applications/install', { application_installation: { property_id: propertyId, application_code: 'channex_messages' } }, 'application_installation')
  const created = installation(row, true)
  if (created.propertyId !== propertyId) fail(`application_installation:${created.id}`, 'property_id', 'Installation belongs to a different property', true)
  if (created.applicationCode !== 'channex_messages') fail(`application_installation:${created.id}`, 'application_code', 'Installed application is not Messages', true)
  let verified: ChannexMessagesInstallation | null
  try {
    verified = await installedMessages(env, propertyId, true)
  } catch (error) {
    if (error instanceof ChannexMessageDataError) throw error
    if (error instanceof ChannexError) throw new ChannexError(`Channex accepted the Messages installation but its read-back failed: ${error.message}`, 502, true)
    throw error
  }
  if (!verified || verified.id !== created.id) fail(`application_installation:${created.id}`, 'id', 'The installed-list read did not confirm this Messages installation', true)
  return verified
}
