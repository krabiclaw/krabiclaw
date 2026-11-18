import { defineHandler } from 'nitro'
import { taskCloseResponse } from '~/server/utils/task-route'

export default defineHandler(event => taskCloseResponse(event, 'skipped'))
