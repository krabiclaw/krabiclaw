import { HTTPError } from 'nitro'
import { execute, queryFirst, type DbClient } from '~/server/db'
import { stayHomeDraftInput, type StayHomeDraftInput } from '~/shared/stay-home-setup'
import { hydrateMediaAssetRefs } from '~/server/utils/media-asset-manager'
import { creationDedupeKey, creationRequestHash } from '~/server/utils/organization-events'

type Scope = { id: string; memberId: string }
type Draft = StayHomeDraftInput & { revision: string; finishHash?: string }

export const stayHomeDraftChanged = () => new HTTPError({ statusCode: 409, message: 'Your home setup changed. Reopen it to continue.', data: { code: 'STAY_HOME_DRAFT_CHANGED' } })

export async function readStayHomeSetupDraft(db: DbClient, organization: Scope) {
  const row = await queryFirst<{ payload_json: string; revision: string }>(db, 'SELECT payload_json, revision FROM stay_home_setup_drafts WHERE organization_id = ? AND member_id = ?', [organization.id, organization.memberId])
  if (!row) return null
  const payload = JSON.parse(row.payload_json)
  return { ...stayHomeDraftInput.parse(payload), revision: row.revision, finishHash: typeof payload.finishHash === 'string' ? payload.finishHash : undefined }
}

export async function stayHomeDraftPhotos(db: DbClient, organizationId: string, ids: string[]) {
  const assets = await hydrateMediaAssetRefs(db, { organizationId, refs: ids.map(asset_id => ({ asset_id })), allowedKinds: ['image'], fieldName: 'photos' })
  return assets.map(({ asset_id, public_url }) => ({ asset_id, public_url }))
}

export async function writeStayHomeSetupDraft(db: DbClient, organization: Scope, input: StayHomeDraftInput, current: Draft | null, finish = false) {
  const finishHash = finish ? await creationRequestHash({ ...input, amenities: [...input.amenities].sort() }) : undefined
  if (current?.finishHash) {
    if (finishHash === current.finishHash) return current.revision
    throw stayHomeDraftChanged()
  }
  const revision = finish && current ? current.revision : crypto.randomUUID()
  const payload = JSON.stringify({ ...input, finishHash })
  const result = current
    ? await execute(db, `UPDATE stay_home_setup_drafts SET payload_json = ?, revision = ?
        WHERE organization_id = ? AND member_id = ? AND revision = ? AND json_type(payload_json, '$.finishHash') IS NULL`,
      [payload, revision, organization.id, organization.memberId, current.revision])
    : await execute(db, `INSERT INTO stay_home_setup_drafts (payload_json, revision, organization_id, member_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(organization_id, member_id) DO NOTHING`, [payload, revision, organization.id, organization.memberId])
  if (result.meta.changes !== 1) throw stayHomeDraftChanged()
  return revision
}

export async function clearStayHomeSetupDraft(db: DbClient, organization: Scope, revision: string) {
  await execute(db, 'DELETE FROM stay_home_setup_drafts WHERE organization_id = ? AND member_id = ? AND revision = ?', [organization.id, organization.memberId, revision])
}

export async function reopenUncommittedStayHomeSetupDraft(db: DbClient, organization: Scope, revision: string, idempotencyKey: string) {
  await execute(db, `UPDATE stay_home_setup_drafts SET payload_json = json_remove(payload_json, '$.finishHash')
    WHERE organization_id = ? AND member_id = ? AND revision = ?
      AND NOT EXISTS (SELECT 1 FROM activity_entries WHERE dedupe_key IN (?, ?))`, [organization.id, organization.memberId, revision,
    creationDedupeKey('location', organization.id, idempotencyKey), creationDedupeKey('product', organization.id, idempotencyKey)])
}
