import { rolesAllowing, workspaceOperationsRoles } from '~/utils/organization-access'
import {defineHandler,HTTPError} from 'nitro'
import {getQuery} from 'nitro/h3'
import {cloudflareEnv,jsonResponse} from '~/server/utils/api-response'
import {getAuthSession} from '~/server/utils/auth'
import {queryAll} from '~/server/db'
import {organizationLogo} from '~/server/notifications/hero'
const productRoles = new Set<string>([...rolesAllowing({ products: ['read'] }), ...rolesAllowing({ products: ['assigned'] })])
const kitchenRoles = new Set<string>(rolesAllowing({ menu: ['read'] }))
const operationsRoles = new Set<string>(workspaceOperationsRoles)
/** The organizations this account belongs to, each with its mark, vertical, default currency and this account's role: the Organizations list under Account settings and the iOS workspace switcher. */
export default defineHandler(async event=>{
 const env=cloudflareEnv(event),session=await getAuthSession(event,env)
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to view your organizations'})
 const activeOnly = getQuery(event).onboarding_status === 'active'
 const rows=await queryAll<{id:string;slug:string;name:string;vertical:string;default_currency:string;role:string}>(env.DB,'SELECT o.id,o.slug,o.name,o.vertical,o.default_currency,m.role FROM member m JOIN organization o ON o.id=m.organizationId WHERE m.userId=? AND (? = 0 OR o.onboarding_status = ?) ORDER BY o.name',[session.user.id, Number(activeOnly), 'active'])
 const organizations=await Promise.all(rows.map(async row=>{
   const roles = row.role.split(',').map(value => value.trim())
   const catalog_access = roles.some(role => productRoles.has(role)) ? 'products' : roles.some(role => kitchenRoles.has(role)) ? 'menu' : 'none'
   return { ...row, catalog_access, operations_access: roles.some(role => operationsRoles.has(role)), image_url: await organizationLogo(env.DB,row.id) }
 }))
 return jsonResponse({organizations},{headers:{'cache-control':'private, no-store'}})
})
