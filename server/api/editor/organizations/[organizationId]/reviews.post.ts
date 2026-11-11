import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { executeBatch } from '~/server/db'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { publicResourceCacheInvalidationQuery } from '~/server/utils/public-resource-cache'
import { OWNER_REVIEW_COLLECTION_METHODS, type OwnerReviewCollectionMethod } from '~/shared/organization-reviews'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { db, session } = await requireOrganizationAccess(event, organizationId)
  const body = await readBody<{
    author_name: string
    rating: number
    title?: string | null
    content?: string | null
    collection_method?: OwnerReviewCollectionMethod
    original_review_date?: string | null
  }>(event)

  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  }
  const authorName = typeof body.author_name === 'string' ? body.author_name.trim() : ''
  if (!authorName) {
    return jsonResponse({ error: 'Client or author name is required' }, { status: 400 })
  }
  const rating = Number(body.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return jsonResponse({ error: 'Rating must be an integer between 1 and 5' }, { status: 400 })
  }
  const title = typeof body.title === 'string' ? body.title.trim() : null
  const content = typeof body.content === 'string' ? body.content.trim() : null
  const collectionMethod = body.collection_method && OWNER_REVIEW_COLLECTION_METHODS.includes(body.collection_method)
    ? body.collection_method
    : 'in_person'
  const originalReviewDate = typeof body.original_review_date === 'string' && body.original_review_date.trim()
    ? body.original_review_date.trim()
    : new Date().toISOString()

  const id = `rev_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
  const now = new Date().toISOString()

  await executeBatch(db, [
    {
      query: `
        INSERT INTO reviews (
          id, organization_id, location_id, author_name, rating, title, content,
          source, entered_by_user_id, collection_method, original_review_date,
          publication_authorized, status, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'owner_entered', ?, ?, ?, 1, 'approved', ?, ?)
      `,
      params: [
        id,
        organizationId,
        authorName,
        rating,
        title || null,
        content || null,
        session.user.id,
        collectionMethod,
        originalReviewDate,
        now,
        now,
      ],
    },
    publicResourceCacheInvalidationQuery(organizationId, 'reviews'),
  ])

  return jsonResponse({
    success: true,
    review: {
      id,
      organization_id: organizationId,
      author_name: authorName,
      rating,
      title,
      content,
      status: 'approved',
      source: 'owner_entered',
      collection_method: collectionMethod,
      original_review_date: originalReviewDate,
      publication_authorized: true,
      created_at: now,
    },
  }, { status: 201 })
})
