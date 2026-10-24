import { errorChainForTelemetry } from "~/shared/error-telemetry";
import { HTTPError } from 'nitro';
import type { H3Event } from 'nitro';
import { queryFirst } from "~/server/db";
import { isIP } from "node:net";
import { getMediaAsset } from "~/server/utils/media-asset-manager";
import type { getMcpTool } from "~/server/utils/mcp-tools";
import { requireMcpUser, type McpOrganizationContext, type McpUserContext } from "~/server/utils/mcp-auth";
import { mcpProtocolError, MCP_ERROR } from "~/server/utils/mcp-protocol";
import {
  resolveMcpWorkspace,
  type McpLocationSummary,
  type McpOrganizationSummary,
} from "~/server/utils/mcp-context";
import { sniffMediaMimeType, VIDEO_MIME_TYPES, MAX_VIDEO_BYTES, MAX_IMAGE_BYTES, RESOLVED_MEDIA_IMAGE_TYPES } from "~/server/utils/media-mime";
import { assertMarkdownSize, decodeMarkdownText, resolveMarkdownMimeType } from "~/server/utils/markdown-document";
import { findOrganizationById } from '~/server/utils/member-access'
import { publicTenantVisibilitySql } from '~/server/utils/public-base'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'

export async function requireActiveImageAsset(
  db: D1Database,
  organizationId: string,
  assetId: string,
  fieldName: string,
) {
  const asset = await getMediaAsset(db, assetId, organizationId);
  if (!asset || asset.status !== "active" || asset.kind !== "image") {
    throw mcpProtocolError(
      MCP_ERROR.invalidParams,
      `${fieldName} must reference an active image asset from this organization.`,
    );
  }
  return asset;
}

export async function requireActiveVideoAsset(
  db: D1Database,
  organizationId: string,
  assetId: string,
  fieldName: string,
) {
  const asset = await getMediaAsset(db, assetId, organizationId);
  if (!asset || asset.status !== "active" || asset.kind !== "video") {
    throw mcpProtocolError(
      MCP_ERROR.invalidParams,
      `${fieldName} must reference an active video asset from this organization. Upload the video via the dashboard media library first, then call list_media_assets to find its asset id.`,
    );
  }
  return asset;
}

export interface ToolFileReference {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

function filenameExtension(contentType: string, fallback = "bin"): string {
  switch (contentType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    case "image/svg+xml":
      return "svg";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    case "video/x-msvideo":
      return "avi";
    case "text/markdown":
      return "md";
    default:
      return fallback;
  }
}

function safeAttachmentFilename(file: Pick<ToolFileReference, "file_id" | "file_name">, contentType: string): string {
  const fallbackBase = file.file_id
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^\/+/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "attachment";
  const rawName = file.file_name?.trim() || "";
  const candidate = rawName && !rawName.includes("/") && !rawName.includes("\\") && !rawName.includes("..")
    ? rawName
    : `${fallbackBase}.${filenameExtension(contentType)}`;
  return candidate.replace(/[^a-zA-Z0-9._ -]+/g, "-").slice(0, 160);
}

export function toolFileReference(value: unknown, key: string): ToolFileReference {
  if (typeof value === "string" && value.trim()) {
    throw mcpProtocolError(
      MCP_ERROR.invalidParams,
      `${key} must be sent as a ChatGPT file argument so the host rewrites the local path into an authorized file reference before KrabiClaw receives it.`,
    );
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `Invalid ${key}`);
  }

  const record = value as Record<string, unknown>;
  const downloadUrl = record.download_url;
  const fileId = record.file_id;
  if (typeof downloadUrl !== "string" || !downloadUrl.trim()) {
    throw mcpProtocolError(
      MCP_ERROR.invalidParams,
      `Invalid ${key}.download_url`,
    );
  }
  if (typeof fileId !== "string" || !fileId.trim()) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `Invalid ${key}.file_id`);
  }

  return {
    download_url: downloadUrl.trim(),
    file_id: fileId.trim(),
    mime_type:
      typeof record.mime_type === "string" && record.mime_type.trim()
        ? record.mime_type.trim()
        : undefined,
    file_name:
      typeof record.file_name === "string" && record.file_name.trim()
        ? record.file_name.trim()
        : undefined,
  };
}

const MAX_ATTACHMENT_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Redirects are followed by hand so every hop passes the same address checks
// as the URL the client supplied; fetch's own following would skip them.
async function fetchToolFile(file: ToolFileReference): Promise<Response> {
  const label = `Attachment ${file.file_id}`;
  let url = assertSafeDownloadUrl(file.download_url, label);
  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown network error";
      throw mcpProtocolError(
        MCP_ERROR.invalidParams,
        `Failed to download attachment ${file.file_id}: ${reason}`,
      );
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) {
      throw mcpProtocolError(
        MCP_ERROR.invalidParams,
        `Failed to download attachment ${file.file_id}: ${response.status} without a Location header`,
      );
    }
    if (redirects >= MAX_ATTACHMENT_REDIRECTS) {
      throw mcpProtocolError(
        MCP_ERROR.invalidParams,
        `Failed to download attachment ${file.file_id}: more than ${MAX_ATTACHMENT_REDIRECTS} redirects`,
      );
    }
    url = assertSafeDownloadUrl(new URL(location, url).toString(), `${label} redirect`);
  }
}

export interface ResolvedMediaFile {
  buffer: Uint8Array<ArrayBuffer>;
  contentType: string;
  filename: string;
  kind: "image" | "video" | "file";
}


async function readMediaBufferWithLimit(
  response: Response,
  label: string,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength === null
    ? null
    : /^\d+$/.test(contentLength) ? Number(contentLength) : Number.NaN;
  if (declaredLength !== null && !Number.isSafeInteger(declaredLength)) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `${label} has an invalid content-length header.`);
  }
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `${label} exceeds the ${maxBytes} byte limit.`);
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw mcpProtocolError(MCP_ERROR.invalidParams, `${label} exceeds the ${maxBytes} byte limit.`);
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const resizable = declaredLength === null;
  const initialCapacity = resizable ? Math.min(64 * 1024, maxBytes) : declaredLength;
  const buffer = resizable
    ? new ArrayBuffer(initialCapacity, { maxByteLength: maxBytes })
    : new ArrayBuffer(initialCapacity);
  let bytes = new Uint8Array(buffer);
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel();
        throw mcpProtocolError(MCP_ERROR.invalidParams, `${label} exceeds the ${maxBytes} byte limit.`);
      }
      const requiredCapacity = total + value.byteLength;
      if (!resizable && requiredCapacity > buffer.byteLength) {
        await reader.cancel();
        throw mcpProtocolError(MCP_ERROR.invalidParams, `${label} exceeded its content-length header.`);
      }
      if (resizable && requiredCapacity > buffer.byteLength) {
        buffer.resize(Math.min(maxBytes, Math.max(requiredCapacity, buffer.byteLength * 2)));
        bytes = new Uint8Array(buffer);
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== null && total !== declaredLength) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `${label} length did not match its content-length header.`);
  }
  if (resizable && buffer.byteLength !== total) buffer.resize(total);
  return new Uint8Array(buffer);
}

/** Resolve a ChatGPT file reference and verify its type from its bytes. */
export async function resolveUserUploadedMediaFile(
  file: ToolFileReference,
  maxBytes = MAX_VIDEO_BYTES,
): Promise<ResolvedMediaFile> {
  const startedAt = Date.now();
  let stage = 'attachment_download';
  let byteLength: number | undefined;
  let status = 'success';
  try {
    const response = await fetchToolFile(file);
    if (!response.ok) {
      throw new HTTPError({
        statusCode: 400,
        statusMessage: `Failed to download attachment ${file.file_id}: ${response.status}`,
      });
    }

    stage = 'attachment_read';
    const buffer = await readMediaBufferWithLimit(
      response,
      `Attachment ${file.file_id}`,
      maxBytes,
    );
    byteLength = buffer.byteLength;
    stage = 'attachment_validate';
    const bytes = buffer;
    const markdownType = resolveMarkdownMimeType(file.mime_type, file.file_name);
    if (markdownType) {
      assertMarkdownSize(bytes.byteLength);
      decodeMarkdownText(buffer);
      return {
        buffer,
        contentType: markdownType,
        filename: safeAttachmentFilename(file, markdownType),
        kind: "file",
      };
    }
    if (bytes.byteLength < 64) {
      throw new HTTPError({
        statusCode: 400,
        statusMessage: `Invalid media payload from attachment ${file.file_id}: payload too small.`,
      });
    }

    const sniffedContentType = sniffMediaMimeType(bytes);
    const isVideo = VIDEO_MIME_TYPES.has(sniffedContentType);
    const isImage = RESOLVED_MEDIA_IMAGE_TYPES.has(sniffedContentType);
    if (!isVideo && !isImage) {
      throw mcpProtocolError(
        MCP_ERROR.invalidParams,
        `Attachment ${file.file_id} is not a supported image or video type.`,
      );
    }
    if (isImage && bytes.byteLength > Math.min(MAX_IMAGE_BYTES, maxBytes)) {
      throw new HTTPError({
        statusCode: 413,
        statusMessage: `Invalid image payload from attachment ${file.file_id}: payload exceeds ${MAX_IMAGE_BYTES} byte limit.`,
      });
    }

    const filename = safeAttachmentFilename(file, sniffedContentType);
    return { buffer, contentType: sniffedContentType, filename, kind: isVideo ? "video" : "image" };
  } catch (error) {
    status = 'error';
    console.error({ event: 'media_attachment_failed', stage,
      duration_ms: Date.now() - startedAt, errors: errorChainForTelemetry(error) });
    throw error;
  } finally {
    console.info({ event: 'media_attachment_completed', status, stage,
      bytes: byteLength, duration_ms: Date.now() - startedAt });
  }
}

export function workspaceContextPayload(
  organization: Awaited<ReturnType<typeof resolveMcpWorkspace>>["organization"],
  location: McpLocationSummary | null,
) {
  return {
    organization_id: organization?.id ?? null,
    organization_name: organization?.name ?? null,
    organization_slug: organization?.slug ?? null,
    organization_subdomain: organization?.subdomain ?? null,
    organization_public_url: resolveOrganizationPublicOrigin(organization),
    location_id: location?.id ?? null,
    location_slug: location?.slug ?? null,
    location_title: location?.title ?? null,
  };
}

function normalizeAbsoluteUrl(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed.replace(/\/$/, "");
}

export function resolveOrganizationPublicOrigin(
  organization: Pick<McpOrganizationSummary, 'public_url'> | { publicUrl?: string | null } | null | undefined,
): string | null {
  if (!organization) return null
  return normalizeAbsoluteUrl('public_url' in organization ? organization.public_url : organization.publicUrl)
}

export function absolutizeOrganizationUrl(
  organization: Parameters<typeof resolveOrganizationPublicOrigin>[0],
  value: string | null | undefined,
): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const origin = resolveOrganizationPublicOrigin(organization);
  if (!origin) return null;

  if (trimmed.startsWith("/")) return `${origin}${trimmed}`;
  return `${origin}/${trimmed.replace(/^\/+/, "")}`;
}

export function attachViewUrlToRecord<T extends object>(
  record: T,
  organization: Parameters<typeof resolveOrganizationPublicOrigin>[0],
  options: {
    publicPath?: string | null;
  } = {},
): T & { public_path?: string | null; public_url: string | null; view_url: string | null } {
  const recordShape = record as Record<string, unknown>;
  const explicitPublicPath =
    options.publicPath !== undefined
      ? options.publicPath
      : (typeof recordShape.public_path === "string" ? recordShape.public_path : null);
  const canonicalUrl =
    typeof recordShape.canonical_url === "string" ? recordShape.canonical_url : null;
  const existingPublicUrl =
    typeof recordShape.public_url === "string" ? recordShape.public_url : null;
  const viewUrl =
    canonicalUrl && /^https?:\/\//i.test(canonicalUrl)
      ? canonicalUrl
      : absolutizeOrganizationUrl(organization, explicitPublicPath ?? existingPublicUrl);

  return {
    ...record,
    ...(options.publicPath !== undefined ? { public_path: explicitPublicPath } : {}),
    public_url: viewUrl,
    view_url: viewUrl,
  };
}

export function workspaceOrganizationsPayload(
  workspace: Awaited<ReturnType<typeof resolveMcpWorkspace>>,
) {
  return workspace.organizations.map((organization) => ({
    ...organization,
    active: organization.id === workspace.organization?.id,
  }));
}

export function workspaceLocationsPayload(
  workspace: Awaited<ReturnType<typeof resolveMcpWorkspace>>,
) {
  return workspace.locations.map((location) => ({
    ...location,
    active: location.id === workspace.location?.id,
  }));
}

export async function mutationContextPayload(
  mcpContext: McpOrganizationContext,
  options: {
    organizationId?: string | null;
    locationId?: string | null;
  } = {},
) {
  const context = await queryFirst<{
    organization_id: string;
    name: string;
    subdomain: string | null;
    custom_domain: string | null;
    public_url: string | null;
    location_id: string | null;
    location_slug: string | null;
    location_title: string | null;
  }>(mcpContext.db, `
    SELECT o.id AS organization_id,
           o.name,
           o.subdomain,
           (SELECT domain FROM organization_domains WHERE organization_id = o.id AND role = 'canonical' AND status = 'active' AND type = 'custom') AS custom_domain,
           (SELECT 'https://' || domain FROM organization_domains WHERE organization_id = o.id AND role = 'canonical' AND status = 'active' AND ${publicTenantVisibilitySql('o', false)}) AS public_url,
           location.id AS location_id,
           location.slug AS location_slug,
           location.title AS location_title
    FROM organization o
    LEFT JOIN business_locations location
      ON location.id = ?
     AND location.organization_id = o.id
    WHERE o.id = ?
    LIMIT 1
  `, [
    options.locationId ?? null,
    options.organizationId ?? mcpContext.organizationId,
  ]);
  if (!context) throw new Error('MCP organization context is unavailable.');
  const organization = await findOrganizationById(mcpContext.env, context.organization_id)
  if (!organization) throw new Error('MCP organization context is unavailable.')
  return {
    organization_id: context.organization_id,
    organization_name: organization.name,
    organization_slug: organization.slug,
    organization_subdomain: context.subdomain,
    organization_public_url: context.public_url ? tenantOrganizationOrigin({
      platformDomain: mcpContext.env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
      freeOrganizationDomain: mcpContext.env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '',
      subdomain: context.subdomain ?? '',
      canonicalDomain: context.public_url,
    }) : null,
    location_id: context.location_id,
    location_slug: context.location_slug,
    location_title: context.location_title,
  };
}

export function toolRequiresArgument(
  schema: Record<string, unknown>,
  key: string,
) {
  return Array.isArray(schema.required) && schema.required.includes(key);
}

export function rethrowWorkspaceError(error: unknown): never {
  if (error && typeof error === 'object' && 'statusCode' in error) throw error;
  if (error instanceof Error && error.message) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, error.message);
  }
  throw error;
}

export async function normalizeWorkspaceArguments(
  event: H3Event,
  toolName: string,
  schema: Record<string, unknown>,
  rawArguments: Record<string, unknown>,
  authenticatedUser?: McpUserContext,
) {
  const args = { ...rawArguments };

  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {};
  for (const key of ['organization_id', 'location_id']) {
    if (!(key in properties) || !Object.hasOwn(args, key)) continue
    // Null is an explicit value, including schemas that express it with
    // anyOf/oneOf. The SDK validates whether this tool accepts it.
    if (args[key] === null) continue
    if (typeof args[key] !== 'string' || !args[key].trim()) {
      throw mcpProtocolError(MCP_ERROR.invalidParams, `Invalid ${key}`, { status: 400, invalid_fields: [key] })
    }
    args[key] = args[key].trim()
  }

  if (["get_workspace_context", "set_workspace_context", "list_organizations"].includes(toolName)) return args;
  const supportsOrganization = "organization_id" in properties;
  const supportsLocation = "location_id" in properties;
  const needsLocation = toolRequiresArgument(schema, "location_id") && args.location_id !== null;
  const hasOrganization = typeof args.organization_id === "string" && args.organization_id.trim();
  const hasLocation = typeof args.location_id === "string" && args.location_id.trim();

  if (!supportsOrganization && !needsLocation) {
    return args;
  }

  if ((!supportsOrganization || hasOrganization) && (!needsLocation || hasLocation)) {
    return args;
  }

  const user = authenticatedUser ?? await requireMcpUser(event);
  let workspace;
  try {
    workspace = await resolveMcpWorkspace(
      user.db,
      user.env,
      user.userId,
      {
        organizationId: hasOrganization ? String(args.organization_id) : null,
        locationId: hasLocation ? String(args.location_id) : null,
        requireOrganization: supportsOrganization || needsLocation,
        requireLocation: needsLocation,
      },
    );
  } catch (error) {
    rethrowWorkspaceError(error);
  }

  if (!Object.hasOwn(args, 'organization_id') && supportsOrganization && workspace.organization) {
    args.organization_id = workspace.organization.id;
  }
  if (!Object.hasOwn(args, 'location_id') && supportsLocation && workspace.location && needsLocation) {
    args.location_id = workspace.location.id;
  }

  return args;
}




export function humanizeEntitlement(entitlement: string) {
  return entitlement
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function requiredString(source: Record<string, unknown>, key: string) {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `Invalid ${key}`);
  }
  return value.trim();
}

export function requiredBoolean(source: Record<string, unknown>, key: string) {
  const value = source[key];
  if (typeof value !== "boolean") {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `Invalid ${key}`);
  }
  return value;
}

export function optionalString(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function optionalDaysWindow(source: Record<string, unknown>, key: string, max = 90) {
  const value = source[key];
  if (value === undefined || value === null) return null;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `${key} must be a positive number of days`);
  }
  return Math.max(1, Math.min(Math.floor(num), max));
}

export function requiredStringArray(value: unknown, key: string) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `Invalid ${key}`);
  }
  return value.map((item) => item.trim());
}

export function objectRecord(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `Invalid ${key}`);
  }
  return value as Record<string, unknown>;
}

export function rethrowAsInvalidParams(error: unknown): never {
  if (error && typeof error === 'object' && 'statusCode' in error) throw error;
  if (!(error instanceof Error)) throw error;
  const message = error.message;
  if (
    message.startsWith('Field "') ||
    message.includes("must be a string") ||
    message.includes("calculator rules") ||
    message.includes("calculator configuration") ||
    message.includes("pricing_calculator") ||
    message.includes("offering needs") ||
    message.includes("tenant page needs") ||
    message.includes("Navigation item ids")
  ) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, message);
  }
  throw error;
}

export function objectArray(value: unknown, key: string) {
  if (!Array.isArray(value)) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `Invalid ${key}`);
  }
  if (
    value.some(
      (el) => el === null || typeof el !== "object" || Array.isArray(el),
    )
  ) {
    throw mcpProtocolError(
      MCP_ERROR.invalidParams,
      `Invalid ${key}: each element must be an object`,
    );
  }
  return value as Record<string, unknown>[];
}

export function omit(source: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !keys.includes(key)),
  );
}

export function toolString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

export function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /UNIQUE constraint failed/i.test(message);
}

export function getDateString(date: Date): string {
  const [day] = date.toISOString().split("T");
  return day ?? "";
}

export function detectImageContentType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50) {
    return "image/webp";
  }
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") {
      return "image/gif";
    }
  }
  return null;
}

export function assertDomainSuccess(result: {
  status: number;
  data: Record<string, unknown>;
}) {
  if (result.status < 400) return;
  throw new HTTPError({
    statusCode: result.status,
    statusMessage: String(result.data.error ?? "Request failed"),
    data: result.data,
  });
}

export const NOT_HANDLED = Symbol('mcp-executor-not-handled')

// Only toolName/args/site are read by domain handlers —
// event/tool/rawArguments/normalizedArguments/organizationId exist for the MCP protocol
// caller (executeMcpToolCall) and are optional so non-MCP callers (ChowBot, see
// mcp-executor/chowbot-adapter.ts) can build a context without an H3Event or a
// resolved MCP tool-catalog entry.
export interface McpExecutorContext {
  event?: H3Event
  toolName: string
  rawArguments?: Record<string, unknown>
  normalizedArguments?: Record<string, unknown>
  tool?: ReturnType<typeof getMcpTool>
  organizationId?: string
  organization: McpOrganizationContext
  args: Record<string, unknown>
}

// Download targets supplied by a client (ChatGPT attachments, generated files)
// must never reach loopback or private address space from the Worker.
function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(part => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b = -1] = parts
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  // IPv4-mapped literals (::ffff:10.0.0.1 or ::ffff:a00:1) must fail the IPv4 rules too.
  const mapped = /^::ffff:(.+)$/.exec(normalized)?.[1]
  if (mapped) {
    if (mapped.includes('.')) return isPrivateIpv4(mapped)
    const groups = mapped.split(':')
    if (groups.length === 2) {
      const high = Number.parseInt(groups[0]!, 16)
      const low = Number.parseInt(groups[1]!, 16)
      if (Number.isInteger(high) && Number.isInteger(low)) {
        return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'))
      }
    }
  }
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')
}

function normalizeHostnameForIpChecks(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1)
  }
  return hostname
}

export function assertSafeDownloadUrl(rawUrl: string, label: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `${label} download URL is invalid.`)
  }

  const hostname = parsed.hostname.trim().toLowerCase()
  const normalizedHostname = normalizeHostnameForIpChecks(hostname)
  if (!hostname) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `${label} download URL must include a hostname.`)
  }
  const isDevLoopback = import.meta.dev && parsed.protocol === 'http:' && (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    normalizedHostname === '127.0.0.1' ||
    normalizedHostname === '::1'
  )
  if (parsed.protocol !== 'https:' && !isDevLoopback) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `${label} download URL must use https.`)
  }
  if (isDevLoopback) return parsed

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `${label} download URL cannot target localhost.`)
  }
  if (isIP(normalizedHostname) === 4 && isPrivateIpv4(normalizedHostname)) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `${label} download URL cannot target a private IPv4 address.`)
  }
  if (isIP(normalizedHostname) === 6 && isPrivateIpv6(normalizedHostname)) {
    throw mcpProtocolError(MCP_ERROR.invalidParams, `${label} download URL cannot target a private IPv6 address.`)
  }

  return parsed
}
