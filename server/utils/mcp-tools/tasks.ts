import { memberAccessPrincipal } from '~/server/utils/member-access'
import { closeTask, createTask, listTaskAssignees, listTasks, parseTaskListQuery, taskViewer, updateTask, TASK_KINDS } from '~/server/domain/tasks'
import { listOpportunities } from '~/server/domain/opportunities'
import { MAX_IMAGE_BYTES } from '~/server/utils/media-mime'
import { HTTPError } from 'nitro'
import { chatgptFileInput, organizationTool, type McpToolDefinition } from './shared'
import { NOT_HANDLED, optionalString, requiredString, resolveUserUploadedMediaFile, toolFileReference, type McpExecutorContext } from './execution'

const text = { type: 'string' }, nullableText = { type: ['string', 'null'] }
const instant = { type: 'string', format: 'date-time', description: 'An instant with Z or a numeric offset.' }
const person = { type: 'object', properties: { type: { type: 'string', enum: ['member'] }, id: text, name: text, initial: text, you: { type: 'boolean' } }, required: ['type', 'id', 'name', 'initial', 'you'] }
export const TASK_VIEW_SCHEMA = { type: 'object', properties: {
  id: text, kind: { type: 'string', enum: [...TASK_KINDS] }, status: { type: 'string', enum: ['open', 'done', 'skipped', 'cancelled'] }, version: { type: 'integer' },
  face: { type: 'string', enum: ['photo', 'compact'] }, tag: nullableText, image_url: nullableText, avatar: { type: ['object', 'null'] },
  reservation: {
    type: 'object',
    properties: {
      date_label: text, headline: text, name: text, status_label: text, guest_image_url: nullableText,
      conversation: { anyOf: [
        { type: 'object', properties: { label: text, description: nullableText, to: text }, required: ['label', 'description', 'to'] },
        { type: 'null' },
      ] },
    },
    required: ['date_label', 'headline', 'name', 'status_label', 'guest_image_url', 'conversation'],
  },
  status_line: nullableText, title: text, when: nullableText, detail: nullableText, error: nullableText, note: nullableText,
  person: { anyOf: [person, { type: 'null' }] }, assignee: { anyOf: [person, { type: 'null' }] }, sheet: { type: 'object' },
  starts_at: nullableText, due_at: nullableText, timezone: text, notes: nullableText,
  outcome: { type: ['object', 'null'] }, action: { type: ['object', 'null'] }, path: nullableText,
  product_id: nullableText, location_id: nullableText, booking_id: nullableText, product_session_id: text, conversation_id: nullableText,
  can: { type: 'object', properties: { complete: { type: 'boolean' }, skip: { type: 'boolean' }, reopen: { type: 'boolean' }, assign: { type: 'boolean' }, edit: { type: 'boolean' } }, required: ['complete', 'skip', 'reopen', 'assign', 'edit'] },
}, required: ['id', 'kind', 'status', 'version', 'face', 'tag', 'image_url', 'avatar', 'status_line', 'title', 'when', 'detail', 'error', 'note', 'person', 'assignee', 'sheet', 'starts_at', 'due_at', 'timezone', 'notes', 'outcome', 'action', 'path', 'product_id', 'location_id', 'booking_id', 'conversation_id', 'can'] }
const task = TASK_VIEW_SCHEMA
const taskResult = { type: 'object', properties: { task }, required: ['task'] }
const opportunity = { type: 'object', properties: { id: text, status_line: text, title: text, detail: text, icon: text, path: text, product_id: nullableText, location_id: nullableText,
  conversation_id: { type: ['string', 'null'], description: 'The guest conversation a welcome is sent in; null for a setup item.' },
  message: { type: ['string', 'null'], description: 'The message it pre-writes from the business’s own records. Review it, then send it with send_message in conversation_id’s conversation; nothing is sent until then.' } },
  required: ['id', 'status_line', 'title', 'detail', 'icon', 'path', 'product_id', 'location_id', 'conversation_id', 'message'] }
const assignee = {
  assigned_member_id: { type: ['string', 'null'], description: 'A Better Auth member id from list_tasks assignees; null to unassign.' },
}

export const TASK_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'list_tasks', domain: 'tasks', minimumRole: 'member', description: 'Read Today or Upcoming as stored tasks: turnovers, booking decisions, scheduled messages that did not send and tasks people added. Today is open work starting or due today or earlier plus what was done today; Upcoming is later open work by day. A member sees the tasks given to them and the turnovers at homes they look after. assignees lists who a manager can give work to.',
    inputSchema: { range: { type: 'string', enum: ['today', 'upcoming'] }, assignee: { type: 'string', description: 'me, all, or a member id.' }, location_id: { ...text, minLength: 1 }, status: { type: 'string', enum: ['open', 'done', 'skipped', 'cancelled'] }, kind: { type: 'string', enum: [...TASK_KINDS] } },
    outputSchema: { type: 'object', properties: { sections: { type: 'array', items: { type: 'object', properties: { id: text, title: nullableText, subtitle: nullableText, tasks: { type: 'array', items: task } }, required: ['id', 'title', 'subtitle', 'tasks'] } }, assignees: { type: 'array', items: person }, resolved_at: text }, required: ['sections', 'assignees', 'resolved_at'] },
  }),
  organizationTool({ name: 'create_task', domain: 'tasks', minimumRole: 'admin', description: 'Create a task with optional dates and one assignee. Specify location_id when the product is offered at multiple locations. A new assignee may be notified according to their settings. Reuse idempotency_key only for the same request.',
    inputSchema: { title: { ...text, minLength: 1, maxLength: 200 }, notes: { ...text, maxLength: 5000 }, starts_at: instant, due_at: instant, ...assignee, product_id: { ...text, minLength: 1 }, location_id: { ...text, minLength: 1 }, idempotency_key: { ...text, minLength: 1, maxLength: 200 } }, required: ['title', 'idempotency_key'],
    outputSchema: taskResult,
  }),
  organizationTool({ name: 'update_task', domain: 'tasks', minimumRole: 'admin', description: 'Reassign, reschedule or edit the notes of an open task. Pass version from list_tasks; a newer version is refused so another change is not overwritten. A new assignee is told.',
    inputSchema: { task_id: { ...text, minLength: 1 }, version: { type: 'integer', minimum: 1 }, ...assignee, starts_at: { type: ['string', 'null'], format: 'date-time' }, due_at: { type: ['string', 'null'], format: 'date-time' }, notes: { type: ['string', 'null'], maxLength: 5000 }, title: { ...text, minLength: 1, maxLength: 200, description: 'Only for a task someone added.' } }, required: ['task_id', 'version'],
    outputSchema: taskResult,
  }),
  organizationTool({ name: 'complete_task', domain: 'tasks', minimumRole: 'member', description: 'Mark a task done, with what you found and an optional photo. Fix failed scheduled messages from their conversation.',
    inputSchema: { task_id: { ...text, minLength: 1 }, note: { ...text, maxLength: 5000 }, file: { ...chatgptFileInput, description: 'Optional photo of the finished work.' } }, required: ['task_id'], fileParams: ['file'],
    outputSchema: taskResult,
  }),
  organizationTool({ name: 'skip_task', domain: 'tasks', minimumRole: 'member', description: 'Skip or dismiss a task, optionally saying why.',
    inputSchema: { task_id: { ...text, minLength: 1 }, note: { ...text, maxLength: 5000 } }, required: ['task_id'],
    outputSchema: taskResult,
  }),
  organizationTool({ name: 'list_opportunities', domain: 'tasks', minimumRole: 'admin', description: 'List what Today suggests: setup the business has not finished (connecting payments, adding a first offering, a price for each experience without one); and a welcome for each booked guest or client who has not heard from the business since booking. Each one goes away when that setup is done or the business messages the guest.',
    inputSchema: { location_id: { ...text, minLength: 1 } },
    outputSchema: { type: 'object', properties: { opportunities: { type: 'array', items: opportunity } }, required: ['opportunities'] },
  }),
]

export async function handleTaskTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  if (!TASK_TOOLS.some(tool => tool.name === toolName)) return NOT_HANDLED
  const { db, env } = organization
  const principal = memberAccessPrincipal(organization.membership, { env, event: ctx.event })
  switch (toolName) {
    case 'list_tasks': {
      const viewer = await taskViewer(principal)
      const query = parseTaskListQuery(args)
      const [list, assignees] = await Promise.all([listTasks(db, viewer, query), listTaskAssignees(db, viewer)])
      return { ...list, assignees }
    }
    case 'create_task': {
      const result = await createTask(db, await taskViewer(principal), args)
      return { task: result.task }
    }
    case 'update_task':
      return { task: await updateTask(db, await taskViewer(principal), requiredString(args, 'task_id'), args) }
    case 'complete_task':
    case 'skip_task': {
      const file = toolName === 'complete_task' && args.file !== undefined ? toolFileReference(args.file, 'file') : null
      const photos = file ? await (async () => {
        const resolved = await resolveUserUploadedMediaFile(file, MAX_IMAGE_BYTES)
        if (resolved.kind !== 'image') throw new HTTPError({ statusCode: 422, statusMessage: 'A task accepts only photos', data: { code: 'INVALID_PHOTO', field: 'file' } })
        return [{ bytes: resolved.buffer, filename: resolved.filename }]
      })() : []
      return { task: await closeTask(db, await taskViewer(principal), requiredString(args, 'task_id'), { status: toolName === 'complete_task' ? 'done' : 'skipped', note: args.note, photos, env }) }
    }
    case 'list_opportunities': return await listOpportunities(db, principal, { locationId: optionalString(args, 'location_id') ?? undefined })
    default: return NOT_HANDLED
  }
}
