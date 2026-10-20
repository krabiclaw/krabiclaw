import {defineHandler,HTTPError} from 'nitro'
import {getQuery} from 'nitro/h3'
import {getDashboardContext} from '~/server/utils/dashboard-context'
import {jsonResponse} from '~/server/utils/api-response'
import {authorizePayments} from '~/server/domain/payments'
import {queryFirst} from '~/server/db'
import {paymentsStripe} from '~/server/utils/stripe-connect'
export default defineHandler(async event=>{
 const {env,db,organization,userId}=await getDashboardContext(event,{})
 await authorizePayments({organizationId:organization.id,userId,role:organization.role},'refund')
 const id=getQuery(event).id
 if(typeof id!=='string') throw new HTTPError({statusCode:400,statusMessage:'Authorization ID required'})
 const approval=await queryFirst<{id:string;action:string;amount:number|null;note:string|null;payment_id:string;expires_at:string;currency:string;subject_type:string;subject_id:string|null;stripe_account_id:string;stripe_charge_id:string|null;livemode:number}>(db,`SELECT a.id,a.action,a.amount,a.note,a.payment_id,a.expires_at,p.currency,p.subject_type,p.subject_id,p.stripe_account_id,p.stripe_charge_id,p.livemode FROM payment_authorizations a JOIN payments p ON p.id=a.payment_id WHERE a.id=? AND a.organization_id=? AND a.user_id=? AND a.expires_at>? AND a.consumed_at IS NULL`,[id,organization.id,userId,new Date().toISOString()])
 if(!approval) throw new HTTPError({statusCode:404,statusMessage:'Refund authorization is unavailable'})
 const {stripe_account_id,stripe_charge_id,livemode,...row}=approval
 if(row.amount!==null) return jsonResponse(row)
 // A full-remaining refund returns whatever Stripe still holds, read from the charge itself.
 if(!stripe_charge_id) throw new HTTPError({statusCode:409,statusMessage:'Payment has no captured provider object'})
 const charge=await paymentsStripe(env,Boolean(livemode)).charges.retrieve(stripe_charge_id,{},{stripeAccount:stripe_account_id})
 if(charge.currency.toUpperCase()!==row.currency) throw new Error('Stripe charge currency does not match the payment')
 return jsonResponse({...row,amount:charge.amount-charge.amount_refunded})
})
