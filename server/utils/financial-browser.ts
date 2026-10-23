import {HTTPError,type H3Event} from 'nitro'
/** Financial approvals are authenticated browser actions, never model-confirm booleans. */
export function requireFinancialBrowserOrigin(event:H3Event):void {
 const origin=event.req.headers.get('origin')
 if(!origin || origin!==new URL(event.req.url).origin)throw new HTTPError({statusCode:403,statusMessage:'Financial approval requires a same-origin authenticated browser request'})
}

/**
 * The same approval from the iPhone app as well: a Better Auth bearer session
 * with no cookie. A cross-site page cannot send an Authorization header without
 * a CORS preflight KrabiClaw never grants, so such a request is not one a
 * browser was tricked into; every cookie request keeps the same-origin check.
 */
export function requireFinancialBrowserOrAppRequest(event:H3Event):void {
 if(/^Bearer\s+\S/u.test(event.req.headers.get('authorization')??'') && !event.req.headers.get('cookie'))return
 requireFinancialBrowserOrigin(event)
}
