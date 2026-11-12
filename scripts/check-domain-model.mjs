#!/usr/bin/env node
//
//   node scripts/check-domain-model.mjs
//
// docs/domain-model.md names the one model of every concept. This fails when
// the schema or the server code has grown a second one.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

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
for (const table of tables.keys()) {
  if (!conceptOf.has(table)) failures.push(`${table} is in server/db/schema.ts but names no concept in docs/domain-model.md`)
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
      const concept = conceptOf.get(table)
      if (concept) byConcept.set(concept, new Set([...(byConcept.get(concept) ?? []), table]))
    }
    for (const [concept, set] of byConcept) {
      if (set.size > 1) failures.push(`${path.slice(root.length + 1)} unions ${[...set].join(', ')}, which are one concept ("${concept}")`)
    }
  }
}

// MCP schemas expose the wire keys without confusing them with local names or
// JSON Schema keywords. Keep the names supplied by Better Auth and Google.
const googleAddressKeys = new Set(['addressLines', 'administrativeArea', 'languageCode', 'postalCode', 'regionCode'])
const betterAuthKeys = new Map([
  ['cancel_organization_invitation', ['expiresAt']],
  ['invite_organization_member', ['expiresAt']],
  ['list_organization_members', ['expiresAt', 'createdAt', 'organizationId', 'userId']],
  ['remove_organization_member', ['createdAt', 'organizationId', 'userId']],
  ['update_organization_member_role', ['createdAt', 'organizationId', 'userId']],
])
const googleReportKeys = new Map([
  ['get_google_ads_campaign', ['adGroups', 'budgetAmountMicros', 'budgetId', 'channelType', 'costMicros', 'finalUrls', 'matchType']],
  ['list_google_ads_campaigns', ['budgetAmountMicros', 'budgetId', 'channelType', 'costMicros']],
  ['query_google_ads_report', ['adGroupId', 'campaignId', 'campaignName', 'conversionsValue', 'costMicros']],
])
const snakeCase = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const retiredWireKeys = new Set(['expected_updated_at', 'product_updated_at', 'expected_version', 'operational_booking_id', 'operational_id', 'assigned_team_id'])
function checkMcpSchema(tool, schema, keys) {
  if (!schema || typeof schema !== 'object') return
  for (const key of Object.keys(schema.properties ?? {})) {
    if ((!snakeCase.test(key) && !keys.has(key)) || retiredWireKeys.has(key)) failures.push(`MCP ${tool}: ${key} must use its canonical column or snake_case name`)
  }
  for (const value of Object.values(schema)) checkMcpSchema(tool, value, keys)
}
const catalog = JSON.parse(readFileSync(join(root, 'server/utils/mcp-catalog-snapshots/tenant.json'), 'utf8'))
for (const tool of catalog.tools) {
  const keys = new Set([...googleAddressKeys, ...(betterAuthKeys.get(tool.name) ?? []), ...(googleReportKeys.get(tool.name) ?? [])])
  checkMcpSchema(tool.name, tool.inputSchema, keys)
  checkMcpSchema(tool.name, tool.outputSchema, keys)
}

// File-based route parameters are part of the web and server route contract.
for (const directory of ['pages', 'server/api']) {
  for (const path of sources(join(root, directory))) {
    const route = path.slice(root.length + 1)
    for (const [, key] of route.matchAll(/\[(?:\.\.\.)?([A-Za-z][A-Za-z0-9_]*)\]/g)) {
      if (!snakeCase.test(key) || retiredWireKeys.has(key)) failures.push(`${route}: route parameter ${key} must use its canonical column or snake_case name`)
    }
  }
}

// Literal request schemas, inline response envelopes and direct query reads
// expose wire keys without including local variables or nested provider data.
for (const path of sources(join(root, 'server/api'))) {
  const route = path.slice(root.length + 1)
  const file = ts.createSourceFile(route, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest)
  const appRoute = /^server\/api\/(account|analytics|billing|dashboard|editor|invite-links|organizations|public)\b/.test(route)
  const checkKey = key => {
    if (!snakeCase.test(key) || retiredWireKeys.has(key)) {
      failures.push(`${route}: ${key} must use its canonical column or snake_case name`)
    }
  }
  const checkProperties = properties => {
    for (const { name } of properties) {
      if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) checkKey(name.text)
    }
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      const literal = name === 'readStrictBody' ? node.arguments[1] : appRoute && name === 'jsonResponse' ? node.arguments[0] : undefined
      if (literal && ts.isObjectLiteralExpression(literal)) checkProperties(literal.properties)
      const bodyType = node.typeArguments?.[0]
      if (appRoute && (name === 'readBody' || name === 'readRequiredBody') && bodyType && ts.isTypeLiteralNode(bodyType)) checkProperties(bodyType.members)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)

  if (/^server\/api\/(dashboard|editor|billing)\//.test(route)) {
    const queryVariables = new Set()
    function findQueryVariables(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
        && node.initializer.expression.text === 'getQuery') queryVariables.add(node.name.text)
      ts.forEachChild(node, findQueryVariables)
    }
    function checkQueryReads(node) {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
        && queryVariables.has(node.expression.text) && node.name.text !== 'organizationId') checkKey(node.name.text)
      ts.forEachChild(node, checkQueryReads)
    }
    findQueryVariables(file)
    if (queryVariables.size) checkQueryReads(file)
  }
}

if (failures.length) {
  console.error(`Domain model check failed (${failures.length}):\n${[...new Set(failures)].map(line => `- ${line}`).join('\n')}`)
  process.exit(1)
}
console.log(`Domain model: ${tables.size} tables, one model per concept.`)
