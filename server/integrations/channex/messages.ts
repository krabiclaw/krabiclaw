import { Buffer } from 'node:buffer'
import { channexCreate, channexGet, channexList, channexRequest, ChannexError, type ChannexEnv } from './client'
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
  /**
   * Channex documents `guest` and `property`; it also sends `system` and
   * `agent`, the latter an Airbnb agent (meta.role "AGENT"), as read from a
   * live Airbnb thread on 2026-10-23. Neither is the guest or the host's team.
   */
  sender: 'guest' | 'property' | 'system' | 'agent'
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

/** A Messages resource Channex returned in a shape Blawby cannot read. */
export class ChannexMessageDataError extends ChannexError {
  constructor(resource: string, field: string, message: string) {
    super(`Channex returned invalid ${resource}.${field}: ${message}`, 502, { code: 'INVALID_PROVIDER_RESPONSE', resource, field })
  }
}

function read<T>(label: string, field: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof ChannexDataError) throw new ChannexMessageDataError(label, field, error.message)
    throw error
  }
}

function fail(label: string, field: string, message: string): never {
  throw new ChannexMessageDataError(label, field, message)
}

/**
 * The Messages API documents timestamps without offsets, including microseconds.
 * Validate their actual calendar/time and retain the provider's precision and
 * timezone representation. A missing offset does not establish a UTC instant.
 */
export function providerTimestamp(value: unknown, label: string, field: string): string {
  const timestamp = read(label, field, () => string(value, field))
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/.exec(timestamp)
  if (!parts) fail(label, field, 'Expected an ISO date and time')
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3])
  const hours = Number(parts[4]), minutes = Number(parts[5]), seconds = Number(parts[6])
  const date = new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day
    || hours > 23 || minutes > 59 || seconds > 59) fail(label, field, 'Invalid calendar date or time')
  const offset = parts[7]
  if (offset && offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) {
    fail(label, field, 'Invalid timezone offset')
  }
  return timestamp
}

function relation(row: Resource, key: string, optional = false): string | null {
  const label = `${row.type}:${row.id}`
  return read(label, `relationships.${key}`, () => {
    const relationships = object(row.relationships, 'relationships')
    if (optional && relationships[key] === undefined) return null
    const link = object(relationships[key], key)
    if (optional && link.data === null) return null
    const data = object(link.data, `${key}.data`)
    if (data.type !== key) throw new ChannexDataError(`Expected a ${key} relationship`)
    return string(data.id, `${key}.id`)
  })
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

function attachmentUrl(value: unknown, env: ChannexEnv, label: string, field: string): string {
  const link = read(label, field, () => string(value, field))
  if (link !== link.trim()) fail(label, field, 'Attachment link contains surrounding whitespace')
  const base = env.CHANNEX_BASE_URL?.trim().replace(/\/$/, '')
  if (!base || !URL.canParse(base) || new URL(base).protocol !== 'https:') throw new ChannexError('CHANNEX_BASE_URL must be an absolute HTTPS API URL', 500)
  if (!URL.canParse(link, `${base}/`)) fail(label, field, 'Attachment link is not a valid URL')
  const url = new URL(link, `${base}/`)
  if (url.protocol !== 'https:' || url.username || url.password) fail(label, field, 'Attachment link must use HTTPS without embedded credentials')
  return url.href
}

export function parseChannexMessage(value: unknown, env: ChannexEnv): ChannexMessage {
  const row = read('message', 'data', () => resource(value, 'message'))
  if (!row.id.trim()) fail('message', 'id', 'Expected a nonblank message ID')
  const label = `message:${row.id}`
  const attributes = row.attributes
  if (!Array.isArray(attributes.attachments)) fail(label, 'attachments', 'Expected an attachment-link array')
  const attachments = attributes.attachments.map((link, index) => attachmentUrl(link, env, label, `attachments[${index}]`))
  const text = attributes.message
  if (text !== null && typeof text !== 'string') fail(label, 'message', 'Expected text or null for an attachment-only message')
  // A message with neither words nor a file is real: Airbnb records some host
  // actions that way (message c2f68d4e, a host message of 2026-09-14 with
  // message null and no attachments). It is recorded, and the inbox shows nothing for it.
  const sender = attributes.sender
  if (sender !== 'guest' && sender !== 'property' && sender !== 'system' && sender !== 'agent') fail(label, 'sender', 'Expected guest, property, system or agent')
  const meta = attributes.meta === undefined || attributes.meta === null
    ? attributes.meta
    : read(label, 'meta', () => object(attributes.meta, 'meta'))
  return {
    id: row.id,
    threadId: relation(row, 'message_thread')!,
    sender,
    text,
    attachments,
    insertedAt: providerTimestamp(attributes.inserted_at, label, 'inserted_at'),
    updatedAt: providerTimestamp(attributes.updated_at, label, 'updated_at'),
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

/** Channex accepts one attachment instead of text: sending both silently discards the attachment. */
export async function sendChannexMessage(env: ChannexEnv, threadId: string, text: string, photo?: { bytes: Uint8Array<ArrayBuffer>; filename: string; contentType: string }): Promise<ChannexMessage> {
  if (photo ? Boolean(text.trim()) : !text.trim()) throw new ChannexError('A channel reply needs text or one photo sent separately', 400)
  let attachmentId: string | undefined
  if (photo) {
    const uploaded = await channexRequest(env, '/attachments', 'POST', { attachment: { file: Buffer.from(photo.bytes).toString('base64'), file_name: photo.filename, file_type: photo.contentType } })
    const attachment = read('attachment', 'data', () => object(uploaded.data, 'data'))
    if (attachment.type !== 'attachment') fail('attachment', 'type', 'Expected an attachment resource')
    attachmentId = read('attachment', 'id', () => string(attachment.id, 'id'))
  }
  const row = await channexCreate(env, `/message_threads/${encodeURIComponent(threadId)}/messages`, { message: attachmentId ? { attachment_id: attachmentId } : { message: text } }, 'message')
  const message = parseChannexMessage(row, env)
  if (message.threadId !== threadId) fail(`message:${message.id}`, 'relationships.message_thread', 'Reply belongs to a different thread')
  if (message.sender !== 'property') fail(`message:${message.id}`, 'sender', 'Reply was not returned as a property message')
  if (photo) {
    if (message.text?.trim() || message.attachments.length !== 1) fail(`message:${message.id}`, 'attachments', 'Reply does not contain the submitted photo without text')
  } else if (message.text !== text) fail(`message:${message.id}`, 'message', 'Reply content does not match the submitted text')
  return message
}

function installation(row: Resource): { id: string; propertyId: string; applicationCode: string } {
  const label = `application_installation:${row.id}`
  const id = read(label, 'id', () => string(row.attributes.id, 'id'))
  if (id !== row.id) fail(label, 'id', 'Installation attribute ID differs from its resource ID')
  return {
    id,
    propertyId: read(label, 'property_id', () => string(row.attributes.property_id, 'property_id')),
    applicationCode: read(label, 'application_code', () => string(row.attributes.application_code, 'application_code')),
  }
}

async function installedMessages(env: ChannexEnv, propertyId: string): Promise<ChannexMessagesInstallation | null> {
  const rows = await channexList(env, '/applications/installed', 'application_installation')
  const matches = rows.map(row => installation(row)).filter(row => row.propertyId === propertyId && row.applicationCode === 'channex_messages')
  if (matches.length > 1) fail('application_installation', 'property_id', 'Property has more than one Messages installation')
  const found = matches[0]
  return found ? { id: found.id, propertyId: found.propertyId, applicationCode: 'channex_messages' } : null
}

/** Remove the property's Messages installation, if any. */
export async function uninstallChannexMessages(env: ChannexEnv, propertyId: string): Promise<void> {
  const existing = await installedMessages(env, propertyId)
  if (!existing) return
  await channexRequest(env, `/applications/${encodeURIComponent(existing.id)}/uninstall`, 'DELETE')
}

/** Read first and install once if absent. */
export async function installChannexMessages(env: ChannexEnv, propertyId: string): Promise<ChannexMessagesInstallation> {
  const existing = await installedMessages(env, propertyId)
  if (existing) return existing
  const row = await channexCreate(env, '/applications/install', { application_installation: { property_id: propertyId, application_code: 'channex_messages' } }, 'application_installation')
  const created = installation(row)
  if (created.propertyId !== propertyId) fail(`application_installation:${created.id}`, 'property_id', 'Installation belongs to a different property')
  if (created.applicationCode !== 'channex_messages') fail(`application_installation:${created.id}`, 'application_code', 'Installed application is not Messages')
  return { id: created.id, propertyId: created.propertyId, applicationCode: 'channex_messages' }
}
