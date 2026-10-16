import { KRABICLAW_REPOSITORY } from '../../shared/open-source.ts'

export const DEFAULT_CHANGELOG_LIMIT = 50
export const MAX_CHANGELOG_LIMIT = 100

export const CHANGE_TYPES = ['feat', 'fix', 'chore', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'other'] as const

export type ChangeType = (typeof CHANGE_TYPES)[number]

interface GitHubPullRequest {
  number: number
  title: string
  body: string | null
  user: {
    login: string
  }
  merged_at: string | null
  updated_at: string
  html_url: string
}

export interface RecentChange {
  number: number
  title: string
  body: string | null
  author: string
  mergedAt: string
  url: string
  type: ChangeType
  scope: string | null
  description: string
}

export interface RecentChanges {
  commits: Record<ChangeType, RecentChange[]>
  total: number
  lastUpdated: string | null
  limit: number
}

export class ChangelogFetchError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode: number = 500) {
    super(message)
    this.name = 'ChangelogFetchError'
    this.statusCode = statusCode
  }
}

interface GetRecentChangesOptions {
  githubToken: string
  limit?: number
  fetchImpl?: typeof fetch
}

export function validateChangelogLimit(limit: unknown): number {
  if (limit === undefined) return DEFAULT_CHANGELOG_LIMIT
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_CHANGELOG_LIMIT) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_CHANGELOG_LIMIT}.`)
  }
  return limit
}

export function parseChangelogLimitQuery(limit: unknown): number {
  if (limit === undefined) return validateChangelogLimit(undefined)
  if (typeof limit !== 'string' || !/^\d+$/.test(limit)) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_CHANGELOG_LIMIT}.`)
  }
  return validateChangelogLimit(Number(limit))
}

function emptyCategories(): Record<ChangeType, RecentChange[]> {
  return {
    feat: [],
    fix: [],
    chore: [],
    docs: [],
    style: [],
    refactor: [],
    perf: [],
    test: [],
    build: [],
    ci: [],
    other: [],
  }
}

function categorizePullRequests(pullRequests: GitHubPullRequest[]): Record<ChangeType, RecentChange[]> {
  const categorized = emptyCategories()

  for (const pullRequest of pullRequests) {
    const match = pullRequest.title.match(/^(feat|fix|chore|docs|style|refactor|perf|test|build|ci)(\([^)]+\))?!?:\s*(.+)/)
    const type = (match?.[1] ?? 'other') as ChangeType
    categorized[type].push({
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body,
      author: pullRequest.user.login,
      mergedAt: pullRequest.merged_at!,
      url: pullRequest.html_url,
      type,
      scope: match?.[2]?.replace(/[()]/g, '') || null,
      description: match?.[3] || pullRequest.title,
    })
  }

  return categorized
}

export async function getRecentChanges(options: GetRecentChangesOptions): Promise<RecentChanges> {
  const limit = validateChangelogLimit(options.limit)
  const githubToken = options.githubToken.trim()
  if (!githubToken) throw new ChangelogFetchError('GITHUB_TOKEN not configured')

  const fetchImpl = options.fetchImpl ?? fetch
  const allMergedPullRequests: GitHubPullRequest[] = []
  const perPage = 100
  let page = 1

  while (true) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${KRABICLAW_REPOSITORY}/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )

    if (!response.ok) {
      throw new ChangelogFetchError(`GitHub API error: ${response.status}`)
    }

    const pullRequests = (await response.json()) as GitHubPullRequest[]
    if (pullRequests.length === 0) break
    allMergedPullRequests.push(...pullRequests.filter(pullRequest => pullRequest.merged_at !== null))

    if (pullRequests.length < perPage) break

    // GitHub only lets this endpoint sort closed PRs by updated_at, not merged_at.
    // A merge updates the PR, so merged_at cannot be later than updated_at. Once
    // the oldest updated_at on this page is at or before our current merged_at
    // cutoff, every later page is provably unable to contain a newer merge. Until
    // then, keep paging even if we already collected `limit` merged PRs.
    if (allMergedPullRequests.length >= limit) {
      const mergedAtCutoff = [...allMergedPullRequests]
        .sort((a, b) => new Date(b.merged_at!).getTime() - new Date(a.merged_at!).getTime())
        .at(limit - 1)?.merged_at
      const oldestUpdatedAt = pullRequests.at(-1)?.updated_at
      if (
        mergedAtCutoff
        && oldestUpdatedAt
        && new Date(oldestUpdatedAt).getTime() <= new Date(mergedAtCutoff).getTime()
      ) {
        break
      }
    }

    page += 1
  }

  const mergedPullRequests = allMergedPullRequests
    .sort((a, b) => new Date(b.merged_at!).getTime() - new Date(a.merged_at!).getTime())
    .slice(0, limit)

  return {
    commits: categorizePullRequests(mergedPullRequests),
    total: mergedPullRequests.length,
    lastUpdated: mergedPullRequests[0]?.merged_at ?? null,
    limit,
  }
}
