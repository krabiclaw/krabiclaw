# Observability

Data-loading diagnostics, Cloudflare API access, and MCP telemetry for production debugging.

## Data-loading diagnostics

Every application API error should include the `x-request-id` response header and the same ID in its structured error body. Browser clients retain that ID in `ApiClientError`; use it to correlate the browser failure with Worker logs.

Instrumented public shell/page and representative dashboard responses expose:

- `x-request-id`
- `x-data-cache`
- `x-d1-query-count`
- `x-response-bytes`
- `Server-Timing` phases such as `base`, `shell`, `page`, `context`, `resources`, `d1`, `serialize`, and `total`

Exactly one matching `[data-request]` structured Worker log is emitted at the response boundary. It aggregates every instrumented loader used by that HTTP request and includes resource names, attempt count, statement count, D1 batch round trips, rows read/written, accumulated D1 time, JSON bytes, total duration, HTTP status, and error code. Batch operations count every contained statement, not only the network round trip. Record a retry regression only when a follow-up request has the same logical key and context and occurs without navigation, user action, another tab, or another caller.

Dashboard requests must carry explicit organization and, for site routes, site scope through the canonical client. Missing or conflicting scope is terminal and must not be repaired from active-organization or first-site state.

## Cloudflare API access

### GraphQL Analytics API

Use GraphQL Analytics for ad-hoc historical queries of HTTP-level status codes and Worker-level health. This is the zone/CDN level, so it sees the actual HTTP status your Worker sent, including deliberate 401s/403s/500s your own code returns.

**Worker-level health** (`workersInvocationsAdaptive` — catches actual runtime exceptions/crashes, but NOT application-level HTTP status like a 401/500 returned deliberately by your own code):

```bash
# Set your Cloudflare API token and account ID
set -a; source .env; set +a
ACCT="<your-cloudflare-account-id>"
FROM=$(date -u -v-2H +%Y-%m-%dT%H:%M:%SZ)   # macOS date syntax; use `date -u -d '-2 hours'` on Linux
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > /tmp/cf-query.json << EOF
{
  "query": "query(\$acct: String!, \$start: Time!, \$end: Time!) { viewer { accounts(filter: {accountTag: \$acct}) { workersInvocationsAdaptive(limit: 200, filter: {scriptName: \"krabiclaw\", datetime_geq: \$start, datetime_leq: \$end}, orderBy: [datetimeMinute_DESC]) { dimensions { datetimeMinute scriptName status } sum { requests errors subrequests } } } } }",
  "variables": { "acct": "$ACCT", "start": "$FROM", "end": "$NOW" }
}
EOF

curl -s -X POST "https://api.cloudflare.com/client/v4/graphql" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/cf-query.json
```

**HTTP-level status codes per path** (`httpRequestsAdaptiveGroups`):

```bash
set -a; source .env; set +a
ZONE="<your-cloudflare-zone-id>"
FROM=$(date -u -v-2H +%Y-%m-%dT%H:%M:%SZ)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > /tmp/cf-query.json << EOF
{
  "query": "query(\$zone: String!, \$start: Time!, \$end: Time!) { viewer { zones(filter: {zoneTag: \$zone}) { httpRequestsAdaptiveGroups(limit: 500, filter: {datetime_geq: \$start, datetime_leq: \$end, clientRequestPath: \"/api/mcp\"}, orderBy: [datetimeMinute_DESC]) { dimensions { datetimeMinute clientRequestPath edgeResponseStatus } count } } } }",
  "variables": { "zone": "$ZONE", "start": "$FROM", "end": "$NOW" }
}
EOF

curl -s -X POST "https://api.cloudflare.com/client/v4/graphql" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @/tmp/cf-query.json
```

Drop the `clientRequestPath` filter to see all paths.

### Workers Observability / Logs telemetry API

`POST /accounts/{account_id}/workers/observability/telemetry/query` is the API behind the dashboard's "Logs" tab — use this for reading actual `console.log`/`console.error` output (e.g. this codebase's structured `[MCP_AUTH]` credential_rejected/accepted lines), not just status codes.

```bash
set -a; source .env; set +a
ACCT="<your-cloudflare-account-id>"
FROM_MS=$(($(date -u +%s) * 1000 - 3600000))   # 1 hour ago, epoch millis
TO_MS=$(($(date -u +%s) * 1000))

cat > /tmp/obs-query.json << EOF
{
  "queryId": "any-string-you-want-1",
  "timeframe": { "from": $FROM_MS, "to": $TO_MS },
  "parameters": {
    "filters": [
      { "key": "\$metadata.service", "operation": "includes", "type": "string", "value": "krabiclaw" },
      { "key": "\$metadata.level", "operation": "eq", "type": "string", "value": "error" }
    ]
  },
  "view": "events"
}
EOF

curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/observability/telemetry/query" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data-binary @/tmp/obs-query.json
```

Response shape: `result.events.events[]`, each with a `source` object containing `level`, `message`, and (for Workers) `$workers.event.request` (url/method/path) and `$workers.requestId`/`rayId` for cross-referencing against `httpRequestsAdaptiveGroups`. `timeframe.from`/`to` **must** be epoch milliseconds (integers), not ISO strings.

Useful `key` values for `filters`: `$metadata.service` (worker script name), `$metadata.level` (`error`/`warn`/`info`), `message` (substring match on the log line, works with `operation: "includes"`), `$workers.event.request.path` (HTTP path).

### Correlating the two

`workersInvocationsAdaptive`/`httpRequestsAdaptiveGroups` tell you *when* and *how many* requests failed and with what HTTP status, at 1-minute granularity — enough to confirm "yes, something is really failing" and rule out narrow theories. They cannot tell you *why* a specific request failed — for that, use the telemetry `query` API above (or the dashboard Logs UI) to read the actual log line.

`server/utils/mcp-auth.ts`'s `logMcpAuth()` calls are the source of truth for the "why": every `credential_rejected` event logs `jwt_reason` / `opaque_reason` (e.g. `jwt_expired`, `expiry_invalid`, `tenant_scope_missing`), plus `path`, `audiences_checked`, `required_scopes`, and unverified `claimed_aud`/`claimed_iss`/`claimed_exp_iso`/etc decoded straight from a rejected JWT's payload.

## MCP Auth Debugging

Use this when ChatGPT says "reconnect", "always allow" does not stick, or the connector appears connected but tool calls still fail.

### What to read first

**1. D1 telemetry (`mcp_tool_call_events`)**

This is the fastest coarse history for MCP auth outcomes. Look at:
- `status`
- `tool_name`
- `error_message`
- `created_at`

Useful `error_message` patterns:
- `credential_missing: missing bearer token or cookie`
- `credential_rejected: invalid_token: Token missing, expired, invalid, or not issued for this MCP resource`
- `credential_rejected: insufficient_scope: <scope> scope required`

**2. Cloudflare GraphQL analytics**

Use GraphQL analytics when you need request-level status patterns for `/api/mcp` to confirm whether failures align to a specific time window.

**3. Telemetry query API (or dashboard Logs UI)**

Use the `workers/observability/telemetry/query` API or the dashboard Logs UI for raw `[MCP_AUTH]` lines from `server/utils/mcp-auth.ts`. These lines include richer rejection reasons not visible from HTTP status codes alone, such as `jwt_expired`, `jwt_claim_aud_invalid`, `jwt_claim_iss_invalid`, `tenant_scope_missing`.

### Reconnect bug decision tree

**Missing token**
- Signals: D1 `error_message` starts with `credential_missing`, `tools/call` returns JSON-RPC auth challenge, one manual "Allow" click works but later calls ask to reconnect again
- Likely cause: ChatGPT did not send a bearer token for that call

**Expired token**
- Signals: D1 shows `credential_rejected: invalid_token`, dashboard Logs show `jwt_expired`
- Likely cause: ChatGPT reused a stale connector token and did not refresh cleanly

**Wrong audience or resource**
- Signals: D1 shows `credential_rejected: invalid_token`, dashboard Logs show `jwt_claim_aud_invalid`, connector was created against one origin but the app now advertises another
- Likely cause: `BETTER_AUTH_URL`, MCP resource metadata, and the connector's registered resource are out of sync

**Insufficient scope**
- Signals: D1 shows `credential_rejected: insufficient_scope`
- Likely cause: token was minted without the required MCP scope for that surface

**Connected, but tools/list or the first tool call breaks the stream**
- Signals: D1 telemetry shows successful authenticated `tools/list`, token exchange and bearer-token acceptance both look normal in logs, ChatGPT still shows generic connection/stream error
- Likely cause: not an auth problem — inspect `tools/list` shape and size after the real 200.

**Host mismatch**
- Signals: staging connector connects then reconnects repeatedly, `/.well-known/oauth-protected-resource` and `issuer` do not line up with connector URL
- Check: `BETTER_AUTH_URL`, `NUXT_PUBLIC_PLATFORM_DOMAIN`, MCP resource metadata, and the ChatGPT connector URL used during setup must point at the same origin

## MCP Usage Telemetry

Durable logging of ChatGPT MCP protocol requests for understanding tool discovery, adoption, catalog drift, and fuzzy-intent flows.

### What is captured

MCP requests against `server/api/mcp.ts` write rows to `mcp_tool_call_events` (`server/db/schema.ts`) via `logMcpToolCallEvent()` in `server/utils/mcp-telemetry.ts`. Writes are fire-and-forget — wrapped in Cloudflare's `waitUntil` when available, or a detached promise otherwise — so telemetry can never add latency to, or fail, an MCP response.

Captured per row: surface, authorized organization/location/user id, request id, method, tool name + domain, HTTP status, JSON-RPC error code/message, protocol version, hashed session id, hashed OAuth client id, Cloudflare ray id, catalog fingerprint, operational summaries of arguments and result, unknown-tool fields, status (`success` / `error` / `auth_required` / `blocked`), and duration in ms.

Rows are deleted 180 days after `created_at` by `cleanupMcpToolCallEvents()`, which the daily `analytics-aggregate-daily` task (`0 3 * * *`) runs beside the pageview cleanup. This is the limit the Privacy Policy states.

Each `tools/call` with an organization also writes a `usage_events` row (`resource = 'mcp_operation'`). Its `provider` is `mcp_client` for every external MCP client and `krabiclaw` for the public help agent. Rows written before this change say `krabiclaw` for external clients too, because the surface default was applied after the provider was chosen.

### Operational summaries

`summarizeForTelemetry()` records only an explicit set of typed operational fields: finite counts/amounts, confirmation/completion flags, and known status values. Only named result, pagination, booking, reservation and payment containers are traversed, with bounded depth. Unknown fields and free text are omitted, including customer names, messages, booking notes, emails, attachment URLs, tokens and passwords. Error-message columns contain a fixed failure label; unknown tool names are hashed and user-agent text is omitted. Full conversational text and tool outputs are not stored in these summaries.

### Startup workflow diagnostics

`MCP_DIAGNOSTICS_ENABLED = "true"` in the Worker's vars enables detailed external
`tools/call` and `tools/list` capture. Production enables this during startup debugging.
The existing argument/result columns then contain `{ "_diagnostic": true,
"data": ... }`: tool arguments and the returned MCP result, including its model
text, structured data and failure result. Actual errors replace the fixed label.
The RPC request ID, Cloudflare ray, user and authorized site identify each call.
Raw `_request` host metadata and user-agent text are omitted.
Credentials, private `_meta`, and URL query strings and fragments are redacted. Each payload is
bounded at 256,000 characters; oversized payloads explicitly record truncation
and their original length. These diagnostic rows expire after seven days via the
same daily cleanup, even after the flag is disabled. Normal operational rows
retain their 180-day limit. Staging has no scheduled retention task, so detailed
capture remains disabled there. Local disposable-D1 tests exercise diagnostic mode.

MCP receives the selected tool and arguments, not the user's ChatGPT messages or
ChatGPT's final reply. A shared conversation is still needed to compare the
user's request and ChatGPT's claims with the actual tool trace. Earlier omitted
inputs cannot be reconstructed. Diagnostic payloads can contain customer content
and contact details; access them through the operator's authenticated D1 access.

```sql
SELECT e.created_at, e.request_id, e.cf_ray_id, e.organization_id,
       e.tool_name, e.status, e.arguments_summary_json,
       e.result_summary_json, e.error_message
FROM mcp_tool_call_events e JOIN user u ON u.id = e.user_id
WHERE u.email = ? AND e.created_at >= ?
ORDER BY e.created_at;
```

Tenant-scoped calls are attributed to the organization authorized by the executor, including when it resolves a saved workspace for a bearer token. Location attribution uses the validated selected location. Global discovery/context calls are not assigned to a guessed organization. These events still carry the operation, status, error code, duration, and catalog fingerprint needed to investigate failures.

### Querying

Query via `wrangler d1 execute` (locally or with `--remote`).

Ad-hoc SQL examples:

```sql
-- Most-called tools in the last 7 days
SELECT tool_name, tool_domain, COUNT(*) AS calls
FROM mcp_tool_call_events
WHERE method = 'tools/call' AND created_at >= datetime('now', '-7 days')
GROUP BY tool_name, tool_domain
ORDER BY calls DESC;

-- Which tools fail most, and why
SELECT tool_name, error_code, error_message, COUNT(*) AS occurrences
FROM mcp_tool_call_events
WHERE status = 'error' AND created_at >= datetime('now', '-7 days')
GROUP BY tool_name, error_code, error_message
ORDER BY occurrences DESC;

-- Feature-flag-gated tools ChatGPT tried to call but couldn't
SELECT tool_name, COUNT(*) AS occurrences
FROM mcp_tool_call_events
WHERE status IN ('blocked', 'auth_required')
GROUP BY tool_name
ORDER BY occurrences DESC;
```

### Adding a new mutating/read tool

Nothing to wire up manually — every tool routed through `executeMcpToolCall()` in `mcp.ts`'s `tools/call` handler is logged automatically, using its existing `domain` and `annotations.readOnlyHint` from `server/utils/mcp-tools.ts`. For tool catalog changes and OpenAI app refresh steps, see [docs/mcp.md](mcp.md).

## MCP tool catalog queries

Use these D1 queries for ChatGPT app catalog mismatches. The same fields are populated for tenant (`mcp_surface = 'client'`) and platform (`mcp_surface = 'platform'`) events.

```sql
SELECT mcp_surface, unknown_tool_name, oauth_client_id_hash,
       catalog_fingerprint, COUNT(*) AS failures
  FROM mcp_tool_call_events
 WHERE unknown_tool_name IS NOT NULL
 GROUP BY 1, 2, 3, 4
 ORDER BY failures DESC;

SELECT session_id_hash, mcp_surface, method, tool_name,
       jsonrpc_error_code, jsonrpc_error_message, COUNT(*) AS repeats
  FROM mcp_tool_call_events
 WHERE status = 'error' AND session_id_hash IS NOT NULL
 GROUP BY 1, 2, 3, 4, 5, 6
HAVING repeats > 1
 ORDER BY repeats DESC;

SELECT created_at, mcp_surface, method, tool_name, http_status,
       jsonrpc_error_code, jsonrpc_error_message
  FROM mcp_tool_call_events
 WHERE jsonrpc_error_code IS NOT NULL
   AND http_status != 200
   AND status != 'auth_required';

SELECT created_at, mcp_surface, method, tool_name, session_id_hash, cf_ray_id
  FROM mcp_tool_call_events
 WHERE http_status = 404;
```
