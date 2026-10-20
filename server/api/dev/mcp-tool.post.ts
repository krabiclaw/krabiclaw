import { HTTPError, defineHandler  } from 'nitro'
import { assertDevRouteAllowed } from '~/server/utils/dev-route-auth'
import { executeMcpToolCall, getMcpTool, mcpToolInputSchema } from '~/server/utils/mcp-tools'
import { isMcpRenderResponse } from '~/server/utils/mcp-render'

export default defineHandler(async (event) => {
  assertDevRouteAllowed(event)

  const body = await readBody(event) as {
    organizationId: string
    toolName: string
    input: Record<string, unknown>
  }

  const rawArguments = { organization_id: body.organizationId, ...body.input }
  const tool = getMcpTool(body.toolName)
  if (!tool) throw new HTTPError({ statusCode: 404, message: 'Unknown tool' })
  const parsed = await mcpToolInputSchema(event, tool)['~standard'].validate(rawArguments)
  if (parsed.issues) throw new HTTPError({ statusCode: 400, message: parsed.issues.map(issue => issue.message).join('; ') })
  const result = await executeMcpToolCall(event, body.toolName, parsed.value)

  // Unwrap structured MCP responses — tests care about the payload, not fallback text.
  if (isMcpRenderResponse(result)) {
    return { result: result.structuredContent }
  }

  return { result }
})
import { readBody } from 'nitro/h3';
