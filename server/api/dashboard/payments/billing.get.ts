import {defineHandler} from 'nitro'
import {getDashboardContext} from '~/server/utils/dashboard-context'
import {jsonResponse} from '~/server/utils/api-response'
import {assertRoleAllows} from '~/server/utils/member-access'
import {paymentsUsage} from '~/server/domain/payments/usage'
export default defineHandler(async event=>{
 const {db,env,organization}=await getDashboardContext(event,{})
 await assertRoleAllows({organizationId:organization.id,role:organization.role,permissions:{payments:['integration']}})
 return jsonResponse(await paymentsUsage(db,env,organization.id))
})
