import type { Validator } from './api-clients'

export type ApiShape =
  | 'array'
  | 'boolean'
  | 'number'
  | 'object'
  | 'string'
  | 'nullable-array'
  | 'nullable-number'
  | 'nullable-object'
  | 'nullable-string'
  | { readonly arrayOf: ApiShape }
  | { readonly [key: string]: ApiShape }

const isApiRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const matchesApiShape = (value: unknown, shape: ApiShape): boolean => {
  if (typeof shape === 'object') {
    if (Object.keys(shape).length === 1 && Object.hasOwn(shape, 'arrayOf')) {
      return Array.isArray(value)
        && value.every(item => matchesApiShape(item, shape.arrayOf))
    }
    return isApiRecord(value)
      && Object.entries(shape).every(([key, childShape]) =>
        Object.hasOwn(value, key) && matchesApiShape(value[key], childShape),
      )
  }
  if (shape === 'array') return Array.isArray(value)
  if (shape === 'boolean') return typeof value === 'boolean'
  if (shape === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (shape === 'object') return isApiRecord(value)
  if (shape === 'string') return typeof value === 'string'
  if (shape === 'nullable-array') return value === null || Array.isArray(value)
  if (shape === 'nullable-number') return value === null || (typeof value === 'number' && Number.isFinite(value))
  if (shape === 'nullable-object') return value === null || isApiRecord(value)
  if (shape === 'nullable-string') return value === null || typeof value === 'string'
  return false
}

export const validateApiShape = <T>(shape: ApiShape): Validator<T> =>
  (value: unknown): value is T => matchesApiShape(value, shape)

export const validateApiArrayItems = <T>(shape: ApiShape): Validator<T[]> =>
  (value: unknown): value is T[] =>
    Array.isArray(value) && value.every(item => matchesApiShape(item, shape))
