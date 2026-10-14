import { execute, type DbClient } from "~/server/db";
import { describeErrorForTelemetry } from "~/shared/error-telemetry";
import { anonymizeId } from "~/server/utils/platform-telemetry";
import { recordUsageEvent } from "~/server/utils/usage-metering";
import { isRecord } from "~/server/utils/type-guards";

// Normal telemetry stores typed operational facts. Startup diagnostics are
// explicitly enabled on the Worker and expire after seven days.
const COUNT_FIELDS = new Set(['count', 'total', 'limit', 'offset', 'party_size', 'quantity', 'capacity', 'remaining_capacity', 'duration_ms', 'unit_amount', 'amount']);
const BOOLEAN_FIELDS = new Set(['success', 'isError', 'completed', 'operation_completed', 'mutation_applied', 'retry_with_same_idempotency_key', 'action_required', 'has_more', 'has_next_page', 'acknowledge_guest', 'confirm', 'replayed']);
const STATUS_VALUES = new Set(['success', 'error', 'auth_required', 'blocked', 'action_required', 'pending', 'pending_review', 'confirmed', 'cancelled', 'declined', 'rejected', 'draft', 'published', 'unpublished', 'active', 'inactive', 'paid', 'unpaid', 'refunded', 'partially_refunded', 'failed', 'processing', 'completed']);
const CONTAINER_FIELDS = new Set(['structuredContent', 'result', 'data', 'page_info', 'booking', 'reservation', 'payment']);
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

export function summarizeForTelemetry(value: unknown): string | null {
  const summary = operationalSummary(value);
  return summary ? JSON.stringify(summary) : null;
}

const DIAGNOSTIC_SECRET_KEY = /(?:authorization|cookie|secret|token|password|api[_-]?key|access[_-]?key|download[_-]?url|file[_-]?data|base64|^_meta$)/i;
const MAX_DIAGNOSTIC_LENGTH = 256_000;

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
        .replace(/\b[rs]k_(?:test|live)_[A-Za-z0-9_*]+/g, '[key redacted]')
        .replace(/\bBearer\s+[^\s,"']+/gi, 'Bearer [redacted]')
        .replace(/https?:\/\/[^\s<>"']+/gi, url => url.replace(/\?[^#]*/, '?[redacted]').replace(/#.*/, '#[redacted]'));
      // MCP text often repeats structured JSON. Redact that copy as well.
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
  return JSON.stringify(data.length > MAX_DIAGNOSTIC_LENGTH
    ? { _diagnostic: true, truncated: true, original_length: data.length, preview: data.slice(0, MAX_DIAGNOSTIC_LENGTH) }
    : { _diagnostic: true, data: JSON.parse(data) });
}

export type McpToolCallStatus = "success" | "error" | "auth_required" | "blocked";

export interface LogMcpToolCallEventInput {
  env?: ApiRecord | null;
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

function hashIdentifier(env: ApiRecord | null | undefined, value: string | null | undefined) {
  if (!env || !value) return null;
  try {
    return anonymizeId(value, env);
  } catch {
    return null;
  }
}

// Fire-and-forget by convention: callers should wrap this in waitUntil (or let
// it run detached) rather than await it inline — telemetry must never add
// latency to, or fail, an MCP response.
export async function logMcpToolCallEvent(
  db: DbClient,
  input: LogMcpToolCallEventInput,
): Promise<void> {
  const mcpSurface = input.mcpSurface ?? "client";
  const diagnostic = input.env?.MCP_DIAGNOSTICS_ENABLED === 'true'
    && mcpSurface === 'client' && (input.method === 'tools/call' || input.method === 'tools/list');
  const failure = toolErrorFields(input.method === 'tools/call' && input.status === 'error' ? input.result : undefined);
  const errorCode = failure.errorCode ?? input.errorCode;
  const failureMessage = failure.errorMessage ?? input.errorMessage;
  const httpStatus = failure.httpStatus ?? input.httpStatus;
  const errorMessage = failureMessage
    ? diagnostic ? describeErrorForTelemetry(failureMessage) : "MCP operation failed; see error code and status."
    : null;
  const jsonrpcErrorMessage = input.jsonrpcErrorMessage;
  const eventId = crypto.randomUUID();
  await execute(
      db,
      `
      INSERT INTO mcp_tool_call_events
        (id, organization_id, location_id, user_id, mcp_surface, request_id,
         method, tool_name, tool_domain, is_mutating, arguments_summary_json,
         result_summary_json, status, error_code, error_message,
         http_status, jsonrpc_error_code, jsonrpc_error_message, protocol_version,
         session_id_hash, oauth_client_id_hash, user_agent, cf_ray_id,
         catalog_fingerprint, unknown_tool_name, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        eventId,
        input.organizationId ?? null,
        input.locationId ?? null,
        input.userId ?? null,
        mcpSurface,
        input.requestId == null ? null : String(input.requestId),
        mcpTelemetryMethod(input.method),
        input.unknownToolName ? null : input.toolName ?? null,
        input.toolDomain ?? null,
        input.isMutating == null ? null : input.isMutating ? 1 : 0,
        diagnostic ? mcpDiagnosticPayload(input.arguments ?? {}) : summarizeForTelemetry(input.arguments),
        diagnostic ? mcpDiagnosticPayload(input.result) : summarizeForTelemetry(input.result),
        input.status,
        errorCode == null ? null : String(errorCode),
        errorMessage,
        httpStatus ?? null,
        input.jsonrpcErrorCode ?? null,
        jsonrpcErrorMessage ? diagnostic ? describeErrorForTelemetry(jsonrpcErrorMessage) : "MCP operation failed; see error code and status." : null,
        input.protocolVersion ?? null,
        hashIdentifier(input.env, input.sessionId),
        hashIdentifier(input.env, input.oauthClientId),
        null,
        input.cfRayId ?? null,
        input.catalogFingerprint ?? null,
        hashIdentifier(input.env, input.unknownToolName),
        input.durationMs ?? null,
      ],
  );

  if (input.method === "tools/call" && input.organizationId) {
    await recordUsageEvent(db, {
        organizationId: input.organizationId,
        resource: "mcp_operation",
        source: mcpSurface,
        provider: mcpSurface === "client" ? "mcp_client" : "krabiclaw",
        channel: "tools/call",
        quantity: 1,
        unit: "tool_call",
        metadata: {
          toolName: input.toolName ?? null,
          toolDomain: input.toolDomain ?? null,
          status: input.status,
          httpStatus: httpStatus ?? null,
        },
        // Hosts may reuse an RPC ID on separate HTTP requests.
        idempotencyKey: `mcp:${mcpSurface}:${eventId}`,
    });
  }
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
