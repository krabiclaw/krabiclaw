import { memberAccessPrincipal } from '~/server/utils/member-access'
import { closeTask, createTask, listTaskAssignees, listTasks, parseTaskListQuery, taskViewer, updateTask, TASK_KINDS } from '~/server/domain/tasks'
import { acceptOpportunity, deferOpportunity, dismissOpportunity, listOpportunities } from '~/server/domain/opportunities'
import { MAX_IMAGE_BYTES } from '~/server/utils/media-mime'
import { HTTPError } from 'nitro'
import { chatgptFileInput, organizationTool, type McpToolDefinition } from './shared'
import { NOT_HANDLED, optionalString, requiredString, resolveUserUploadedMediaFile, toolFileReference, type McpExecutorContext } from './execution'

const text = { type: 'string' }, nullableText = { type: ['string', 'null'] }
const instant = { type: 'string', format: 'date-time', description: 'An instant with Z or a numeric offset.' }
const person = { type: 'object', properties: { type: { type: 'string', enum: ['member'] }, id: text, name: text, initial: text, you: { type: 'boolean' } }, required: ['type', 'id', 'name', 'initial', 'you'] }
export const TASK_VIEW_SCHEMA = { type: 'object', properties: {
  id: text, kind: { type: 'string', enum: [...TASK_KINDS] }, status: { type: 'string', enum: ['open', 'done', 'skipped', 'cancelled'] }, version: { type: 'integer' },
  face: { type: 'string', enum: ['photo', 'compact'] }, tag: nullableText, imageUrl: nullableText, avatar: { type: ['object', 'null'] },
  reservation: {
    type: 'object',
    properties: {
      dateLabel: text, groupHeadline: text, homeName: text, statusLabel: text, guestImageUrl: nullableText,
      conversation: { anyOf: [
        { type: 'object', properties: { label: text, description: nullableText, to: text }, required: ['label', 'description', 'to'] },
        { type: 'null' },
      ] },
    },
    required: ['dateLabel', 'groupHeadline', 'homeName', 'statusLabel', 'guestImageUrl', 'conversation'],
  },
  statusLine: nullableText, title: text, when: nullableText, detail: nullableText, error: nullableText, note: nullableText,
  person: { anyOf: [person, { type: 'null' }] }, assignee: { anyOf: [person, { type: 'null' }] }, sheet: { type: 'object' },
  startsAt: nullableText, dueAt: nullableText, timezone: text, notes: nullableText,
  outcome: { type: ['object', 'null'] }, action: { type: ['object', 'null'] }, path: nullableText,
  productId: nullableText, locationId: nullableText, stayId: nullableText, requestId: nullableText,
  can: { type: 'object', properties: { complete: { type: 'boolean' }, skip: { type: 'boolean' }, reopen: { type: 'boolean' }, assign: { type: 'boolean' }, edit: { type: 'boolean' } }, required: ['complete', 'skip', 'reopen', 'assign', 'edit'] },
}, required: ['id', 'kind', 'status', 'version', 'face', 'tag', 'imageUrl', 'avatar', 'statusLine', 'title', 'when', 'detail', 'error', 'note', 'person', 'assignee', 'sheet', 'startsAt', 'dueAt', 'timezone', 'notes', 'outcome', 'action', 'path', 'productId', 'locationId', 'stayId', 'requestId', 'can'] }
const task = TASK_VIEW_SCHEMA
const taskResult = { type: 'object', properties: { task }, required: ['task'] }
const opportunity = { type: 'object', properties: { id: text, statusLine: text, title: text, detail: text, icon: text, path: text, productId: nullableText, locationId: nullableText,
  requestId: { type: ['string', 'null'], description: 'The guest conversation a message opportunity is sent in.' },
  message: { type: ['string', 'null'], description: 'The message it pre-writes from the business’s own records. Review it, then send it with reply_to_guest in requestId’s conversation; nothing is sent until then.' } },
required: ['id', 'statusLine', 'title', 'detail', 'icon', 'path', 'productId', 'locationId', 'requestId', 'message'] }
const assignee = {
  assigned_member_id: { type: ['string', 'null'], description: 'A Better Auth member id from list_tasks assignees; null to unassign.' },
}

export const TASK_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'list_tasks', domain: 'tasks', minimumRole: 'member', description: 'Read Today or Upcoming as stored tasks: turnovers, guest questions awaiting a reply, scheduled messages that did not send, accepted opportunities and tasks people added. Today is open work starting or due today or earlier plus what was done today; Upcoming is later open work by day. A member sees the tasks given to them and the turnovers at homes they look after. assignees lists who a manager can give work to.',
    inputSchema: { range: { type: 'string', enum: ['today', 'upcoming'] }, assignee: { type: 'string', description: 'me, all, or a member id.' }, location_id: { ...text, minLength: 1 }, status: { type: 'string', enum: ['open', 'done', 'skipped', 'cancelled'] }, kind: { type: 'string', enum: [...TASK_KINDS] } },
    outputSchema: { type: 'object', properties: { sections: { type: 'array', items: { type: 'object', properties: { id: text, title: nullableText, subtitle: nullableText, tasks: { type: 'array', items: task } }, required: ['id', 'title', 'subtitle', 'tasks'] } }, assignees: { type: 'array', items: person }, resolvedAt: text }, required: ['sections', 'assignees', 'resolvedAt'] },
  }),
  organizationTool({ name: 'create_task', domain: 'tasks', minimumRole: 'admin', description: 'Create a task with optional dates and one assignee. Specify location_id when the product is offered at multiple locations. A new assignee may be notified according to their settings. Reuse idempotency_key only for the same request.',
    inputSchema: { title: { ...text, minLength: 1, maxLength: 200 }, notes: { ...text, maxLength: 5000 }, starts_at: instant, due_at: instant, ...assignee, product_id: { ...text, minLength: 1 }, location_id: { ...text, minLength: 1 }, idempotency_key: { ...text, minLength: 1, maxLength: 200 } }, required: ['title', 'idempotency_key'],
    outputSchema: taskResult,
  }),
  organizationTool({ name: 'update_task', domain: 'tasks', minimumRole: 'admin', description: 'Reassign, reschedule or edit the notes of an open task. Pass expected_version from list_tasks; a newer version is refused so another change is not overwritten. A new assignee is told.',
    inputSchema: { task_id: { ...text, minLength: 1 }, expected_version: { type: 'integer', minimum: 1 }, ...assignee, starts_at: { type: ['string', 'null'], format: 'date-time' }, due_at: { type: ['string', 'null'], format: 'date-time' }, notes: { type: ['string', 'null'], maxLength: 5000 }, title: { ...text, minLength: 1, maxLength: 200, description: 'Only for a task someone added or an accepted opportunity.' } }, required: ['task_id', 'expected_version'],
    outputSchema: taskResult,
  }),
  organizationTool({ name: 'complete_task', domain: 'tasks', minimumRole: 'member', description: 'Mark a task done, with what you found and an optional photo. A guest reply or a failed message is done when the reply goes out or the message is fixed, so it cannot be completed here.',
    inputSchema: { task_id: { ...text, minLength: 1 }, note: { ...text, maxLength: 5000 }, file: { ...chatgptFileInput, description: 'Optional photo of the finished work.' } }, required: ['task_id'], fileParams: ['file'],
    outputSchema: taskResult,
  }),
  organizationTool({ name: 'skip_task', domain: 'tasks', minimumRole: 'member', description: 'Skip or dismiss a task, optionally saying why. A dismissed guest question stays dismissed until the guest writes again.',
    inputSchema: { task_id: { ...text, minLength: 1 }, note: { ...text, maxLength: 5000 } }, required: ['task_id'],
    outputSchema: taskResult,
  }),
  organizationTool({ name: 'list_opportunities', domain: 'tasks', minimumRole: 'admin', description: 'List and save current opportunities such as drafts to finish, posts to share, calendar gaps and preparation to send a booked guest or client. Reports evidence it could not read. Use a returned ID to accept, dismiss or defer an opportunity.',
    inputSchema: { location_id: { ...text, minLength: 1 } },
    outputSchema: { type: 'object', properties: { opportunities: { type: 'array', items: opportunity }, issues: { type: 'array', items: text } }, required: ['opportunities', 'issues'] },
  }),
  organizationTool({ name: 'accept_opportunity', domain: 'tasks', minimumRole: 'admin', description: 'Take on an opportunity: it becomes a task, given to you and due today unless you say otherwise. Refused when what it was based on has changed; read list_opportunities again.',
    inputSchema: { opportunity_id: { ...text, minLength: 1 }, ...assignee, due_at: { type: ['string', 'null'], format: 'date-time' } }, required: ['opportunity_id'],
    outputSchema: taskResult,
  }),
  organizationTool({ name: 'dismiss_opportunity', domain: 'tasks', minimumRole: 'admin', description: 'Decline an opportunity, optionally saying why. It returns only when its evidence changes.',
    inputSchema: { opportunity_id: { ...text, minLength: 1 }, note: { ...text, minLength: 1, maxLength: 2000 } }, required: ['opportunity_id'],
    outputSchema: { type: 'object', properties: { opportunity: { type: 'object', properties: { id: text, status: { const: 'dismissed' } }, required: ['id', 'status'] } }, required: ['opportunity'] },
  }),
  organizationTool({ name: 'defer_opportunity', domain: 'tasks', minimumRole: 'admin', description: 'Set an opportunity aside until a time; it returns then if it still applies.',
    inputSchema: { opportunity_id: { ...text, minLength: 1 }, until: instant }, required: ['opportunity_id', 'until'],
    outputSchema: { type: 'object', properties: { opportunity: { type: 'object', properties: { id: text, availableAt: text }, required: ['id', 'availableAt'] } }, required: ['opportunity'] },
  }),
]

const assigneeBody = (args: Record<string, unknown>) => ({
  ...(args.assigned_member_id !== undefined ? { assignedMemberId: args.assigned_member_id } : {}),
})

export async function handleTaskTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  if (!TASK_TOOLS.some(tool => tool.name === toolName)) return NOT_HANDLED
  const { db, env } = organization
  const principal = memberAccessPrincipal(organization.membership, { env, event: ctx.event })
  switch (toolName) {
    case 'list_tasks': {
      const viewer = await taskViewer(db, principal)
      const query = parseTaskListQuery({ range: args.range, assignee: args.assignee, locationId: args.location_id, status: args.status, kind: args.kind })
      const [list, assignees] = await Promise.all([listTasks(db, viewer, query), listTaskAssignees(db, viewer)])
      return { ...list, assignees }
    }
    case 'create_task': {
      const result = await createTask(db, await taskViewer(db, principal), { title: args.title, notes: args.notes, startsAt: args.starts_at, dueAt: args.due_at, ...assigneeBody(args),
        productId: args.product_id, locationId: args.location_id, idempotencyKey: args.idempotency_key })
      return { task: result.task }
    }
    case 'update_task':
      return { task: await updateTask(db, await taskViewer(db, principal), requiredString(args, 'task_id'), { expectedVersion: args.expected_version, ...assigneeBody(args),
        ...(args.starts_at !== undefined ? { startsAt: args.starts_at } : {}), ...(args.due_at !== undefined ? { dueAt: args.due_at } : {}),
        ...(args.notes !== undefined ? { notes: args.notes } : {}), ...(args.title !== undefined ? { title: args.title } : {}) }) }
    case 'complete_task':
    case 'skip_task': {
      const file = toolName === 'complete_task' && args.file !== undefined ? toolFileReference(args.file, 'file') : null
      const photos = file ? await (async () => {
        const resolved = await resolveUserUploadedMediaFile(file, MAX_IMAGE_BYTES)
        if (resolved.kind !== 'image') throw new HTTPError({ statusCode: 422, statusMessage: 'A task accepts only photos', data: { code: 'INVALID_PHOTO', field: 'file' } })
        return [{ bytes: resolved.buffer, filename: resolved.filename }]
      })() : []
      return { task: await closeTask(db, await taskViewer(db, principal), requiredString(args, 'task_id'), { status: toolName === 'complete_task' ? 'done' : 'skipped', note: args.note, photos, env }) }
    }
    case 'list_opportunities': return await listOpportunities(db, principal, { locationId: optionalString(args, 'location_id') ?? undefined })
    case 'accept_opportunity': return { task: await acceptOpportunity(db, principal, requiredString(args, 'opportunity_id'), { ...assigneeBody(args), ...(args.due_at !== undefined ? { dueAt: args.due_at } : {}) }) }
    case 'dismiss_opportunity': return { opportunity: await dismissOpportunity(db, principal, requiredString(args, 'opportunity_id'), { note: args.note }) }
    case 'defer_opportunity': return { opportunity: await deferOpportunity(db, principal, requiredString(args, 'opportunity_id'), { until: args.until }) }
    default: return NOT_HANDLED
  }
}
