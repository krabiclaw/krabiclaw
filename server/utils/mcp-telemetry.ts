import type { H3Event } from "nitro";
import { execute, executeBatch, type DbClient } from "~/server/db";
import { describeErrorForTelemetry, redactErrorText } from "~/shared/error-telemetry";
import { anonymizeId } from "~/server/utils/platform-telemetry";
import { usageEventInsert } from "~/server/utils/usage-metering";
import { isRecord } from "~/server/utils/type-guards";
import { publishEvent, type DomainEvent, type EventsEnv } from "~/server/events";

// Normal telemetry stores typed operational facts. Startup diagnostics are
// explicitly enabled on the Worker and expire after seven days.
const COUNT_FIELDS = new Set(['count', 'total', 'limit', 'offset', 'party_size', 'quantity', 'capacity', 'remaining_capacity', 'duration_ms', 'unit_amount', 'amount']);
const BOOLEAN_FIELDS = new Set(['success', 'isError', 'completed', 'operation_completed', 'mutation_applied', 'retry_with_same_idempotency_key', 'action_required', 'has_more', 'has_next_page', 'acknowledge_guest', 'confirm', 'replayed']);
const STATUS_VALUES = new Set(['success', 'error', 'auth_required', 'blocked', 'action_required', 'pending', 'pending_review', 'confirmed', 'cancelled', 'declined', 'rejected', 'draft', 'published', 'unpublished', 'active', 'inactive', 'paid', 'unpaid', 'refunded', 'partially_refunded', 'failed', 'processing', 'completed']);
const CONTAINER_FIELDS = new Set(['structuredContent', 'result', 'data', 'page_info', 'booking', 'payment']);
const MCP_METHODS = new Set(['initialize', 'ping', 'notifications/initialized', 'tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get']);

export function mcpTelemetryMethod(method: string | null | undefined): string {
  return method && MCP_METHODS.has(method) ? method : 'unknown';
}

function operationalSummary(value: unknown, depth = 0): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return null;
  const summary: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (COUNT_FIELDS.has(key) && typeof field === 'number' && Number.isFinite(field)) summary[key] = field;
    else if (BOOLEAN_FIELDS.has(key) && typeof field === 'boolean') summary[key] = field;
    else if (key === 'status' && typeof field === 'string' && STATUS_VALUES.has(field)) summary[key] = field;
    else if (CONTAINER_FIELDS.has(key)) {
      const nested = operationalSummary(field, depth + 1);
      if (nested) summary[key] = nested;
    }
  }
  return Object.keys(summary).length ? summary : null;
}

// Cloudflare Queues allows 128,000 bytes including roughly 100 bytes of metadata.
const MAX_EVENT_BYTES = 127_000;
const MAX_SUMMARY_BYTES = 48_000;
const encoder = new TextEncoder();

function fitsSummaryField(value: string): boolean {
  return encoder.encode(JSON.stringify(value)).byteLength <= MAX_SUMMARY_BYTES;
}

export function summarizeForTelemetry(value: unknown): string | null {
  const summary = operationalSummary(value);
  if (!summary) return null;
  const data = JSON.stringify(summary);
  return fitsSummaryField(data) ? data : JSON.stringify({ ...operationalSummary(value, 3), _truncated: true });
}

const DIAGNOSTIC_SECRET_KEY = /(?:authorization|cookie|secret|token|password|api[_-]?key|access[_-]?key|download[_-]?url|file[_-]?data|base64|^_meta$)/i;

export function mcpDiagnosticPayload(value: unknown): string | null {
  if (value == null) return null;
  function replacer() {
    const ancestors: object[] = [];
    return function redact(this: Record<string, unknown>, key: string, field: unknown): unknown {
      if (key === '_request') return undefined;
      if (DIAGNOSTIC_SECRET_KEY.test(key)) return '[redacted]';
      if (key === 'data' && (this.type === 'image' || this.type === 'audio')) return '[binary omitted]';
      if (typeof field === 'string') {
        const redacted = field
          .replace(/\b(?:[rs]k_(?:test|live)_|sk-proj-|gh[pousr]_|github_pat_)[A-Za-z0-9_*-]+/g, '[key redacted]')
          .replace(/\bBearer\s+[^\s,"']+/gi, 'Bearer [redacted]')
          .replace(/\b(password|secret|token|api[_-]?key|authorization|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1: [redacted]')
          .replace(/https?:\/\/[^\s<>"']+/gi, url => url
            .replace(/^(https?:\/\/)[^/?#]*@/i, '$1[redacted]@')
            .replace(/\?[^#]*/, '?[redacted]')
            .replace(/#.*/, '#[redacted]'));
        // MCP text can repeat the structured data.
        if (/^\s*[{[]/.test(field)) {
          try {
            return JSON.stringify(JSON.parse(field), replacer());
          } catch {
            return redacted;
          }
        }
        return redacted;
      }
      if (field && typeof field === 'object') {
        while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
        if (ancestors.includes(field)) return '[circular]';
        ancestors.push(field);
      }
      return field;
    };
  }
  const data = JSON.stringify(value, replacer());
  if (data === undefined) return null;
  const diagnostic = `{"_diagnostic":true,"data":${data}}`;
  if (fitsSummaryField(diagnostic)) return diagnostic;

  let length = Math.min(data.length, MAX_SUMMARY_BYTES);
  for (;;) {
    const truncated = JSON.stringify({ _diagnostic: true, truncated: true, original_length: data.length, preview: data.slice(0, length) });
    if (fitsSummaryField(truncated)) return truncated;
    length = Math.floor(length / 2);
  }
}

export type McpToolCallStatus = "success" | "error" | "auth_required" | "blocked";

export interface LogMcpToolCallEventInput {
  env?: { BETTER_AUTH_SECRET?: string; MCP_DIAGNOSTICS_ENABLED?: string } | null;
  organizationId?: string | null;
  locationId?: string | null;
  userId?: string | null;
  mcpSurface?: "client" | "public_help";
  requestId?: string | number | null;
  method: string;
  toolName?: string | null;
  toolDomain?: string | null;
  isMutating?: boolean | null;
  arguments?: unknown;
  result?: unknown;
  status: McpToolCallStatus;
  errorCode?: string | number | null;
  errorMessage?: string | null;
  httpStatus?: number | null;
  jsonrpcErrorCode?: number | null;
  jsonrpcErrorMessage?: string | null;
  protocolVersion?: string | null;
  sessionId?: string | null;
  oauthClientId?: string | null;
  userAgent?: string | null;
  cfRayId?: string | null;
  catalogFingerprint?: string | null;
  unknownToolName?: string | null;
  durationMs?: number | null;
}

function toolErrorFields(result: unknown): Pick<LogMcpToolCallEventInput, 'httpStatus' | 'errorCode' | 'errorMessage'> {
  if (!isRecord(result)) return {};
  let details: unknown = result.structuredContent ?? result;
  let text: string | undefined;
  if (result.isError === true && Array.isArray(result.content)) {
    text = result.content.filter(isRecord).filter(entry => entry.type === 'text' && typeof entry.text === 'string').map(entry => entry.text).join('\n');
    if (!result.structuredContent && text) {
      try { details = JSON.parse(text); } catch { return { errorMessage: text }; }
    }
  }
  if (!isRecord(details)) return { errorMessage: text };
  const failure = isRecord(details.data) ? { ...details, ...details.data } : details;
  const status = failure.http_status ?? failure.status;
  return {
    httpStatus: Number.isInteger(status) && Number(status) >= 400 && Number(status) < 600 ? Number(status) : undefined,
    errorCode: typeof failure.code === 'string' || typeof failure.code === 'number' ? failure.code : undefined,
    errorMessage: typeof failure.message === 'string' ? failure.message : typeof failure.error === 'string' ? failure.error : text,
  };
}

function hashIdentifier(env: LogMcpToolCallEventInput["env"], value: string | null | undefined) {
  if (!env || !value) return null;
  try {
    return anonymizeId(value, env);
  } catch {
    return null;
  }
}

export function prepareMcpToolCallEvent(input: LogMcpToolCallEventInput) {
  const mcpSurface = input.mcpSurface ?? "client";
  const diagnostic = input.env?.MCP_DIAGNOSTICS_ENABLED === 'true'
    && mcpSurface === 'client' && (input.method === 'tools/call' || input.method === 'tools/list');
  const failure = toolErrorFields(input.method === 'tools/call' && input.status === 'error' ? input.result : undefined);
  const errorCode = failure.errorCode ?? input.errorCode;
  const failureMessage = failure.errorMessage ?? input.errorMessage;
  const fallbackError = "MCP operation failed; see error code and status.";
  return {
    id: crypto.randomUUID(),
    organization_id: input.organizationId ?? null,
    location_id: input.locationId ?? null,
    user_id: input.userId ?? null,
    mcp_surface: mcpSurface,
    request_id: input.requestId == null ? null : redactErrorText(String(input.requestId), 128),
    method: mcpTelemetryMethod(input.method),
    tool_name: input.unknownToolName ? null : input.toolName ?? null,
    tool_domain: input.toolDomain ?? null,
    is_mutating: input.isMutating == null ? null : Number(input.isMutating),
    arguments_summary_json: diagnostic ? mcpDiagnosticPayload(input.arguments ?? {}) : summarizeForTelemetry(input.arguments),
    result_summary_json: diagnostic ? mcpDiagnosticPayload(input.result) : summarizeForTelemetry(input.result),
    status: input.status,
    error_code: errorCode == null ? null : redactErrorText(String(errorCode), 128),
    error_message: failureMessage ? diagnostic ? describeErrorForTelemetry(failureMessage) : fallbackError : null,
    http_status: failure.httpStatus ?? input.httpStatus ?? null,
    jsonrpc_error_code: input.jsonrpcErrorCode ?? null,
    jsonrpc_error_message: input.jsonrpcErrorMessage ? diagnostic ? describeErrorForTelemetry(input.jsonrpcErrorMessage) : fallbackError : null,
    protocol_version: input.protocolVersion && /^\d{4}-\d{2}-\d{2}$/.test(input.protocolVersion) ? input.protocolVersion : null,
    session_id_hash: hashIdentifier(input.env, input.sessionId),
    oauth_client_id_hash: hashIdentifier(input.env, input.oauthClientId),
    cf_ray_id: input.cfRayId == null ? null : redactErrorText(input.cfRayId, 128),
    catalog_fingerprint: input.catalogFingerprint ?? null,
    unknown_tool_name: hashIdentifier(input.env, input.unknownToolName),
    duration_ms: input.durationMs ?? null,
    created_at: new Date().toISOString(),
  };
}

export type McpToolCallEvent = ReturnType<typeof prepareMcpToolCallEvent>;

/** Publish only prepared telemetry. An enqueue failure is reported without replaying a tool. */
export async function enqueueMcpToolCallEvent(event: H3Event, env: EventsEnv & NonNullable<LogMcpToolCallEventInput["env"]>, input: LogMcpToolCallEventInput): Promise<void> {
  try {
    const message: DomainEvent = { type: 'mcp.telemetry', record: prepareMcpToolCallEvent({ ...input, env }) };
    if (encoder.encode(JSON.stringify(message)).byteLength > MAX_EVENT_BYTES) {
      throw new Error("MCP telemetry exceeds the Cloudflare Queue message size");
    }
    await publishEvent(env, message);
  } catch (cause) {
    const { useNitroHooks } = await import('nitro/app');
    const error = new Error(describeErrorForTelemetry(cause));
    await useNitroHooks().callHook('error', error, { event, tags: ['mcp-telemetry', 'queue'] });
  }
}

/** Queue redelivery uses the same telemetry ID and usage idempotency key. */
export async function logMcpToolCallEvent(db: DbClient, record: McpToolCallEvent): Promise<void> {
  const write = {
    query: `INSERT INTO mcp_tool_call_events
      (id, organization_id, location_id, user_id, mcp_surface, request_id,
       method, tool_name, tool_domain, is_mutating, arguments_summary_json, result_summary_json,
       status, error_code, error_message, http_status, jsonrpc_error_code, jsonrpc_error_message,
       protocol_version, session_id_hash, oauth_client_id_hash, cf_ray_id, catalog_fingerprint,
       unknown_tool_name, duration_ms, created_at)
      VALUES (?, (SELECT id FROM organization WHERE id=?), (SELECT id FROM business_locations WHERE id=?),
        (SELECT id FROM user WHERE id=?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`,
    params: [
      record.id, record.organization_id, record.location_id, record.user_id, record.mcp_surface,
      record.request_id, record.method, record.tool_name, record.tool_domain, record.is_mutating,
      record.arguments_summary_json, record.result_summary_json, record.status, record.error_code,
      record.error_message, record.http_status, record.jsonrpc_error_code, record.jsonrpc_error_message,
      record.protocol_version, record.session_id_hash, record.oauth_client_id_hash, record.cf_ray_id,
      record.catalog_fingerprint, record.unknown_tool_name, record.duration_ms, record.created_at,
    ],
  };
  if (record.method !== 'tools/call' || !record.organization_id) {
    await execute(db, write.query, write.params);
    return;
  }

  const usage = usageEventInsert({
    organizationId: record.organization_id,
    resource: 'mcp_operation',
    source: record.mcp_surface,
    provider: record.mcp_surface === 'client' ? 'mcp_client' : 'krabiclaw',
    channel: 'tools/call',
    quantity: 1,
    unit: 'tool_call',
    metadata: {
      toolName: record.tool_name,
      toolDomain: record.tool_domain,
      status: record.status,
      httpStatus: record.http_status,
    },
    // Hosts may reuse an RPC ID on separate HTTP requests.
    idempotencyKey: `mcp:${record.mcp_surface}:${record.id}`,
    createdAt: record.created_at,
  }, undefined, {
    query: 'SELECT 1 FROM mcp_tool_call_events WHERE id=? AND organization_id=?',
    params: [record.id, record.organization_id],
  });
  await executeBatch(db, [write, usage], { operation: 'Record MCP telemetry and usage' });
}

// The Privacy Policy's MCP telemetry limit: a row is deleted 180 days after it
// was created. Runs in the daily analytics task beside the pageview cleanup.
export async function cleanupMcpToolCallEvents(db: DbClient, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 180 * 86_400_000).toISOString();
  const diagnosticCutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const result = await execute(db, `DELETE FROM mcp_tool_call_events WHERE created_at < ?
    OR (created_at < ? AND json_extract(arguments_summary_json, '$._diagnostic') = 1)`, [cutoff, diagnosticCutoff]);
  return Number(result.meta.changes);
}
