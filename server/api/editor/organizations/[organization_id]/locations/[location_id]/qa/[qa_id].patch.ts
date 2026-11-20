import { defineHandler } from 'nitro'
import { saveDashboardQa } from '~/server/utils/dashboard-editor-resources'

export default defineHandler(saveDashboardQa)
