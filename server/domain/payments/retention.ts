import {executeBatch,queryFirst,type DbClient} from '~/server/db'
/** Called only by the existing authorized tenant deletion orchestration. */
export async function retainPaymentsForTenantDeletion(db:DbClient,organizationId:string) {
 if(await queryFirst(db,`SELECT 1 FROM payment_servicing_tenants retained JOIN (SELECT organization_id,stripe_account_id,livemode FROM payments WHERE organization_id=? UNION SELECT organization_id,stripe_account_id,livemode FROM stripe_connected_accounts WHERE organization_id=? AND stripe_account_id IS NOT NULL) owned ON owned.stripe_account_id=retained.stripe_account_id AND owned.livemode=retained.livemode WHERE retained.organization_id<>owned.organization_id LIMIT 1`,[organizationId,organizationId]))throw new Error('Stripe connected account has conflicting Payments servicing ownership')
 const now=new Date().toISOString()
 await executeBatch(db,[
  {query:`INSERT INTO payment_servicing_tenants(organization_id,stripe_account_id,livemode,retained_at) SELECT organization_id,stripe_account_id,livemode,? FROM (SELECT organization_id,stripe_account_id,livemode FROM payments WHERE organization_id=? UNION SELECT organization_id,stripe_account_id,livemode FROM stripe_connected_accounts WHERE organization_id=? AND stripe_account_id IS NOT NULL) WHERE 1 ON CONFLICT(stripe_account_id,livemode) DO UPDATE SET organization_id=CASE WHEN payment_servicing_tenants.organization_id=excluded.organization_id THEN payment_servicing_tenants.organization_id END`,params:[now,organizationId,organizationId]},
  {query:"UPDATE payment_checkout_holds SET status='released' WHERE organization_id=? AND status='active'",params:[organizationId]},
 ],{operation:'Retain minimum Payments servicing links before tenant deletion'})
}
