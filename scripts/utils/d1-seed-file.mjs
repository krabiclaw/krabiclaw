import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const DEFAULT_MAX_STATEMENT_BYTES = 80_000

function advanceSqlState(sql, index, state) {
  const char = sql[index]
  const next = sql[index + 1]

  if (state === 'single') {
    if (char === "'" && next === "'") return { state, index: index + 1 }
    return { state: char === "'" ? 'normal' : state, index }
  }
  if (state === 'double') {
    if (char === '"' && next === '"') return { state, index: index + 1 }
    return { state: char === '"' ? 'normal' : state, index }
  }
  if (state === 'backtick') return { state: char === '`' ? 'normal' : state, index }
  if (state === 'bracket') return { state: char === ']' ? 'normal' : state, index }
  if (state === 'line-comment') return { state: char === '\n' ? 'normal' : state, index }
  if (state === 'block-comment') {
    return char === '*' && next === '/'
      ? { state: 'normal', index: index + 1 }
      : { state, index }
  }

  if (char === "'") return { state: 'single', index }
  if (char === '"') return { state: 'double', index }
  if (char === '`') return { state: 'backtick', index }
  if (char === '[') return { state: 'bracket', index }
  if (char === '-' && next === '-') return { state: 'line-comment', index: index + 1 }
  if (char === '/' && next === '*') return { state: 'block-comment', index: index + 1 }
  return { state, index }
}

export function splitSqlStatements(sql) {
  const statements = []
  let start = 0
  let state = 'normal'

  for (let index = 0; index < sql.length; index += 1) {
    const priorState = state
    const advanced = advanceSqlState(sql, index, state)
    state = advanced.state
    index = advanced.index
    if (priorState === 'normal' && state === 'normal' && sql[index] === ';') {
      statements.push(sql.slice(start, index + 1))
      start = index + 1
    }
  }

  if (sql.slice(start).trim()) statements.push(sql.slice(start))
  return statements
}

function findValuesKeyword(statement) {
  let state = 'normal'
  let depth = 0

  for (let index = 0; index < statement.length; index += 1) {
    const priorState = state
    const advanced = advanceSqlState(statement, index, state)
    state = advanced.state
    index = advanced.index
    if (priorState !== 'normal' || state !== 'normal') continue

    if (statement[index] === '(') depth += 1
    else if (statement[index] === ')') depth -= 1
    else if (depth === 0 && statement.slice(index, index + 6).toUpperCase() === 'VALUES') {
      const before = statement[index - 1]
      const after = statement[index + 6]
      if (!/[A-Z0-9_]/i.test(before || '') && !/[A-Z0-9_]/i.test(after || '')) return index + 6
    }
  }

  return -1
}

function splitValueRows(valueSql) {
  const rows = []
  let start = 0
  let state = 'normal'
  let depth = 0

  for (let index = 0; index < valueSql.length; index += 1) {
    const priorState = state
    const advanced = advanceSqlState(valueSql, index, state)
    state = advanced.state
    index = advanced.index
    if (priorState !== 'normal' || state !== 'normal') continue

    if (valueSql[index] === '(') depth += 1
    else if (valueSql[index] === ')') depth -= 1
    else if (valueSql[index] === ',' && depth === 0) {
      rows.push(valueSql.slice(start, index).trim())
      start = index + 1
    }
  }

  rows.push(valueSql.slice(start).trim())
  return depth === 0 && rows.every(row => row.startsWith('(') && row.endsWith(')')) ? rows : null
}

function splitOversizedInsert(statement, maxStatementBytes) {
  const valuesEnd = findValuesKeyword(statement)
  if (valuesEnd === -1 || !/^\s*(?:--[^\n]*\s*)*INSERT\b/i.test(statement)) return null

  const prefix = statement.slice(0, valuesEnd).trim()
  const valueSql = statement.slice(valuesEnd).trim().replace(/;\s*$/, '')
  const rows = splitValueRows(valueSql)
  if (!rows || rows.length < 2) return null

  const chunks = []
  let chunkRows = []
  for (const row of rows) {
    const candidate = `${prefix}\n${[...chunkRows, row].join(',\n')};`
    if (Buffer.byteLength(candidate, 'utf8') <= maxStatementBytes) {
      chunkRows.push(row)
      continue
    }
    if (!chunkRows.length) throw new Error(`A single INSERT row exceeds the D1 statement limit (${maxStatementBytes} bytes).`)
    chunks.push(`${prefix}\n${chunkRows.join(',\n')};`)
    chunkRows = [row]
  }
  chunks.push(`${prefix}\n${chunkRows.join(',\n')};`)
  return chunks
}

export function normalizeD1SeedSql(sql, maxStatementBytes = DEFAULT_MAX_STATEMENT_BYTES) {
  const output = []
  let splitCount = 0

  for (const statement of splitSqlStatements(sql)) {
    if (Buffer.byteLength(statement, 'utf8') <= maxStatementBytes) {
      output.push(statement)
      continue
    }

    const chunks = splitOversizedInsert(statement, maxStatementBytes)
    if (!chunks) throw new Error(`D1 seed contains an unsupported statement over ${maxStatementBytes} bytes.`)
    output.push(...chunks)
    splitCount += chunks.length - 1
  }

  return {
    sql: output.join('\n'),
    splitCount,
    maxStatementBytes: Math.max(...output.map(statement => Buffer.byteLength(statement, 'utf8')), 0),
  }
}

export async function prepareD1SeedFile(seedPath, maxStatementBytes = DEFAULT_MAX_STATEMENT_BYTES) {
  const source = await readFile(seedPath, 'utf8')
  const normalized = normalizeD1SeedSql(source, maxStatementBytes)
  if (!normalized.splitCount) {
    return { ...normalized, path: seedPath, cleanup: async () => {} }
  }

  const directory = await mkdtemp(join(tmpdir(), 'blawby-d1-seed-'))
  const path = join(directory, basename(seedPath))
  await writeFile(path, normalized.sql, 'utf8')
  return {
    ...normalized,
    path,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
