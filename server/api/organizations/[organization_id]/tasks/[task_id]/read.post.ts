import { defineHandler } from 'nitro'
import { taskReadResponse } from '~/server/utils/task-route'

// Installed iOS posts this request when opening the same task sheet.
export default defineHandler(taskReadResponse)
