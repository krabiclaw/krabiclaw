#!/usr/bin/env node

import { authHeaders, BASE_URL, expectStatus, expectValue, LOCATION_ID, mcp, ORGANIZATION_ID, run, toolData } from './utils/mcp-check.mjs'


// A public https image stands in for the file reference ChatGPT supplies for an
// attached or generated image; the tool downloads it the same way.
const FIXTURE_IMAGE = { download_url: 'https://blawby.com/platform/blawby-192.png', file_id: 'mcp-image-flow-fixture', mime_type: 'image/png', file_name: 'blawby-192.png' }

async function assertResolvableImage(url, label) {
  const res = await fetch(url, { method: 'HEAD' })
  expectValue(`${label} resolves`, res.status === 200, { url, status: res.status })
  expectValue(`${label} is an image`, String(res.headers.get('content-type') || '').startsWith('image/'), {
    url,
    contentType: res.headers.get('content-type'),
  })
}

async function assertSavedImage(headers, organizationId, label) {
  const response = await mcp(headers, 'save_media_attachment', {
    organization_id: organizationId,
    file: FIXTURE_IMAGE,
    description: `${label} image`,
  })
  expectStatus(`${label} save_media_attachment succeeds`, response)
  const payload = toolData(response.body)
  expectValue(`${label} returns asset_id`, Boolean(payload?.asset_id), payload)
  expectValue(`${label} returns public_url`, typeof payload?.public_url === 'string' && payload.public_url.startsWith('https://'), payload)
  expectValue(`${label} returns thumbnail_url`, typeof payload?.thumbnail_url === 'string' && payload.thumbnail_url.startsWith('https://'), payload)
  if (payload?.public_url) await assertResolvableImage(payload.public_url, `${label} public_url`)
  if (payload?.thumbnail_url) await assertResolvableImage(payload.thumbnail_url, `${label} thumbnail_url`)
  return payload
}


async function createProduct(headers, organizationId, locationId) {
  const product = await mcp(headers, 'create_product', { kind: 'dish',
    organization_id: organizationId,
    name: 'MCP Image Dish',
    description: 'Used for image tool coverage',
    variants: [{ name: 'Standard', prices: [{ unit_amount: 1200, currency: 'USD' }] }],
  })
  expectStatus('create_product succeeds', product)
  const productId = toolData(product.body)?.product?.id
  expectValue('create_product returns Product id', Boolean(productId), product.body)
  // Publication and location membership are separate rows; a Product nobody
  // published is not on the site, which is what the image checks read back.
  expectStatus('set_product_publication succeeds', await mcp(headers, 'set_product_publication', { organization_id: organizationId, product_id: productId, published: true }))
  expectStatus('set_product_location succeeds', await mcp(headers, 'set_product_location', { organization_id: organizationId, product_id: productId, location_id: locationId, active: true, published: true }))
  return productId
}

async function createPost(headers, organizationId) {
  const response = await mcp(headers, 'create_post', {
    organization_id: organizationId,
    idempotency_key: `mcp-image-post-${Date.now()}`,
    title: 'MCP Image Post',
    body: 'Post used for image tool coverage',
  })
  expectStatus('create_post succeeds', response)
  const postId = toolData(response.body)?.post?.id
  expectValue('create_post returns post id', Boolean(postId), response.body)
  return postId
}

async function createSecondProduct(headers, organizationId) {
  const response = await mcp(headers, 'create_product', { kind: 'experience',
    organization_id: organizationId,
    name: 'MCP Image Class',
    description: 'Second Product used for image tool coverage',
    variants: [{ name: 'Standard', prices: [{ unit_amount: 4500, currency: 'USD' }] }],
  })
  expectStatus('create_product (second) succeeds', response)
  const id = toolData(response.body)?.product?.id
  expectValue('create_product (second) returns Product id', Boolean(id), response.body)
  // Carrying is not publishing, and the media steps below read this Product
  // through the site. The first Product publishes itself; this one did not, so
  // the later site-scoped reads were exercising an unpublished row.
  expectStatus('set_product_publication (second) succeeds', await mcp(headers, 'set_product_publication', { organization_id: organizationId, product_id: id, published: true }))
  return id
}

async function assertImageAssignmentTool(headers, name, args, expectation) {
  const response = await mcp(headers, name, args)
  expectStatus(`${name} succeeds`, response)
  const payload = toolData(response.body)
  expectation(payload, response.body)
}

async function main() {
  console.log(`Checking MCP image flow at ${BASE_URL}`)
  const headers = await authHeaders()
  const organizationId = ORGANIZATION_ID
  if (!organizationId) throw new Error('Pass --organization-id for a disposable organization provisioned through local setup or the CMS.')

  const firstImage = await assertSavedImage(headers, organizationId, 'first')
  const secondImage = await assertSavedImage(headers, organizationId, 'second')
  const assetId = firstImage?.asset_id
  const secondAssetId = secondImage?.asset_id
  expectValue('saved image fixture returns reusable asset_id', Boolean(assetId), firstImage)
  expectValue('saved image fixture returns second reusable asset_id', Boolean(secondAssetId), secondImage)

  const locationId = LOCATION_ID
  if (!locationId) throw new Error('Pass --location-id for a disposable location provisioned through the CMS.')
  const workspaceSet = await mcp(headers, 'set_workspace_context', {
    organization_id: organizationId,
    location_id: locationId,
  })
  expectStatus('set_workspace_context with location succeeds', workspaceSet)
  const workspacePayload = toolData(workspaceSet.body)
  expectValue('workspace context stores active location', workspacePayload?.context?.location_id === locationId, workspacePayload)
  const productId = await createProduct(headers, organizationId, locationId)
  const postId = await createPost(headers, organizationId)
  const secondProductId = await createSecondProduct(headers, organizationId)

  await assertImageAssignmentTool(headers, 'set_media', {
    organization_id: organizationId,
    placement: { owner_type: 'organization', owner_id: organizationId, slot: 'logo' },
    asset_id: assetId,
  }, (payload) => {
    expectValue('set_media organization logo returns asset id', payload?.asset_ids?.[0] === assetId, payload)
    expectValue('set_media organization logo returns context', payload?.context?.organization_id === organizationId, payload)
  })

  await assertImageAssignmentTool(headers, 'set_media', {
    organization_id: organizationId,
    placement: { owner_type: 'business_location', owner_id: locationId, slot: 'hero' },
    asset_id: assetId,
  }, (payload) => {
    expectValue('set_media location_hero returns location id', payload?.id === locationId, payload)
    expectValue('set_media location_hero returns location context', payload?.context?.location_id === locationId, payload)
  })

  await assertImageAssignmentTool(headers, 'attach_media', {
    organization_id: organizationId,
    placement: { owner_type: 'product', owner_id: productId, slot: 'gallery' },
    asset_id: assetId,
  }, (payload) => {
    expectValue('attach_media Product gallery returns Product id', payload?.id === productId, payload)
    expectValue('attach_media Product gallery returns site context', payload?.context?.organization_id === organizationId, payload)
  })

  await assertImageAssignmentTool(headers, 'attach_media', {
    organization_id: organizationId,
    placement: { owner_type: 'product', owner_id: productId, slot: 'gallery' },
    asset_id: secondAssetId,
  }, (payload) => {
    expectValue('attach_media second Product gallery asset appends', JSON.stringify(payload?.asset_ids) === JSON.stringify([assetId, secondAssetId]), payload)
  })

  await assertImageAssignmentTool(headers, 'set_media', {
    organization_id: organizationId,
    placement: { owner_type: 'product', owner_id: productId, slot: 'image' },
    asset_id: assetId,
  }, (payload) => {
    expectValue('set_media Product primary returns Product id', payload?.id === productId, payload)
  })

  await assertImageAssignmentTool(headers, 'set_media', {
    organization_id: organizationId,
    placement: { owner_type: 'content_document', owner_id: postId, slot: 'cover' },
    asset_id: assetId,
  }, (payload) => {
    expectValue('set_media post_image returns post id', payload?.id === postId, payload)
    expectValue('set_media post_image returns site context', payload?.context?.organization_id === organizationId, payload)
  })

  await assertImageAssignmentTool(headers, 'attach_media', {
    organization_id: organizationId,
    placement: { owner_type: 'product', owner_id: secondProductId, slot: 'gallery' },
    asset_id: assetId,
  }, (payload) => {
    expectValue('attach_media second Product gallery returns its id', payload?.id === secondProductId, payload)
    expectValue('attach_media second Product gallery returns site context', payload?.context?.organization_id === organizationId, payload)
  })

  const locationRead = await mcp(headers, 'get_location', {
    organization_id: organizationId,
    location_id: locationId,
  })
  expectStatus('get_location succeeds', locationRead)
  expectValue('set_media updates location hero', toolData(locationRead.body)?.location?.media?.some(media => media.slot === 'hero' && media.asset_id === assetId), toolData(locationRead.body))

  const productRead = await mcp(headers, 'get_product', {
    organization_id: organizationId,
    product_id: productId,
  })
  const readProduct = toolData(productRead.body)?.product
  expectStatus('get_product for image verification succeeds', productRead)
  expectValue(
    'attach_media updates ordered Product gallery',
    JSON.stringify(readProduct?.gallery?.map((media) => media.asset_id)) === JSON.stringify([assetId, secondAssetId]),
    readProduct,
  )
  expectValue('set_media updates explicit Product primary', readProduct?.image?.asset_id === assetId, readProduct)

  const postRead = await mcp(headers, 'get_post', {
    organization_id: organizationId,
    post_id: postId,
  })
  expectStatus('get_post succeeds', postRead)
  expectValue('set_media updates post cover', toolData(postRead.body)?.post?.media?.some(media => media.slot === 'cover' && media.asset_id === assetId), toolData(postRead.body))

  const secondProductRead = await mcp(headers, 'get_product', {
    organization_id: organizationId,
    product_id: secondProductId,
  })
  expectStatus('get_product (second) succeeds', secondProductRead)
  expectValue('attach_media updates the second Product media', toolData(secondProductRead.body)?.product?.gallery?.[0]?.asset_id === assetId, toolData(secondProductRead.body))

}

run(main)
