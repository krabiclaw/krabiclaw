import {defineHandler,HTTPError} from 'nitro'
import {cloudflareEnv,jsonResponse,readRequiredBody} from '~/server/utils/api-response'
import {ensureInteractionUser,getAuthSession} from '~/server/utils/auth'
import {queryFirst} from '~/server/db'
import {tokenHash,claimCheckoutReturn,buyerPaymentActivityPath} from '~/server/domain/payments/buyer'
import {requirePayment} from '~/server/domain/payments'
import {reconcilePaymentIntent} from '~/server/domain/payments/events'
import {createStripeClient} from '~/server/utils/stripe-client'
import {notifyPaymentFinancialEvent} from '~/server/domain/payments/notifications'
/** The browser came back from paying: Stripe is asked whether the intent succeeded before the purchase is attached to this buyer. */
export default defineHandler(async event=>{
 const env=cloudflareEnv(event),body=await readRequiredBody<{payment_id?:string;purchase_claim?:string}>(event)
 if(!body.payment_id || !body.purchase_claim || !/^[a-f0-9-]{72}$/u.test(body.purchase_claim))throw new HTTPError({statusCode:400,statusMessage:'Purchase return proof required'})
 const session=await getAuthSession(event,env)
 const proof=await queryFirst<{organization_id:string;stripe_payment_intent_id:string}>(env.DB,`SELECT p.organization_id,a.stripe_payment_intent_id FROM payment_claims c JOIN payments p ON p.id=c.payment_id JOIN payment_attempts a ON a.payment_id=p.id AND a.stripe_payment_intent_id IS NOT NULL WHERE c.token_hash=? AND c.payment_id=? ORDER BY a.created_at DESC LIMIT 1`,[await tokenHash(body.purchase_claim),body.payment_id])
 if(!proof)throw new HTTPError({statusCode:404,statusMessage:'Purchase return proof expired or already used'})
 if(!env.STRIPE_SECRET_KEY)throw new HTTPError({statusCode:503,statusMessage:'Stripe is unavailable'})
 const payment=await requirePayment(env.DB,proof.organization_id,body.payment_id),stripe=createStripeClient(env.STRIPE_SECRET_KEY, 'payments')
 const intent=await stripe.paymentIntents.retrieve(proof.stripe_payment_intent_id,{expand:['latest_charge']}, {stripeAccount:payment.stripe_account_id})
 if(intent.livemode!==Boolean(payment.livemode) || intent.metadata.krabiclaw_payment_id!==payment.id)throw new HTTPError({statusCode:409,statusMessage:'Stripe has not authenticated this purchase'})
 if(intent.status!=='succeeded')throw new HTTPError({statusCode:409,statusMessage:'Stripe has not authenticated a captured purchase'})
 await reconcilePaymentIntent(env.DB,stripe,payment,intent,env)
 const userId=session?.user.id??await ensureInteractionUser(event,env)
 const claimed=await claimCheckoutReturn(env.DB,userId,body.purchase_claim)
 const owned=await requirePayment(env.DB,proof.organization_id,payment.id)
 const charge=typeof intent.latest_charge==='string'?null:intent.latest_charge
 await notifyPaymentFinancialEvent(env.DB,stripe,env,owned,{kind:'payment_captured',nativeId:intent.id,status:intent.status,amount:intent.amount_received,email:charge?.billing_details.email??null})
 return jsonResponse({...claimed,activity_path:await buyerPaymentActivityPath(env.DB,userId,payment.id)})
})
