import {defineHandler,HTTPError} from 'nitro'
import {getDashboardContext} from '~/server/utils/dashboard-context'
import {authorizePayments} from '~/server/domain/payments'
import {getStripeConnectedAccount,paymentsStripe} from '~/server/utils/stripe-connect'
import {jsonResponse} from '~/server/utils/api-response'
import {requireFinancialBrowserOrAppRequest} from '~/server/utils/financial-browser'
export default defineHandler(async event=>{
 requireFinancialBrowserOrAppRequest(event)
 const {env,db,organization,userId}=await getDashboardContext(event,{})
 await authorizePayments({organizationId:organization.id,userId,role:organization.role},'integration')
 const account=await getStripeConnectedAccount(db,organization.id)
 if(!account?.stripeAccountId)throw new HTTPError({statusCode:409,statusMessage:'Scoped Stripe account is unavailable',data:{code:'CONNECT_NOT_STARTED',field:'account.stripeAccountId'}})
 const stripe=paymentsStripe(env,account.livemode)
 try {
  const native=await stripe.v2.core.accounts.retrieve(account.stripeAccountId)
  if(native.dashboard!=='express'||native.livemode!==account.livemode)throw new HTTPError({statusCode:409,statusMessage:'Express Dashboard financial scope mismatch',data:{code:'CONNECT_DASHBOARD_SCOPE_INVALID',field:'account.dashboard'}})
  const link=await stripe.accounts.createLoginLink(account.stripeAccountId)
  if (!link.url || new URL(link.url).protocol !== 'https:') throw new HTTPError({statusCode:502,statusMessage:'Stripe returned an invalid dashboard URL',data:{code:'CONNECT_DASHBOARD_INVALID',field:'url'}})
  return jsonResponse({url:link.url})
 } catch(error) {
  if(error instanceof HTTPError)throw error
  throw new HTTPError({statusCode:502,statusMessage:'Stripe Express Dashboard could not be opened',data:{code:'CONNECT_DASHBOARD_FAILED',field:'url'},cause:error})
 }
})
