import assert from 'node:assert/strict'
import { test } from 'node:test'
import { organizationRoles } from '../../utils/organization-access.ts'

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
