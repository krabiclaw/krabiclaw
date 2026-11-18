import { defineHandler } from 'nitro'
import { taskReadResponse } from '~/server/utils/task-route'

export default defineHandler(taskReadResponse)
