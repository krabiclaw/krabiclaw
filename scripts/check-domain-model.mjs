#!/usr/bin/env node
//
//   node scripts/check-domain-model.mjs
//
// docs/domain-model.md names the one model of every concept. This fails when
// the schema or the server code has grown a second one.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const doc = readFileSync(join(root, 'docs/domain-model.md'), 'utf8')
const schema = readFileSync(join(root, 'server/db/schema.ts'), 'utf8')

/** The rows of the markdown table under a heading, as arrays of cells. */
function section(heading) {
  const start = doc.indexOf(`\n## ${heading}\n`)
  if (start < 0) throw new Error(`docs/domain-model.md has no "${heading}" section`)
  const end = doc.indexOf('\n## ', start + 1)
  return doc.slice(start, end < 0 ? undefined : end).split('\n')
    .filter(line => line.startsWith('|') && !/^\|[-| ]+\|$/.test(line))
    .slice(1)
    .map(line => line.slice(1, -1).split('|').map(cell => cell.trim()))
}
const names = cell => [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1])

// Every table and its columns, from the Drizzle definitions.
const tables = new Map()
const definition = /sqliteTable\(\s*['"]([A-Za-z_]+)['"]\s*,\s*\{/g
for (let match; (match = definition.exec(schema));) {
  let depth = 1, index = definition.lastIndex
  while (depth > 0 && index < schema.length) {
    if (schema[index] === '{') depth++
    else if (schema[index] === '}') depth--
    index++
  }
  const body = schema.slice(definition.lastIndex, index - 1)
  const columns = [...body.matchAll(/^\s*([A-Za-z_]+)\s*:\s*(?:text|integer|real|blob)\(/gm)].map(column => column[1])
  tables.set(match[1], columns)
}
if (tables.size === 0) throw new Error('No sqliteTable definitions were read from server/db/schema.ts')

const failures = []
const concepts = section('Concepts')
const conceptOf = new Map()
for (const [concept, cell, module] of concepts) {
  for (const table of names(cell)) {
    if (conceptOf.has(table)) failures.push(`${table} is listed under "${conceptOf.get(table)}" and "${concept}"`)
    conceptOf.set(table, concept)
  }
  const path = module.replace(/`/g, '')
  if (path.startsWith('server/') || path.startsWith('shared/') || path.startsWith('utils/')) {
    if (!existsSync(join(root, path)) && !existsSync(join(root, `${path}.ts`))) failures.push(`"${concept}" names module ${path}, which does not exist`)
  }
}
const retiring = new Map(section('Retiring').flatMap(([cell, concept]) => names(cell).map(table => [table, concept])))
for (const table of tables.keys()) {
  if (retiring.has(table)) failures.push(`${table} is a second model of "${retiring.get(table)}" and must be removed`)
  else if (!conceptOf.has(table)) failures.push(`${table} is in server/db/schema.ts but names no concept in docs/domain-model.md`)
}
for (const table of conceptOf.keys()) if (!tables.has(table)) failures.push(`docs/domain-model.md lists ${table}, which is not in server/db/schema.ts`)

for (const [cell, owners] of section('Single-owner columns')) {
  const [column] = names(cell)
  const allowed = new Set(names(owners))
  for (const [table, columns] of tables) {
    if (columns.includes(column) && !allowed.has(table)) failures.push(`${table}.${column}: ${column} belongs to ${allowed.size ? [...allowed].join(', ') : 'no table'} only`)
  }
}

// A read-time union of two tables of one concept is a second model of it.
function* sources(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) yield* sources(path)
    else if (/\.(ts|mjs|js|vue)$/.test(name)) yield path
  }
}
for (const path of sources(join(root, 'server'))) {
  const text = readFileSync(path, 'utf8')
  for (const statement of text.split(/`/).filter(part => /UNION ALL/i.test(part))) {
    // The table each branch reads first is what the branch is a row of.
    const read = statement.split(/UNION ALL/i).map(branch => branch.match(/\bFROM\s+([A-Za-z_]+)/i)?.[1]).filter(table => table && tables.has(table))
    const byConcept = new Map()
    for (const table of read) {
      const concept = conceptOf.get(table) ?? retiring.get(table)
      if (concept) byConcept.set(concept, new Set([...(byConcept.get(concept) ?? []), table]))
    }
    for (const [concept, set] of byConcept) {
      if (set.size > 1) failures.push(`${path.slice(root.length + 1)} unions ${[...set].join(', ')}, which are one concept ("${concept}")`)
    }
  }
}

if (failures.length) {
  console.error(`Domain model check failed (${failures.length}):\n${[...new Set(failures)].map(line => `- ${line}`).join('\n')}`)
  process.exit(1)
}
console.log(`Domain model: ${tables.size} tables, one model per concept.`)
