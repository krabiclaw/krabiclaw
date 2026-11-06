import {defineHandler,HTTPError} from 'nitro'
import {cloudflareEnv,jsonResponse} from '~/server/utils/api-response'
import {getAuthSession} from '~/server/utils/auth'
import {queryAll} from '~/server/db'
import {organizationLogo} from '~/server/notifications/hero'
/** The organizations this account can manage, each with its mark, vertical and this account's role, for the Organizations list under Account settings. */
export default defineHandler(async event=>{
 const env=cloudflareEnv(event),session=await getAuthSession(event,env)
 if(!session)throw new HTTPError({statusCode:401,statusMessage:'Sign in to view your organizations'})
 const rows=await queryAll<{id:string;slug:string;name:string;vertical:string;role:string}>(env.DB,'SELECT o.id,o.slug,o.name,o.vertical,m.role FROM member m JOIN organization o ON o.id=m.organizationId WHERE m.userId=? ORDER BY o.name',[session.user.id])
 const organizations=await Promise.all(rows.map(async row=>({...row,imageUrl:await organizationLogo(env.DB,row.id)})))
 return jsonResponse({organizations},{headers:{'cache-control':'private, no-store'}})
})
