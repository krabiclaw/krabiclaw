import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, getQuery } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { queryFirst } from '~/server/db'
import { publicProductHosts } from '~/server/utils/public-provider'
export default defineHandler(async event=>{const organizationId=event.context.organizationId as string,slug=getRouterParam(event,'slug'),db=cloudflareEnv(event).DB;const product=await queryFirst<{id:string}>(db,'SELECT p.id FROM products p JOIN product_publications pub ON pub.product_id=p.id AND pub.organization_id=p.organization_id WHERE p.organization_id=? AND p.slug=? AND p.active=1 AND pub.published=1',[organizationId,slug]);if(!product)throw new HTTPError({statusCode:404,message:'Offering not found'});const query=getQuery(event);if (query.session_id !== undefined) throw new HTTPError({statusCode:400,message:'Use product_session_id to select a session'});return jsonResponse({hosts:await publicProductHosts(db,organizationId,product.id,query.product_session_id)})})
