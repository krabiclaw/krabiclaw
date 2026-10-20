import { jsonResponse } from '~/server/utils/api-response'
import { ChangelogFetchError, getRecentChanges, parseChangelogLimitQuery } from '~/server/utils/changelog'

export default defineHandler(async (event) => {
  try {
    const query = getQuery(event)
    let prLimit: number
    try {
      prLimit = parseChangelogLimitQuery(query.limit)
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      return jsonResponse(
        { error: error.message }, { status: 400 }, )
    }

    const env = cloudflareEnv(event)
    const githubToken = env.GITHUB_TOKEN

    if (!githubToken) {
      return jsonResponse({ error: 'GITHUB_TOKEN not configured' }, { status: 500 })
    }

    return jsonResponse(await getRecentChanges({ githubToken, limit: prLimit }))
  } catch (error) {
    console.error('Failed to generate changelog:', error)
    if (error instanceof ChangelogFetchError) {
      return jsonResponse({ error: error.message }, { status: error.statusCode })
    }
    return jsonResponse({ error: 'Failed to generate changelog' }, { status: 500 })
  }
})
import { defineHandler } from 'nitro';
import { getQuery } from 'nitro/h3';
