export interface AppReturnTarget {
  redirect?: string
  plan?: string
}

export function validatedInternalPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined
  try {
    const resolved = new URL(value, 'https://krabiclaw.internal')
    return resolved.origin === 'https://krabiclaw.internal'
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : undefined
  } catch {
    return undefined
  }
}

export function buildPostLoginUrl(target: AppReturnTarget = {}): string {
  const redirect = validatedInternalPath(target.redirect)
  const query = new URLSearchParams()
  if (redirect) query.set('redirect', redirect)
  if (target.plan) query.set('plan', target.plan)
  return query.size ? `/api/post-login?${query}` : '/api/post-login'
}

export function buildLoginUrl(target: AppReturnTarget = {}): string {
  const redirect = validatedInternalPath(target.redirect)
  return redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : '/login'
}

export function isDashboardAppPath(path: string): boolean {
  return path === '/dashboard/app'
    || path.startsWith('/dashboard/app/')
    || path.startsWith('/dashboard/app?')
    || path.startsWith('/dashboard/app#')
}

export function resolveDashboardAppTarget(orgDestination: string, appPath: string): string {
  if (!isDashboardAppPath(appPath)) return appPath
  if (orgDestination.startsWith('/dashboard/account/')) {
    return orgDestination
  }
  const remainder = appPath.slice('/dashboard/app'.length)
  if (!remainder || remainder === '/') return orgDestination
  if (remainder.startsWith('/') || remainder.startsWith('?') || remainder.startsWith('#')) {
    return `${orgDestination}${remainder}`
  }
  return `${orgDestination}/${remainder}`
}

