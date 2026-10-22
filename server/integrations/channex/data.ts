// Channex's JSON:API resources, read strictly: a field that is missing or the
// wrong shape is a provider error, never a default.

export class ChannexDataError extends Error {}

export type JsonRecord = Record<string, unknown>

export function object(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChannexDataError(`${label} must be an object`)
  return value as JsonRecord
}

export function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ChannexDataError(`${label} is required`)
  return value
}

export function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label)
}

export function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) throw new ChannexDataError(`${label} must be an integer of at least ${minimum}, got ${received(value)}`)
  return value
}

/** The value Channex actually sent, for error messages: JSON where it has one, otherwise its type. */
export function received(value: unknown): string {
  if (value === undefined) return 'nothing'
  const json = JSON.stringify(value)
  return json === undefined ? typeof value : json
}

export interface Resource {
  id: string
  type: string
  attributes: JsonRecord
  relationships: JsonRecord | undefined
}

export function resource(value: unknown, type: string): Resource {
  const row = object(value, type)
  if (row.type !== type) throw new ChannexDataError(`Expected a ${type} resource`)
  return {
    id: string(row.id, `${type}.id`),
    type,
    attributes: object(row.attributes, `${type}.attributes`),
    relationships: row.relationships === undefined ? undefined : object(row.relationships, `${type}.relationships`),
  }
}

export function relationship(row: Resource, key: string): string {
  return string(object(object(object(row.relationships, 'relationships')[key], key).data, `${key}.data`).id, `${key}.id`)
}
