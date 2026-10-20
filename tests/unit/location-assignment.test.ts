import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assignedLocationSql, assignedGuestThreadScope } from '../../server/utils/member-access.ts'
import { organizationRoles } from '../../utils/organization-access.ts'

test('assignedLocationSql scopes to assigned member or team member', () => {
  const sql = assignedLocationSql('loc')
  assert.match(sql, /EXISTS \(SELECT 1 FROM member m WHERE m\.id = loc\.assigned_member_id AND m\.organizationId = loc\.organization_id AND m\.userId = \?\)/)
  assert.match(sql, /EXISTS \(SELECT 1 FROM team t JOIN teamMember tm ON tm\.teamId = t\.id/)
  assert.match(sql, /WHERE t\.id = loc\.assigned_team_id AND t\.organizationId = loc\.organization_id AND m\.userId = \?\)/)
})

test('assignedGuestThreadScope admits threads routed to assigned locations or reservations', () => {
  const scope = assignedGuestThreadScope('thread', 'user-456')
  assert.equal(scope.params.length, 9)
  assert.deepEqual(scope.params, Array(9).fill('user-456'))

  // Matches thread's direct location_id (e.g. contact request to a branch)
  assert.match(scope.sql, /thread\.location_id IS NOT NULL AND EXISTS \(SELECT 1 FROM business_locations bl\s+WHERE bl\.id = thread\.location_id/)
  // Matches table reservations at a location (e.g. Kikuzuki branch reservations)
  assert.match(scope.sql, /EXISTS \(SELECT 1 FROM reservations res JOIN business_locations bl ON bl\.id = res\.location_id/)
})

test('organizationRoles scopes location permissions canonically', () => {
  // Member role has assigned location access, but not unrestricted location updates
  assert.equal(organizationRoles.member.authorize({ locations: ['assigned'] }).success, true)
  assert.equal(organizationRoles.member.authorize({ locations: ['update'] }).success, false)
  assert.equal(organizationRoles.member.authorize({ locations: ['delete'] }).success, false)
  assert.equal(organizationRoles.member.authorize({ locations: ['create'] }).success, false)

  // Admin and Owner roles have full location management access
  assert.equal(organizationRoles.admin.authorize({ locations: ['update'] }).success, true)
  assert.equal(organizationRoles.admin.authorize({ locations: ['create'] }).success, true)
  assert.equal(organizationRoles.owner.authorize({ locations: ['update'] }).success, true)
  assert.equal(organizationRoles.owner.authorize({ locations: ['delete'] }).success, true)
})
