#!/usr/bin/env node

import { authHeaders, BASE_URL, expectValue, fail, LOCATION_ID, mcp, ORGANIZATION_ID, pass, run, toolData } from './utils/mcp-check.mjs'

// A tool that failed answers HTTP 200 with isError: true, so a status alone
// would count a refused or half-finished write as success.
function expectSuccess(label, response) {
  if (response.status === 200 && response.body?.result && response.body.result.isError !== true) pass(label)
  else fail(`${label}: expected a successful tool result, got HTTP ${response.status}`, response.body)
}


async function main() {
  console.log(`Checking MCP operations flow at ${BASE_URL}`)
  const headers = await authHeaders()
  const organizationId = ORGANIZATION_ID
  if (!organizationId) throw new Error('Pass --organization-id for a disposable organization provisioned through local setup or the CMS.')

  const locationId = LOCATION_ID
  if (!locationId) throw new Error('Pass --location-id for a disposable location provisioned through the CMS.')

  // Collections group Products for a site; membership and its order live on the
  // membership row, not on the Product.
  const collectionIds = new Map()
  for (const name of ['Mains', 'Shots']) {
    const collection = await mcp(headers, 'create_collection', { organization_id: organizationId, name })
    expectSuccess(`create_collection ${name} succeeds`, collection)
    const collectionId = toolData(collection.body)?.collection?.id
    expectValue('create_collection returns collection id', Boolean(collectionId), collection.body)
    collectionIds.set(name, collectionId)
  }

  const product = await mcp(headers, 'create_product', { kind: 'dish',
    organization_id: organizationId,
    name: 'MCP Ops Curry',
    variants: [{ name: 'Standard', prices: [{ unit_amount: 1250, currency: 'USD' }] }],
  })
  expectSuccess('create_product with price succeeds', product)
  const productId = toolData(product.body)?.product?.id
  expectValue('create_product returns Product id', Boolean(productId), product.body)

  // Publication and location membership are separate states; neither implies
  // the other, and a read must show both.
  expectSuccess('set_product_publication succeeds', await mcp(headers, 'set_product_publication', { organization_id: organizationId, product_id: productId, published: true }))
  expectSuccess('set_product_location succeeds', await mcp(headers, 'set_product_location', { organization_id: organizationId, product_id: productId, location_id: locationId, active: true, published: true }))
  expectSuccess('set_collection_products succeeds', await mcp(headers, 'set_collection_products', { organization_id: organizationId, collection_id: collectionIds.get('Mains'), product_ids: [productId] }))

  const initialRead = await mcp(headers, 'get_product', { organization_id: organizationId, product_id: productId })
  expectSuccess('get_product succeeds after create', initialRead)
  const initialProduct = toolData(initialRead.body)?.product
  const initialVariant = initialProduct?.variants?.[0]
  const initialPrice = initialVariant?.prices?.[0]
  if (initialProduct?.variants?.length !== 1 || initialVariant?.prices?.length !== 1 || !initialVariant.id || !initialPrice?.id) {
    throw new Error('get_product must return the created variant and price identities before editing them')
  }
  expectValue('created Product has initial Price on its variant', initialPrice.unit_amount === 1250, initialRead.body)

  const batch = await mcp(headers, 'batch_create_products', {
    organization_id: organizationId,
    products: [
      { kind: 'dish', name: 'B-52', variants: [{ name: 'Standard', prices: [{ unit_amount: 700, currency: 'USD' }] }] },
      { kind: 'dish', name: 'Lemon Drop', variants: [{ name: 'Standard', prices: [{ unit_amount: 800, currency: 'USD' }] }] },
    ],
  })
  expectSuccess('batch_create_products succeeds', batch)
  expectValue('batch_create_products adds two Products atomically', toolData(batch.body)?.products?.length === 2, batch.body)

  const productUpdate = await mcp(headers, 'update_product', {
    organization_id: organizationId,
    product_id: productId,
    name: 'MCP Ops Green Curry',
    variants: [{ id: initialVariant.id, prices: [{ id: initialPrice.id, unit_amount: 1300 }] }],
  })
  expectSuccess('update_product price succeeds', productUpdate)

  const productRead = await mcp(headers, 'get_product', { organization_id: organizationId, product_id: productId })
  expectSuccess('get_product succeeds', productRead)
  expectValue('get_product includes updated Product', toolData(productRead.body)?.product?.name === 'MCP Ops Green Curry', productRead.body)
  expectValue('get_product reports where the Product is offered', (toolData(productRead.body)?.product?.locations ?? []).some(entry => entry.location_id === locationId && entry.published), productRead.body)
  const updatedVariant = toolData(productRead.body)?.product?.variants?.[0]
  const updatedPrice = updatedVariant?.prices?.[0]
  expectValue('updated Product keeps its variant and Price identities', toolData(productRead.body)?.product?.variants?.length === 1
    && updatedVariant?.prices?.length === 1 && updatedVariant.id === initialVariant.id && updatedPrice?.id === initialPrice.id, productRead.body)
  expectValue('updated Product has the requested Price amount', updatedPrice?.unit_amount === 1300, productRead.body)
  const productDelete = await mcp(headers, 'delete_product', { organization_id: organizationId, product_id: productId })
  expectSuccess('delete_product succeeds', productDelete)
  expectValue('delete_product returns deleted true', toolData(productDelete.body)?.deleted === true, productDelete.body)

  const post = await mcp(headers, 'create_post', {
    organization_id: organizationId,
    idempotency_key: `mcp-ops-post-${Date.now()}`,
    title: 'MCP Ops Post',
    body: 'Post created by MCP ops checker',
  })
  expectSuccess('create_post succeeds', post)
  const postId = toolData(post.body)?.post?.id
  expectValue('create_post returns post id', Boolean(postId), post.body)

  const postUpdate = await mcp(headers, 'update_post', {
    organization_id: organizationId,
    post_id: postId,
    expected_updated_at: toolData(post.body)?.post?.updated_at,
    title: 'MCP Ops Post Updated',
    body: 'Post updated by MCP ops checker',
  })
  expectSuccess('update_post succeeds', postUpdate)
  const updatedAt = toolData(postUpdate.body)?.post?.updated_at
  expectValue('update_post returns the new revision', typeof updatedAt === 'string' && updatedAt !== toolData(post.body)?.post?.updated_at, postUpdate.body)

  const connections = await mcp(headers, 'get_social_connections', { organization_id: organizationId })
  expectSuccess('get_social_connections succeeds', connections)
  const facebook = (toolData(connections.body)?.channels ?? []).find(channel => channel.channel === 'facebook')
  expectValue('get_social_connections reports facebook', Boolean(facebook), connections.body)

  const postPublish = await mcp(headers, 'publish_post', {
    organization_id: organizationId,
    post_id: postId,
    expected_updated_at: updatedAt,
    targets: [{ channel: 'organization' }],
  })
  expectSuccess('publish_post succeeds', postPublish)
  expectValue('publish_post publishes the website only', toolData(postPublish.body)?.ok === true
    && toolData(postPublish.body)?.outcomes?.length === 1
    && toolData(postPublish.body)?.outcomes?.[0]?.status === 'published', postPublish.body)

  if (facebook && !facebook.connected) {
    const facebookPublish = await mcp(headers, 'publish_post', {
      organization_id: organizationId,
      post_id: postId,
      expected_updated_at: toolData(postPublish.body)?.updated_at,
      targets: [{ channel: 'organization' }, { channel: 'facebook', target_id: 'no-page-connected', connection_revision: 'none' }],
    })
    expectValue('publish_post reports incomplete publication when facebook is not connected', facebookPublish.status === 200 && facebookPublish.body?.result?.isError === true, facebookPublish.body)
    const outcomes = toolData(facebookPublish.body)?.outcomes ?? []
    expectValue(
      'publish_post keeps the website receipt and skips facebook with the problem get_social_connections named',
      outcomes.find(outcome => outcome.channel === 'organization')?.status === 'already_published'
        && outcomes.find(outcome => outcome.channel === 'facebook')?.status === 'skipped'
        && outcomes.find(outcome => outcome.channel === 'facebook')?.code === facebook.problems?.[0]?.code
        && toolData(facebookPublish.body)?.ok === false,
      facebookPublish.body,
    )
  }

  const posts = await mcp(headers, 'list_posts', { organization_id: organizationId })
  expectSuccess('list_posts succeeds', posts)
  expectValue('list_posts includes published post', (toolData(posts.body)?.posts ?? []).some(post => post.id === postId), posts.body)
  const publishedPost = (toolData(posts.body)?.posts ?? []).find(post => post.id === postId)
  expectValue('update_post keeps updated title', publishedPost?.title === 'MCP Ops Post Updated', publishedPost)

  // A bookable Product is a Product: same tool, same shape. Booking is a
  // capability configured on it, not a second kind of row.
  const bookable = await mcp(headers, 'create_product', { kind: 'experience',
    organization_id: organizationId,
    name: 'MCP Ops Kayak Tour',
    description: 'Half-day tour created by MCP ops checker',
    variants: [{ name: 'Per person', prices: [{ unit_amount: 150000, currency: 'THB' }] }],
  })
  expectSuccess('create_product (bookable) succeeds', bookable)
  const bookableId = toolData(bookable.body)?.product?.id
  expectValue('create_product (bookable) returns Product id', Boolean(bookableId), bookable.body)

  const invalidProduct = await mcp(headers, 'create_product', { kind: 'dish', organization_id: organizationId, name: '' })
  expectValue('create_product rejects an empty name over JSON-RPC transport', invalidProduct.status === 200, invalidProduct.body)
  expectValue('create_product invalid name returns tool error', invalidProduct.body?.result?.isError === true, invalidProduct.body)

  const bookableUpdate = await mcp(headers, 'update_product', {
    organization_id: organizationId,
    product_id: bookableId,
    description: 'Updated through MCP ops checker',
  })
  expectSuccess('update_product (bookable) succeeds', bookableUpdate)

  const listed = await mcp(headers, 'list_products', { organization_id: organizationId })
  expectSuccess('list_products succeeds', listed)
  const listedProduct = (toolData(listed.body)?.products ?? []).find(item => item.id === bookableId)
  expectValue('list_products includes the created Product', Boolean(listedProduct), listed.body)
  expectValue('update_product keeps the updated description', listedProduct?.description === 'Updated through MCP ops checker', listedProduct)

}

run(main)
