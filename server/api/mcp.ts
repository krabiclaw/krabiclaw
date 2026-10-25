import { HTTPError, defineHandler } from 'nitro';
import { getEventContext, readBody } from 'nitro/h3';
import type { H3Event } from "nitro";
import { createParser } from 'eventsource-parser';
import {
  createMcpHandler,
  McpServer,
  fromJsonSchema,
  type JsonSchemaType,
  ProtocolError,
  hostHeaderValidationResponse,
  originValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  type CallToolResult,
  type ListToolsResult,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { asMcpError, mcpFailure, MCP_ERROR, type JsonRpcId } from "~/server/utils/mcp-protocol";
import { catalogFingerprint, catalogMeta } from "~/server/utils/mcp-catalog";
import { executeMcpToolCall, mcpToolInputSchema, MCP_PUBLIC_TOOLS, MCP_TOOLS } from "~/server/utils/mcp-tools";
import { isMcpRenderResponse } from "~/server/utils/mcp-render";
import {
  getActiveEntitlements, getVisibleOrganizationContext, requireMcpUser, roleSatisfies, type McpUserContext, } from "~/server/utils/mcp-auth";
import { MCP_PROMPTS, renderMcpPrompt } from "~/server/utils/mcp-prompts";
import { cloudflareEnv } from "~/server/utils/api-response";
import { purgePublicResourceCacheNow } from "~/server/utils/public-resource-cache";
import { resolveMissingMcpCredential, type McpToolMeta } from "~/server/utils/mcp-runtime";
import {
  buildMcpAuthChallengeForError, describeMcpAuthTelemetryError, getCloudflareWaitUntil, isMcpMutatingTool, mcpAuthChallengeFromError, mcpAuthRequiredResult, mcpToolErrorResult, setMcpAuthChallenge, } from "~/server/utils/mcp-route-helpers";
import { logMcpToolCallEvent, mcpTelemetryMethod } from "~/server/utils/mcp-telemetry";
import { describeErrorForTelemetry } from "~/shared/error-telemetry";
import { getRequestDataMetrics, recordRequestPhase } from "~/server/utils/request-metrics";
import { mcpFinancialApprovalErrorResult } from "~/server/utils/mcp-financial-handoff";
import { KRABICLAW_BUG_REPORT_URL, KRABICLAW_FEATURE_REQUEST_URL } from "~/shared/open-source";

const TENANT_CATALOG_FINGERPRINT = catalogFingerprint(MCP_PUBLIC_TOOLS);

// Worker execution context reports telemetry rejection without replaying a committed tool.
function logMcpEventDetached(
  event: Parameters<typeof getCloudflareWaitUntil>[0], db: D1Database | undefined, input: Parameters<typeof logMcpToolCallEvent>[1], ) {
  if (!db) return;
  const env = cloudflareEnv(event);
  const executionContext = event.context.mcpExecutionContext as { organizationId: string; locationId: string | null } | undefined;
  const attribution = input.method === "tools/call"
    ? { organizationId: executionContext?.organizationId ?? null, locationId: executionContext?.locationId ?? null }
    : {};
  const toolName = MCP_TOOLS.find(tool => tool.name === input.toolName)?.name ?? null;
  const logInput = {
    env, ...input, ...attribution, toolName, unknownToolName: input.unknownToolName ?? (input.toolName && !toolName ? input.toolName : null), cfRayId: input.cfRayId ?? (event.req.headers.get("cf-ray")) ?? null, sessionId: input.sessionId ?? (event.req.headers.get("mcp-session-id")) ?? null, protocolVersion: input.protocolVersion ?? event.req.headers.get('mcp-protocol-version'), catalogFingerprint: input.catalogFingerprint ?? TENANT_CATALOG_FINGERPRINT, };
  const logged = logMcpToolCallEvent(db, logInput);
  const waitUntil = getCloudflareWaitUntil(event);
  waitUntil!(logged);
}

const TENANT_AUTH_DESCRIPTION = "Connect KrabiClaw to continue.";
const TENANT_AUTH_REQUIRED_TEXT = "Authentication required: connect KrabiClaw to continue.";

function resourceUrl(baseUrl: string) {
  return `${baseUrl}/api/mcp`;
}

function resolveTenantToolMeta(toolName: string | null): McpToolMeta {
  const tool = toolName ? MCP_TOOLS.find((t) => t.name === toolName) : undefined;
  return { domain: tool?.domain ?? null, isMutating: isMcpMutatingTool(tool) };
}

const MCP_INSTRUCTIONS = `Manage the selected business. Read current state and preserve unrelated values. Read existing facts before asking questions. Ask only for missing required inputs needed for the requested action; leave unrelated optional settings unchanged. Never invent prices or booking details. Finish website changes and verify returned public URLs. When designing or improving a website: ensure high-impact hero imagery or video, proactively ask the owner for missing branding assets (logo, favicon, social card via set_media; colors and fonts via update_organization_settings), feature bookable offerings or places to stay directly on the homepage (product_grid) rather than bare location cards, include the host or founder's story and portrait on the about page, and add guest reviews (testimonial_grid) and FAQs (faq). Keep menu sections and order; experiences need bookings. Use revision and retry keys, and follow pagination. Publish or message only requested destinations. Payment reports are read-only; financial_action_required means the action remains incomplete. Report tool errors and partial outcomes plainly. Use only tools present in this client's catalog. A missing tool can mean the saved catalog needs refreshing or the selected business lacks access; do not invent a call or claim its action succeeded. Check the active business and permissions, and use https://krabiclaw.com/docs/refresh-krabiclaw-tools-in-chatgpt in a desktop browser when the client's catalog is stale. To report a KrabiClaw bug or request a feature, do not email KrabiClaw: give the user a prefilled ${KRABICLAW_BUG_REPORT_URL} link (fields title, surface, site, what_happened, expected, tool_error) or ${KRABICLAW_FEATURE_REQUEST_URL} link (title, need, today, site) to open. Issues are public; leave out guest names, contact details and payment data. Account, billing and private matters go to https://krabiclaw.com/help.`;

// H3's request context follows the SDK's original requestInfo into the factory.
interface McpFactoryContext {
  event: H3Event;
  mcpUser?: McpUserContext;
  cfEnv: ReturnType<typeof cloudflareEnv>;
  requestId: JsonRpcId | undefined;
  toolResult?: CallToolResult;
}

function factoryContextFrom(ctx: McpRequestContext): McpFactoryContext {
  if (!ctx.requestInfo) throw new ProtocolError(MCP_ERROR.internal, "Missing MCP request context.");
  const context = getEventContext({ req: ctx.requestInfo as H3Event['req'] }).mcpFactoryContext as McpFactoryContext | undefined;
  if (!context) throw new ProtocolError(MCP_ERROR.internal, "Missing MCP request context.");
  return context;
}

// A fresh SDK registry per exchange keeps schemas and execution together.
function createTenantMcpServer(ctx: McpRequestContext): McpServer {
  const mcpServer = new McpServer(
    { name: "krabiclaw-mcp", version: "phase-5" },
    { capabilities: { tools: {}, prompts: {} }, instructions: MCP_INSTRUCTIONS },
  );
  const server = mcpServer.server;
  const context = factoryContextFrom(ctx);
  const toolResult = context.toolResult;
  if (toolResult) {
    server.setRequestHandler("tools/call", async () => toolResult);
    return mcpServer;
  }

  for (const prompt of MCP_PROMPTS) {
    mcpServer.registerPrompt(prompt.name, {
      description: prompt.description,
      argsSchema: fromJsonSchema<Record<string, string>>({
        type: 'object',
        properties: Object.fromEntries(prompt.arguments.map(argument => [argument.name, {
          type: 'string', pattern: '\\S', description: argument.description,
        }])),
        required: prompt.arguments.filter(argument => argument.required).map(argument => argument.name),
        additionalProperties: false,
      }),
    }, (args) => {
      const rendered = renderMcpPrompt(prompt.name, args);
      return {
        description: rendered.description,
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: rendered.text } }],
      };
    });
  }

  for (const toolDef of MCP_PUBLIC_TOOLS) {
    const { event, mcpUser } = factoryContextFrom(ctx);
    mcpServer.registerTool(toolDef.name, {
      title: toolDef.title,
      description: toolDef.description,
      inputSchema: mcpToolInputSchema(event, toolDef, mcpUser),
      outputSchema: fromJsonSchema<Record<string, unknown>>(toolDef.outputSchema as JsonSchemaType),
      annotations: toolDef.annotations,
      _meta: {
        securitySchemes: toolDef.securitySchemes,
        'krabiclaw/toolInfo': { domain: toolDef.domain, minimumRole: toolDef.minimumRole },
        ...(toolDef.fileParams?.length ? { 'openai/fileParams': toolDef.fileParams } : {}),
      },
    }, async (rawArgs) => {
    const { event, mcpUser, cfEnv, requestId } = factoryContextFrom(ctx);
    if (!mcpUser) throw new ProtocolError(MCP_ERROR.internal, "Missing authenticated MCP request context.");
    const toolName = toolDef.name;
    const toolStartedAt = Date.now();

    const authStartedAt = performance.now();
    // requireMcpUser already ran once up front in the route handler (this is
    // that same resolved user, not a second auth check).
    recordRequestPhase(event, "mcp_auth", authStartedAt);
    const executionStartedAt = performance.now();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;
    try {
      result = await executeMcpToolCall(event, toolName, rawArgs, mcpUser);
    } catch (toolError) {
      recordRequestPhase(event, "mcp_execute", executionStartedAt);
      const mcpErr = asMcpError(toolError);
      console.error({
        event: "mcp_tool_failed", tool: toolDef?.name ?? null, request_id: requestId ?? null,
        ray_id: event.req.headers.get("cf-ray"), duration_ms: Date.now() - toolStartedAt,
        error_code: mcpErr.code, error_kind: mcpErr.kind,
      });
      if (mcpErr.kind === "protocol") {
        // Unknown-tool and similar protocol-level failures become a real
        // JSON-RPC error, not a tool result. `toolError` carries our own
        // `.mcp`-tagged shape, which the SDK doesn't read — throw its own
        // ProtocolError so createMcpHandler maps the code/data correctly
        // instead of falling back to a generic internal error.
        throw new ProtocolError(mcpErr.code, mcpErr.message, mcpErr.data);
      }
      // Any other tool-execution failure (including a plain `throw new
      // Error(...)` from a business-rule guard, which asMcpError falls back
      // to classifying as kind:'transport') must still resolve as a
      // graceful isError:true CallToolResult, not a JSON-RPC error — MCP
      // clients can't act on a transport-level error mid-tool-call.
      const failure = mcpFinancialApprovalErrorResult(toolError, cfEnv.NUXT_PUBLIC_PLATFORM_DOMAIN, mcpErr.message)
        ?? mcpToolErrorResult(mcpErr.message, mcpErr.data, cfEnv.NUXT_PUBLIC_PLATFORM_DOMAIN);
      return failure;
    }

    recordRequestPhase(event, "mcp_execute", executionStartedAt);
    const isRender = isMcpRenderResponse(result);
    const failed = isRender && result.isError === true;

    const executionContext = event.context.mcpExecutionContext as { organizationId: string } | undefined;
    const resolvedOrganizationId = executionContext?.organizationId ?? null;

    // After any mutating tool call the site's caches are cleared before the
    // response: its public resource entries and the SSR HTML for every active
    // hostname and its subdomain, all through purgeOrganizationCaches. Awaited,
    // so a client that reads right after the mutation cannot see what it
    // replaced. A missing binding reaches the helper and fails there.
    let purgeFailure: string | null = null;
    if (isMcpMutatingTool(toolDef) && resolvedOrganizationId) {
      const env = cloudflareEnv(event);
      const cacheStartedAt = performance.now();
      // A refresh failure turns a successful write into a failed tool result.
      // An already failed operation keeps its original actionable error.
      try {
        await purgePublicResourceCacheNow({
          DB: env.db,
          ORGANIZATION_CACHE: env.ORGANIZATION_CACHE,
          NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN: env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN,
        }, resolvedOrganizationId);
      } catch (purgeError) {
        console.error({ event: "mcp_public_cache_purge_failed", tool: toolName, organization_id: resolvedOrganizationId, request_id: requestId, error: describeErrorForTelemetry(purgeError) });
        purgeFailure = "Change saved; public website refresh failed";
      } finally {
        recordRequestPhase(event, "mcp_cache_purge", cacheStartedAt);
      }
    }
    if (purgeFailure && !failed) return mcpToolErrorResult(purgeFailure, { status: 502, code: "PUBLIC_SITE_REFRESH_FAILED", committed: true, organization_id: resolvedOrganizationId });
    const structuredJson = JSON.stringify(isRender ? result.structuredContent : result);
    const structuredContent = JSON.parse(structuredJson);
    const modelText = isRender && result.modelText ? result.modelText : structuredJson;
    const response = {
      isError: failed, ...(failed ? {} : { structuredContent }), content: [{ type: "text" as const, text: failed ? structuredJson : modelText }],
      ...(isRender && result.privateMeta ? { _meta: result.privateMeta } : {}),
    };
    return response;
  });
  }

  server.setRequestHandler("tools/list", async () => {
    const { event, mcpUser, cfEnv, requestId } = factoryContextFrom(ctx);
    if (!mcpUser) throw new ProtocolError(MCP_ERROR.internal, "Missing authenticated MCP request context.");
    // organization_id is a KrabiClaw-specific extension for site-scoped tool
    // discovery — not part of the MCP spec's ListToolsRequestParams (only
    // cursor/_meta). @modelcontextprotocol/server validates tools/list
    // params against the spec's schema and silently drops unrecognized
    // properties, so a client-supplied params.organization_id never reaches this
    // handler (confirmed empirically: request.params arrives as {}). It has
    // to travel outside the validated params object — a request header,
    // which the SDK doesn't touch — instead.
    const organizationIdHeader = event.req.headers.get("x-krabiclaw-organization-id");
    const hasOrganizationIdParam = organizationIdHeader !== null;
    const organizationId = organizationIdHeader?.trim() || null;
    const organizationCtx = organizationId ? await getVisibleOrganizationContext(event, organizationId) : null;

    const visibleSurfaceTools = MCP_PUBLIC_TOOLS;

    const entitlementKeys = organizationCtx
      ? [...new Set(visibleSurfaceTools.map((t) => t.requiredEntitlement).filter(Boolean) as string[])]
      : [];
    const activeEntitlements = organizationCtx
      ? await getActiveEntitlements(cfEnv, organizationCtx.organizationId, entitlementKeys)
      : new Set<string>();

    // The role gate is the permission matrix now, so resolve it once per tool
    // before filtering rather than awaiting inside a sync predicate.
    const roleAllowsTool = new Map<string, boolean>()
    if (hasOrganizationIdParam && organizationId && organizationCtx) {
      await Promise.all(visibleSurfaceTools.map(async (tool) => {
        roleAllowsTool.set(tool.name, await roleSatisfies(organizationCtx.organizationId, organizationCtx.role, tool.minimumRole))
      }))
    }

    const tools = visibleSurfaceTools.filter((tool) => {
      // Without a organization_id, return all tools so AI clients (e.g. ChatGPT) can discover
      // the full capability set on first connection. A supplied but inaccessible
      // site must fail closed instead of receiving the unscoped catalog.
      if (!hasOrganizationIdParam) return true;
      if (!organizationId) return false;
      if (!organizationCtx) return false;
      if (!roleAllowsTool.get(tool.name)) return false;
      if (tool.requiredEntitlement && !activeEntitlements.has(tool.requiredEntitlement)) return false;
      return true;
    }).map((tool) => {
      const baseTool = {
        name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, _meta: {
          securitySchemes: tool.securitySchemes, "krabiclaw/toolInfo": {
            domain: tool.domain, minimumRole: tool.minimumRole, }, ...(tool.fileParams?.length ? { "openai/fileParams": tool.fileParams } : {}), }, };
      return { ...baseTool, outputSchema: tool.outputSchema, annotations: tool.annotations, securitySchemes: tool.securitySchemes };
    });

    const domains = [...new Set(tools.map((tool) => tool._meta["krabiclaw/toolInfo"].domain))];
    logMcpEventDetached(event, cfEnv.DB, {
      organizationId: organizationCtx?.organizationId ?? null, userId: mcpUser.userId, requestId, method: "tools/list", arguments: { organization_id: organizationIdHeader },
      result: { count: tools.length, domains, instructions: MCP_INSTRUCTIONS, tools: tools.map(tool => ({
        name: tool.name, title: tool.title, description: tool.description,
        annotations: tool.annotations, securitySchemes: tool.securitySchemes,
        contract_fingerprint: catalogFingerprint([tool]),
      })) }, status: "success", httpStatus: 200, oauthClientId: mcpUser.oauthClientId ?? null, });

    // Our own McpToolDefinition types inputSchema/outputSchema as a loose
    // Record<string, unknown>; every entry in mcp-tools/*.ts is a real JSON
    // Schema object; yarn mcp:catalog checks the catalog snapshot, not schema
    // validity. These loose records are not provably assignable to the SDK's
    // stricter Tool type.
    return { tools, _meta: catalogMeta(MCP_PUBLIC_TOOLS) } as unknown as ListToolsResult;
  });


  return mcpServer;
}

// The SDK serves modern requests as JSON and legacy requests as native SSE.
const mcpHandler = createMcpHandler(createTenantMcpServer, { responseMode: "json" });

// Best-effort peek at the JSON-RPC method for logging and for the two methods
// (ping, notifications/initialized) that intentionally skip full token
// verification — mirrors the precedence createMcpHandler itself uses
// (body.method, then the Mcp-Method header) so this peek never disagrees
// with how the SDK actually routes the same parsed body.
function peekMcpMethod(event: H3Event, body: unknown): string | undefined {
  if (body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).method === "string") {
    return (body as Record<string, unknown>).method as string;
  }
  return event.req.headers.get("mcp-method") ?? undefined;
}

function peekMcpId(body: unknown): JsonRpcId | undefined {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const rawId = (body as Record<string, unknown>).id;
    if (typeof rawId === "string" || typeof rawId === "number" || rawId === null) return rawId;
  }
  return undefined;
}

export default defineHandler(async (event) => {
  if (!getCloudflareWaitUntil(event)) {
    throw new HTTPError({ statusCode: 503, statusMessage: "MCP requires the Worker execution context" });
  }
  const requestStartedAt = Date.now();
  const cfEnv = cloudflareEnv(event);
  const baseUrl = cfEnv.BETTER_AUTH_URL?.replace(/\/$/, "");
  if (!baseUrl) throw new HTTPError({ status: 500, statusText: "BETTER_AUTH_URL is required" });

  const allowedHostnames = [new URL(baseUrl).hostname, ...localhostAllowedHostnames()];
  const allowedOriginHostnames = [new URL(baseUrl).hostname, ...localhostAllowedOrigins()];
  // Nitro's TypedServerRequest structurally differs from the Workers-typed
  // Request these SDK helpers expect (an optional vs. required `cache`
  // field) despite both being the same object at runtime.
  const webRequest = event.req as unknown as Request;
  const rejectedHost = hostHeaderValidationResponse(webRequest, allowedHostnames);
  if (rejectedHost) return rejectedHost;
  const rejectedOrigin = originValidationResponse(webRequest, allowedOriginHostnames);
  if (rejectedOrigin) return rejectedOrigin;
  if (webRequest.method !== "POST") return mcpHandler.fetch(webRequest);

  const tenantAuthOptions = { audiences: [`${baseUrl}/api/mcp`], requiredScopes: ["tenant"] };
  const runtimeDeps = {
    authOptions: tenantAuthOptions, resourceUrl, authDescription: TENANT_AUTH_DESCRIPTION, authRequiredText: TENANT_AUTH_REQUIRED_TEXT, logEvent: (evt: typeof event, fields: Record<string, unknown>) =>
      logMcpEventDetached(evt, cfEnv.DB, fields as unknown as Parameters<typeof logMcpToolCallEvent>[1]), resolveToolMeta: resolveTenantToolMeta, };

  let requestId: JsonRpcId | undefined;
  let requestMethod: string | undefined;

  try {
    const body = await readBody(event);
    requestMethod = peekMcpMethod(event, body);
    requestId = peekMcpId(body);
    const respondWithToolResult = (toolResult: CallToolResult) => {
      event.context.mcpFactoryContext = { event, cfEnv, requestId, toolResult } satisfies McpFactoryContext;
      return mcpHandler.fetch(webRequest, { parsedBody: body });
    };
    // Return 401 with WWW-Authenticate before any protocol parsing so OAuth
    // clients (e.g. ChatGPT) can discover the authorization server on first touch.
    // Session-cookie requests (dashboard, E2E tests) have a Cookie header and skip this.
    const missingCredential = await resolveMissingMcpCredential(event, runtimeDeps, baseUrl, body);
    if (missingCredential.handled) {
      requestMethod = missingCredential.requestMethod;
      console.warn("[MCP_AUTH]", JSON.stringify({
        event: "credential_missing", ray_id: (event.req.headers.get("cf-ray")) ?? null, mcp_method: mcpTelemetryMethod(requestMethod), tool_name: MCP_TOOLS.find(tool => tool.name === missingCredential.requestToolName)?.name ?? null, }));
      return 'toolResult' in missingCredential
        ? await respondWithToolResult(missingCredential.toolResult)
        : missingCredential.response;
    }

    console.info('[MCP_REQUEST]', JSON.stringify({
      event: 'mcp_request_started', request_id: getRequestDataMetrics(event).requestId,
      method: mcpTelemetryMethod(requestMethod),
      ray_id: event.req.headers.get('cf-ray'),
    }));

    // `ping` and `notifications/initialized` are intentionally unauthenticated
    // beyond the credential-presence check above: MCP clients use `ping` as a
    // liveness check before the OAuth handshake completes, and
    // `notifications/initialized` carries no business context to authorize.
    const skipTokenVerification = requestMethod === "ping" || requestMethod === "notifications/initialized";
    let mcpUser: McpUserContext | undefined;
    if (!skipTokenVerification) {
      try {
        mcpUser = await requireMcpUser(event, tenantAuthOptions);
      } catch (error) {
        const mcpError = asMcpError(error);
        const isToolCall = requestMethod === "tools/call";
        if (mcpError.kind === "auth" || mcpAuthChallengeFromError(error)) {
          const authStatus = mcpError.kind === "forbidden" ? 403 : 401;
          const authChallenge = buildMcpAuthChallengeForError(error, {
            resourceUrl: resourceUrl(baseUrl), defaultDescription: TENANT_AUTH_DESCRIPTION, });
          logMcpEventDetached(event, cfEnv.DB, {
            requestId: null, method: requestMethod ?? "unknown", status: "auth_required", errorCode: mcpError.code, errorMessage: describeMcpAuthTelemetryError(error), httpStatus: isToolCall ? 200 : authStatus, });
          if (isToolCall) return await respondWithToolResult(mcpAuthRequiredResult({ challenge: authChallenge, message: TENANT_AUTH_REQUIRED_TEXT }));
          event.res.status = authStatus;
          setMcpAuthChallenge(event, authChallenge);
          return mcpFailure(requestId, mcpError);
        }
        if (mcpError.kind === "forbidden" && isToolCall) {
          return await respondWithToolResult(mcpToolErrorResult(mcpError.message));
        }
        const status = mcpError.kind === "forbidden" ? 403 : 500;
        if (status >= 500) console.error(error instanceof Error ? error.stack ?? error.message : error);
        event.res.status = status;
        return mcpFailure(requestId, mcpError);
      }
    }

    event.context.mcpFactoryContext = { event, mcpUser, cfEnv, requestId } satisfies McpFactoryContext;
    const response = await mcpHandler.fetch(webRequest, { parsedBody: body });
    if (requestMethod === 'tools/call') {
      type Wire = { id?: JsonRpcId; result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> }; error?: { code: number; message: string } };
      let wire: Wire | undefined;
      const copy = response.clone();
      if (copy.headers.get('content-type')?.includes('text/event-stream')) {
        createParser({ onEvent: ({ data }) => {
          const message = JSON.parse(data) as Wire;
          if (message.id === requestId && (message.result || message.error)) wire = message;
        }, onError: error => { throw error } }).feed(await copy.text());
      } else wire = await copy.json() as Wire;
      if (!wire) throw new Error('MCP response has no terminal tool result');
      const params = (body as { params?: { name?: string; arguments?: unknown; _meta?: unknown } }).params;
      const toolName = params?.name ?? '';
      const tool = MCP_TOOLS.find(entry => entry.name === toolName);
      const failed = Boolean(wire.error || wire.result?.isError);
      logMcpEventDetached(event, cfEnv.DB, {
        userId: mcpUser?.userId, requestId, method: 'tools/call', toolName,
        toolDomain: tool?.domain ?? null, isMutating: isMcpMutatingTool(tool),
        arguments: params?.arguments ?? {},
        result: wire.result ?? wire.error, status: failed ? 'error' : 'success',
        errorMessage: wire.error?.message ?? (failed ? wire.result?.content?.filter(entry => entry.type === 'text').map(entry => entry.text).join('\n') : null),
        httpStatus: response.status, jsonrpcErrorCode: wire.error?.code,
        jsonrpcErrorMessage: wire.error?.message, oauthClientId: mcpUser?.oauthClientId ?? null,
        durationMs: Date.now() - requestStartedAt,
      });
    }
    return response;
  } finally {
    console.info('[MCP_REQUEST]', JSON.stringify({
      event: 'mcp_request_finished', request_id: getRequestDataMetrics(event).requestId,
      rpc_id: requestId ?? null, method: mcpTelemetryMethod(requestMethod),
      ray_id: event.req.headers.get('cf-ray'), duration_ms: Date.now() - requestStartedAt,
    }));
  }
});
