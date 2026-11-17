import { unstable_readConfig } from 'wrangler'

const branch = process.argv[2]
if (branch !== 'main' && branch !== 'staging') throw new Error('Use the main or staging deployment branch')
const environment = branch === 'staging' ? 'staging' : undefined
const config = unstable_readConfig({ config: 'wrangler.toml', env: environment }, { hideWarnings: true })
const queueName = config.queues.producers.find(binding => binding.binding === 'EVENTS')?.queue
if (!queueName) throw new Error('EVENTS is not bound in Wrangler configuration')

const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = process.env
if (!account || !token) throw new Error('The Cloudflare deployment credentials are required')
const queuesUrl = `https://api.cloudflare.com/client/v4/accounts/${account}/queues`
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const pageSize = 500

async function cloudflare(url, init) {
  const response = await fetch(url, { ...init, headers })
  if (!response.ok) throw new Error(`Cloudflare Queue API returned HTTP ${response.status}`)
  const payload = await response.json()
  if (!payload.success) throw new Error('Cloudflare Queue API refused the deployment message')
  return payload.result
}

for (let page = 1; ; page++) {
  const queues = await cloudflare(`${queuesUrl}?per_page=${pageSize}&page=${page}`)
  const queueId = queues.find(queue => queue.queue_name === queueName)?.queue_id
  if (queueId) {
    await cloudflare(`${queuesUrl}/${queueId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: { type: 'deployment.adopt_pending_work' }, content_type: 'json' }),
    })
    console.log(`Queued outstanding work on ${queueName}`)
    break
  }
  if (queues.length < pageSize) throw new Error(`Cloudflare Queue ${queueName} was not found`)
}
