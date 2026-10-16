# Media Workflow Contract

**Status: Contract**

This document defines the canonical media workflow every surface shares.

There is one authority and it is not a route family: `media_assets` is the
record, `media-asset-manager.ts` and `media-upload.ts` are the operations, and
`shared/media-placement-contract.ts` says how a record is read and where it can
be placed. MCP, the dashboard, the guest review form and onboarding are
adapters over those — transport and auth only. This document used to name the
dashboard's route family canonical in one section and MCP's `save_media_attachment`
the only upload path in another, which is how four upload lifecycles came to
exist at once.

## Scope

Media is intentionally **workflow-based**, not CRUD-shaped.

The canonical route family is under:

- `GET /api/editor/organizations/[organizationId]/media`
- `POST /api/editor/organizations/[organizationId]/media/upload`
- `PATCH /api/editor/organizations/[organizationId]/media/[assetId]`
- `DELETE /api/editor/organizations/[organizationId]/media/[assetId]`

## Canonical lifecycle

1. upload
   One request carries the bytes and answers with an active asset. An image is
   an `image` part; a video is a `video` part with its required `thumbnail`
   poster. Every surface routes this through `uploadResolvedMediaToAssetStore`,
   which chooses the provider, writes the row and resolves the URLs.

   There is no pending state and no confirm step. Images used to take a
   request-upload / direct-to-provider / confirm round trip, which left a
   pending row behind whenever a step failed and gave the same file different
   storage semantics depending on which surface uploaded it.

2. metadata update
   Alt text and category edits happen through `PATCH`. Content ownership is
   never stored on the asset; assignment always uses a placement.

3. placement
   An active asset is assigned to content through media placements.

4. delete
   Deletion is a workflow action on the asset record and storage object, not a
   table-row-only concern.

## Reading a media record

`media_assets.kind` is the authority on what a record is. A video carries its
file in `public_url` and a required poster in `thumbnail_url`; an image carries
itself in `public_url`.

Every surface reads a record through `mediaStillUrl` and `mediaPlaybackUrl` in
`shared/media-placement-contract.ts`.

- A still is the image itself, or a video's poster. Never a video file.
- A record whose `kind` is missing or unrecognised has no still. Do not treat an
  absent kind as an image, and do not read the kind back off the URL's
  extension — a booking email shipped an `.mp4` inside an `<img>` because one
  resolver returned `public_url` without looking at `kind`, and eight others
  compensated with fallbacks that hid the disagreement instead of ending it.

## Limits and accepted types

`server/utils/media-mime.ts` is the only place that answers what a file may be
and how large. A surface that wants a different number states it in
`config/media-limits.ts` as a named product rule, the way guest review video
does.

## Product rules

- Do not invent a separate `create media` MCP tool that bypasses the canonical Cloudflare upload and media-asset manager paths.
- Do not treat pending assets as usable by public-site workflows.
- AI-generated images still end as normal media assets and must be visible through the canonical media listing surface.
- AI-generated image briefs should first resolve and review `image.generate` Agent Skill guidance through the relevant MCP surface. The review is advisory; the file transport and media persistence rules below remain enforced by tool contracts.
- `save_media_attachment({ organization_id, file, poster_file?, category, description })` saves any file from the conversation, an attached or a generated image included. It is the ChatGPT attachment adapter over the canonical upload. It is not a second lifecycle, and it cannot serve a browser file picker — the dashboard's `POST .../media/upload` is the adapter for that. Pass the resolved native ChatGPT file argument; the content type is detected from the file bytes.
- One `save_media_attachment` call performs one download attempt. If ChatGPT attachment delivery fails, stop and ask the user to attach the file again. Do not retry with a bare file ID, fabricate a download URL, or switch transports.
- ChatGPT MCP uploads use native file attachments. There are no upload widget tools in the connector; no tool whose name starts with `open_` and contains `upload` exists.
- Do not bypass the ChatGPT file-argument rewrite by fabricating `download_url` objects or inventing attachment transport.
- Prefer business-level image workflows over generic file handoff when the user intent is domain-specific:
  - Generate into KrabiClaw first, persist to Cloudflare Images immediately, then assign by `assetId`
  - Assignment happens through the canonical placement tools with a `{ owner_type, owner_id, slot }` placement: `set_media` for a single-valued slot (at most one asset — a cover, hero, logo, or a menu section's `collection`/`image` photo), or `attach_media`/`remove_media`/`reorder_media` for an ordered collection (a gallery or a compliance document list). Never resubmit a placement's full asset list to change one item — targeted attach/remove/reorder is required so a stale read can never resurrect an asset someone else removed.
  - Tenant-page media belongs to content-block placements. Block JSON never stores asset IDs or delivery URLs.
- MCP tools should be coarse-grained and business-level:
  - `get_organization_media_assets`
  - `save_media_attachment`
  - `update_media_asset`
  - `delete_media_asset`

## Auth boundary

- Editor-facing media routes are site-scoped and require authenticated site membership.
- Destructive actions stay confirm-gated in conversational surfaces.
- Every adapter preserves the same site scoping and entitlement checks.
