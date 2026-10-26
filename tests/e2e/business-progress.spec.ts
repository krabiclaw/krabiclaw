import { expect, request as playwrightRequest, test, type APIResponse } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import type { BusinessOutcomePage, BusinessProgressReference } from '../../shared/business-outcomes'
import type { BusinessGoal, RecommendationFeedback, RecommendationFeedbackView } from '../../shared/business-progress'
import type { RecommendationPreview } from '../../shared/recommendation-preview'
import type { TodayFeedPayload } from '../../shared/dashboard-today'
import { authRequestHeaders, loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'

type Progress = BusinessOutcomePage & { goals: BusinessGoal[]; feedback: RecommendationFeedbackView[] }

async function responseBody<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status)
  return response.json() as Promise<T>
}

test('owner intent drives grounded previews and evidence-bound feedback follows real work', async ({ request, baseURL }, testInfo) => {
  test.skip(Boolean(process.env.PLAYWRIGHT_PREVIEW_URL), 'This journey writes only to disposable local D1 data.')
  test.setTimeout(300_000)
  const actorId = 'user-e2e-onboarding-wizard'
  await loginAs(request, baseURL!, actorId)
  const slug = `e2e-progress-${crypto.randomUUID().slice(0, 8)}`
  const name = `Progress Legal Practice ${slug}`
  const organization = await responseBody<{ id: string }>(await request.post('/api/auth/organization/create', {
    headers: authRequestHeaders(baseURL!), data: { name, slug, default_currency: 'USD', timezone: 'America/New_York' },
  }))
  const api = `/api/organizations/${organization.id}`
  const editor = `/api/editor/organizations/${organization.id}/blog`
  const preview = async (data: Record<string, unknown>) => (await responseBody<{ preview: RecommendationPreview }>(await request.post(`${api}/recommendations/preview`, { data, timeout: 90_000 }))).preview
  const member = await playwrightRequest.newContext({ baseURL })
  try {
    const provisioned = await responseBody<{ organizationId: string }>(await request.post('/api/organizations', {
      data: { organizationId: organization.id, name, subdomain: slug, vertical: 'service', sourceLocale: 'en' },
    }))
    expect(provisioned.organizationId).toBe(organization.id)
    await responseBody(await member.post(`${api}/recommendations/preview`, { data: { availableMinutes: 0 } }), 401)
    const intent = { idempotencyKey: crypto.randomUUID(), intent: 'Explain consultation preparation clearly to prospective clients.', constraints: 'I have twenty minutes for writing this week.' }
    const concurrentCreates = await Promise.all([request.post(`${api}/goals`, { data: intent }), request.post(`${api}/goals`, { data: intent })])
    const createdGoals = await Promise.all(concurrentCreates.map(response => responseBody<{ goal: BusinessGoal }>(response, 201)))
    const goal = createdGoals[0]!.goal
    expect(createdGoals[1]!.goal).toEqual(goal)
    expect(goal).toMatchObject({ intent: intent.intent, constraints: intent.constraints, createdBy: actorId, updatedBy: actorId, targetAt: null, status: 'active' })
    const replay = await responseBody<{ goal: BusinessGoal }>(await request.post(`${api}/goals`, { data: intent }), 201)
    expect(replay.goal).toEqual(goal)
    await responseBody(await request.post(`${api}/goals`, { data: { ...intent, intent: 'A different request under the same key.' } }), 409)
    let progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.goals).toEqual([goal])

    const revised = await responseBody<{ goal: BusinessGoal }>(await request.patch(`${api}/goals/${goal.id}`, {
      data: { revision: goal.revision, constraints: 'I now have ten minutes for writing this week.' },
    }))
    expect(revised.goal.revision).not.toBe(goal.revision)
    await responseBody(await request.patch(`${api}/goals/${goal.id}`, { data: { revision: goal.revision, intent: 'This stale edit must not replace current intent.' } }), 409)
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.goals).toEqual([revised.goal])
    let currentGoal = revised.goal

    const { category } = await responseBody<{ category: { id: string } }>(await request.post(`${editor}/categories`, { data: { collection: 'blog', name: 'Consultations' } }), 201)
    const created = await responseBody<{ post: { id: string; title: string; updated_at: string } }>(await request.post(`${editor}/posts`, { data: {
      idempotency_key: crypto.randomUUID(), title: 'Prepare for a legal consultation', category_id: category.id,
      content_blocks: [{ type: 'markdown', data: { markdown: 'Bring the documents relevant to your legal question.', editor_mode: 'rich' } }],
    } }))
    const postId = created.post.id
    const postUrl = `${editor}/${postId}`
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    const articleOutcomes = (value: Progress) => value.outcomes.filter(outcome => outcome.subject.id === postId)
    expect(articleOutcomes(progress)).toEqual([expect.objectContaining({
      event: 'article.created', actor: { kind: 'member', userId: actorId },
      verification: { status: 'verified', basis: 'persisted_change', receipts: [] },
    })])

    const update = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'update_blog_post', args: {
      organization_id: organization.id, post_id: postId, expected_updated_at: created.post.updated_at,
      title: 'Documents to bring to a legal consultation',
    } })
    expect(update.status(), await update.text()).toBe(200)
    const edited = mcpData<{ post: { updated_at: string; title: string } }>(await update.json()).post
    const independentArticle = await responseBody<{ post: { updated_at: string; title: string } }>(await request.get(postUrl))
    expect(independentArticle.post).toMatchObject({ title: edited.title, updated_at: edited.updated_at })
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    const editedOutcomes = articleOutcomes(progress)
    expect(editedOutcomes.map(outcome => outcome.event).sort()).toEqual(['article.created', 'article.updated'])
    expect(new Set(editedOutcomes.map(outcome => outcome.id)).size).toBe(2)
    expect(editedOutcomes.every(outcome => outcome.actor.userId === actorId)).toBe(true)
    expect(progress.coverage.unverified).toContain('business_goal_achievement')
    expect(progress.coverage.unverified).toContain('public_visibility')

    const { reference } = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.publish', subjectId: postId } }))
    const noChange = await responseBody<{ changed: boolean; post: { updated_at: string } }>(await request.patch(postUrl, { data: { title: edited.title, expected_updated_at: edited.updated_at } }))
    expect(noChange).toMatchObject({ changed: false, post: { updated_at: edited.updated_at } })
    const unchangedReference = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.publish', subjectId: postId } }))
    expect(unchangedReference.reference).toEqual(reference)
    const noChangeProgress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(articleOutcomes(noChangeProgress)).toEqual(editedOutcomes)

    await loginAs(member, baseURL!, 'user-e2e-buyer')
    const guestName = `Progress enquiry ${crypto.randomUUID().slice(0, 8)}`
    await responseBody(await member.post('/api/public/contact', { headers: { 'x-preview-tenant': slug }, data: {
      name: guestName, email: 'buyer@playwright.example', subject: 'general', consent: true, message: 'Which documents should I bring to my legal consultation?',
    } }), 201)
    const inbox = await responseBody<{ threads: Array<{ id: string; guestName: string }> }>(await request.get(`/api/dashboard/organizations/${organization.id}/guest-threads`, { params: { type: 'contact' } }))
    const contacts = inbox.threads.filter(thread => thread.guestName === guestName)
    expect(contacts).toHaveLength(1)
    const threadId = contacts[0]!.id
    const threadUrl = `/api/dashboard/organizations/${organization.id}/guest-threads/${threadId}`

    const noTime = await preview({ goalIds: [goal.id], availableMinutes: 0, limit: 1 })
    expect(noTime).toMatchObject({ decision: 'no_suggestion', recommendations: [], reasoning: { model: null, usage: null } })
    const initialToday = await responseBody<TodayFeedPayload>(await request.get('/api/dashboard/today', { params: { org: slug } }))
    const inboxGoal = await responseBody<{ goal: BusinessGoal }>(await request.patch(`${api}/goals/${goal.id}`, { data: {
      revision: currentGoal.revision, intent: 'My only priority today is answering the recent client enquiry in our inbox. Do not publish or edit articles this week.', constraints: null,
    } }))
    currentGoal = inboxGoal.goal
    const inboxPreview = await preview({ goalIds: [goal.id], availableMinutes: 30, limit: 1 })
    expect(inboxPreview.decision).toBe('recommendations')
    expect(inboxPreview.goals).toEqual([currentGoal])
    expect(inboxPreview.recommendations).toEqual([expect.objectContaining({ id: `guest_thread.reply:${threadId}`, reference: expect.objectContaining({ operation: 'guest_thread.reply', subjectId: threadId }), goalIds: [goal.id] })])
    expect(inboxPreview.reasoning.model).toBeTruthy()
    expect(inboxPreview.recommendations[0]!.uncertainties.length).toBeGreaterThan(0)

    const publicationGoal = await responseBody<{ goal: BusinessGoal }>(await request.patch(`${api}/goals/${goal.id}`, { data: {
      revision: currentGoal.revision, intent: 'Only publish our reviewed article "Documents to bring to a legal consultation" today. Its copy is approved and ready. Do not edit it or suggest replying to the inbox now; the inbox can wait.',
    } }))
    currentGoal = publicationGoal.goal
    const publicationPreview = await preview({ goalIds: [goal.id], availableMinutes: 30, limit: 1 })
    expect(publicationPreview.decision).toBe('recommendations')
    expect(publicationPreview.goals).toEqual([currentGoal])
    expect(publicationPreview.recommendations).toEqual([expect.objectContaining({ id: `article.publish:${postId}`, reference, goalIds: [goal.id] })])
    expect(publicationPreview.reasoning.model).toBeTruthy()
    expect(publicationPreview.contextRevision).not.toBe(inboxPreview.contextRevision)
    expect(publicationPreview.previewId).not.toBe(inboxPreview.previewId)
    const stillDraft = await responseBody<{ post: { status: string; updated_at: string } }>(await request.get(postUrl))
    expect(stillDraft.post).toMatchObject({ status: 'draft', updated_at: edited.updated_at })
    expect(articleOutcomes(await responseBody<Progress>(await request.get(`${api}/progress`)))).toEqual(editedOutcomes)
    const unchangedToday = await responseBody<TodayFeedPayload>(await request.get('/api/dashboard/today', { params: { org: slug } }))
    expect(unchangedToday.cards.map(card => card.id)).toEqual(initialToday.cards.map(card => card.id))
    // This is a technical comparison of current selection behavior, not a
    // claim that an owner preferred either output in a product evaluation.
    const aged = await preview({ goalIds: [goal.id], availableMinutes: 0, asOf: new Date(Date.now() + 21 * 86_400_000).toISOString() })
    expect(aged.considered.find(candidate => candidate.id === `guest_thread.reply:${threadId}`)?.eligibility.available).toBe(false)

    const feedbackRequest = {
      operation: reference.operation, subjectId: postId, evidenceRevision: reference.evidenceRevision,
      goalId: goal.id, goalRevision: currentGoal.revision, decision: 'dismiss', note: 'The current explanation is sufficient for this week.',
    }
    const { feedback } = await responseBody<{ feedback: RecommendationFeedback }>(await request.put(`${api}/recommendation-feedback`, { data: feedbackRequest }))
    const feedbackReplay = await responseBody<{ feedback: RecommendationFeedback }>(await request.put(`${api}/recommendation-feedback`, { data: feedbackRequest }))
    expect(feedbackReplay.feedback).toEqual(feedback)
    await responseBody(await request.put(`${api}/recommendation-feedback`, { data: { ...feedbackRequest, decision: 'accept' } }), 409)
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.feedback).toEqual([expect.objectContaining({ id: feedback.id, actorId, decision: 'dismiss', note: feedbackRequest.note, applicability: { current: true, reasons: [] } })])
    const dismissed = await preview({ goalIds: [goal.id], availableMinutes: 0 })
    expect(dismissed.considered.find(candidate => candidate.id === `article.publish:${postId}`)?.eligibility.available).toBe(false)
    expect(dismissed.considered.find(candidate => candidate.id === `article.publish:${postId}`)?.eligibility.reasons).toContain('dismissed')

    const correction = await responseBody<{ feedback: RecommendationFeedback }>(await request.put(`${api}/recommendation-feedback`, { data: {
      ...feedbackRequest, revision: feedback.revision, decision: 'correct', note: 'Do not publish this guide. An attorney must review the consultation instructions first.',
    } }))
    expect(correction.feedback).toMatchObject({ id: feedback.id, decision: 'correct' })
    expect(correction.feedback.revision).not.toBe(feedback.revision)
    const corrected = await preview({ goalIds: [goal.id], availableMinutes: 0 })
    expect(corrected.considered.find(candidate => candidate.id === `article.publish:${postId}`)?.eligibility.available).toBe(true)
    expect(corrected.goals).toEqual([currentGoal])
    const correctionPreview = await preview({ goalIds: [goal.id], availableMinutes: 30, limit: 1 })
    const correctionArtifact = testInfo.outputPath('correction-preview.json')
    await writeFile(correctionArtifact, JSON.stringify(correctionPreview, null, 2))
    await testInfo.attach('correction-preview.json', { path: correctionArtifact, contentType: 'application/json' })
    expect(correctionPreview.reasoning.model).toBeTruthy()
    expect(correctionPreview.recommendations.some(candidate => candidate.id === `article.publish:${postId}`)).toBe(false)
    expect(correctionPreview.goals).toEqual([currentGoal])
    await responseBody(await request.put(`${api}/recommendation-feedback`, { data: { ...feedbackRequest, revision: feedback.revision, decision: 'accept' } }), 409)

    const changedArticle = await responseBody<{ post: { updated_at: string } }>(await request.patch(postUrl, { data: {
      expected_updated_at: edited.updated_at, excerpt: 'Updated guidance for existing clients.',
    } }))
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.feedback).toEqual([expect.objectContaining({ id: feedback.id, decision: 'correct', applicability: { current: false, reasons: ['evidence_changed'] } })])
    await responseBody(await request.put(`${api}/recommendation-feedback`, { data: { ...feedbackRequest, revision: correction.feedback.revision } }), 409)
    const changedReference = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.publish', subjectId: postId } }))
    expect(changedReference.reference.evidenceRevision).not.toBe(reference.evidenceRevision)
    const afterEvidenceChange = await preview({ goalIds: [goal.id], availableMinutes: 0 })
    expect(afterEvidenceChange.considered.find(candidate => candidate.id === `article.publish:${postId}`)).toMatchObject({ reference: changedReference.reference, eligibility: { available: true } })
    expect(afterEvidenceChange.contextRevision).not.toBe(publicationPreview.contextRevision)
    const newFeedback = await responseBody<{ feedback: RecommendationFeedback }>(await request.put(`${api}/recommendation-feedback`, { data: { ...feedbackRequest, evidenceRevision: changedReference.reference.evidenceRevision } }))
    expect(newFeedback.feedback.id).not.toBe(feedback.id)

    const { lifecycle } = await responseBody<{ lifecycle: { status: string; changed: boolean; updated_at: string } }>(await request.post(`${postUrl}/publish`, { data: { expected_updated_at: changedArticle.post.updated_at } }))
    expect(lifecycle).toMatchObject({ status: 'published', changed: true })
    const publishedRead = await responseBody<{ post: { status: string; updated_at: string } }>(await request.get(postUrl))
    expect(publishedRead.post).toMatchObject({ status: 'published', updated_at: lifecycle.updated_at })
    const publishedProgress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(articleOutcomes(publishedProgress).filter(outcome => outcome.event === 'article.published')).toEqual([expect.objectContaining({
      actor: { kind: 'member', userId: actorId }, verification: { status: 'verified', basis: 'persisted_change', receipts: [] },
    })])
    const republished = await responseBody<{ lifecycle: { changed: boolean; updated_at: string } }>(await request.post(`${postUrl}/publish`, { data: { expected_updated_at: lifecycle.updated_at } }))
    expect(republished.lifecycle).toMatchObject({ changed: false, updated_at: lifecycle.updated_at })
    expect(articleOutcomes(await responseBody<Progress>(await request.get(`${api}/progress`)))).toEqual(articleOutcomes(publishedProgress))
    const afterPublication = await preview({ goalIds: [goal.id], availableMinutes: 0 })
    expect(afterPublication.considered.find(candidate => candidate.id === `article.publish:${postId}`)?.eligibility.available).toBe(false)
    const completedPublication = await preview({ goalIds: [goal.id], availableMinutes: 30, limit: 1 })
    expect(completedPublication).toMatchObject({ decision: 'no_suggestion', recommendations: [], questions: [] })
    expect(completedPublication.reasoning.model).toBeTruthy()
    expect(completedPublication.goals).toEqual([currentGoal])

    const beforeMedia = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.update', subjectId: postId } }))
    const asset = await responseBody<{ asset_id: string }>(await request.post(`/api/editor/organizations/${organization.id}/media/upload`, { multipart: {
      image: { name: 'consultation-cover.avif', mimeType: 'image/avif', buffer: await sharp('public/platform/apple-touch-icon.png').avif().toBuffer() },
    } }))
    const assignedCover = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'set_media', args: {
      organization_id: organization.id, placement: { owner_type: 'content_document', owner_id: postId, slot: 'cover' }, asset_id: asset.asset_id,
    } })
    expect(assignedCover.status(), await assignedCover.text()).toBe(200)
    mcpData(await assignedCover.json())
    const afterMedia = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'article.update', subjectId: postId } }))
    expect(afterMedia.reference.evidence).toMatchObject({ kind: 'article', updatedAt: publishedRead.post.updated_at, media: [expect.objectContaining({ assetId: asset.asset_id })] })
    expect(afterMedia.reference.evidenceRevision).not.toBe(beforeMedia.reference.evidenceRevision)

    const { reference: unansweredReference } = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'guest_thread.reply', subjectId: threadId } }))
    await responseBody(await request.put(`${api}/recommendation-feedback`, { data: {
      operation: 'guest_thread.reply', subjectId: threadId, evidenceRevision: unansweredReference.evidenceRevision,
      decision: 'defer', deferUntil: new Date(Date.now() + 86_400_000).toISOString(), note: 'I will address this enquiry tomorrow.',
    } }))
    const deferredPreview = await preview({ goalIds: [goal.id], availableMinutes: 0 })
    expect(deferredPreview.considered.find(candidate => candidate.id === `guest_thread.reply:${threadId}`)?.eligibility.available).toBe(false)
    expect(deferredPreview.considered.find(candidate => candidate.id === `guest_thread.reply:${threadId}`)?.eligibility.reasons).toContain('deferred')
    const afterDeferral = await preview({ goalIds: [goal.id], availableMinutes: 0, asOf: new Date(Date.now() + 2 * 86_400_000).toISOString() })
    expect(afterDeferral.considered.find(candidate => candidate.id === `guest_thread.reply:${threadId}`)?.eligibility.available).toBe(true)
    const replyBody = 'Please bring the relevant documents and any prior correspondence.'
    const replyKey = crypto.randomUUID()
    await responseBody(await request.post(`${threadUrl}/operations/reply`, { data: { body: replyBody, idempotencyKey: replyKey } }))
    await responseBody(await request.post(`${threadUrl}/operations/reply`, { data: { body: replyBody, idempotencyKey: replyKey } }))
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    const replies = progress.outcomes.filter(outcome => outcome.subject.id === threadId)
    expect(replies).toEqual([expect.objectContaining({
      event: 'thread.member_reply', actor: { kind: 'member', userId: actorId },
      verification: { status: 'unconfirmed', basis: 'provider_acceptance', receipts: [expect.objectContaining({ provider: 'log_only', channel: 'email', status: 'sent' })] },
    })])
    const afterReply = await preview({ goalIds: [goal.id], availableMinutes: 0 })
    expect(afterReply.considered.find(candidate => candidate.id === `guest_thread.reply:${threadId}`)?.eligibility.available).toBe(false)
    const { reference: repliedReference } = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'guest_thread.reply', subjectId: threadId } }))
    expect(repliedReference.evidence).toMatchObject({ kind: 'guest_thread', latestGuestEntryId: expect.any(String), latestReplyEntryId: replies[0]!.id })
    const { feedback: deferred } = await responseBody<{ feedback: RecommendationFeedback }>(await request.put(`${api}/recommendation-feedback`, { data: {
      operation: 'guest_thread.reply', subjectId: threadId, evidenceRevision: repliedReference.evidenceRevision,
      decision: 'defer', deferUntil: new Date(Date.now() + 86_400_000).toISOString(), note: 'Wait for the client to provide documents.',
    } }))
    const guestReply = 'I found another letter with a deadline tomorrow; should I send it now?'
    await responseBody(await member.post(`/api/account/messages/${threadId}/reply`, { headers: authRequestHeaders(baseURL!), data: { body: guestReply, idempotencyKey: crypto.randomUUID() } }))
    const { reference: inboundReference } = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, { params: { operation: 'guest_thread.reply', subjectId: threadId } }))
    expect(inboundReference.evidenceRevision).not.toBe(repliedReference.evidenceRevision)
    if (inboundReference.evidence.kind !== 'guest_thread' || repliedReference.evidence.kind !== 'guest_thread') throw new Error('The explicit thread reference must describe thread evidence')
    expect(inboundReference.evidence.latestGuestEntryId).not.toBe(repliedReference.evidence.latestGuestEntryId)
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.feedback.find(item => item.id === deferred.id)?.applicability).toEqual({ current: false, reasons: ['evidence_changed'] })
    expect(progress.outcomes.filter(outcome => outcome.subject.id === threadId)).toEqual(replies)
    const afterInbound = await preview({ goalIds: [goal.id], availableMinutes: 0 })
    expect(afterInbound.considered.find(candidate => candidate.id === `guest_thread.reply:${threadId}`)?.eligibility.available).toBe(true)
    expect(afterInbound.contextRevision).not.toBe(afterReply.contextRevision)
    const preserved = await responseBody<{ thread: { entries: Array<{ body: string | null }> } }>(await request.get(threadUrl))
    expect(preserved.thread.entries.filter(entry => entry.body === replyBody)).toHaveLength(1)
    expect(preserved.thread.entries.filter(entry => entry.body === guestReply)).toHaveLength(1)

    const renewedInboxGoal = await responseBody<{ goal: BusinessGoal }>(await request.patch(`${api}/goals/${goal.id}`, { data: {
      revision: currentGoal.revision, intent: 'The guide is published. My only priority now is replying to the new client message about their letter. Do not suggest more article work.',
    } }))
    currentGoal = renewedInboxGoal.goal
    const freshInboundPreview = await preview({ goalIds: [goal.id], availableMinutes: 30, limit: 1 })
    expect(freshInboundPreview.recommendations).toEqual([expect.objectContaining({ id: `guest_thread.reply:${threadId}`, reference: inboundReference, goalIds: [goal.id] })])
    expect(freshInboundPreview.reasoning.model).toBeTruthy()
    const { members } = await responseBody<{ members: Array<{ id: string; userId: string }> }>(await request.get('/api/auth/organization/list-members', { params: { organizationId: organization.id } }))
    const attorney = members.find(item => item.userId === actorId)
    expect(attorney, 'The organization creator is its canonical Better Auth member').toBeDefined()
    if (!attorney) throw new Error('The consultation attorney membership is missing')
    const schedulingPath = `/api/organizations/${organization.id}/members/${attorney.id}/scheduling`
    const { scheduling } = await responseBody<{ scheduling: { updated_at: string } | null }>(await request.get(schedulingPath))
    const consultationDay = new Date(Date.now() + 28 * 86_400_000)
    const day = consultationDay.toISOString().slice(0, 10)
    await responseBody(await request.put(schedulingPath, { data: {
      timezone: 'UTC', weekly: [{ weekday: consultationDay.getUTCDay(), start: '14:00', end: '14:45' }], time_off: [],
      expected_updated_at: scheduling?.updated_at ?? null, public_name: 'Consultation attorney', public_bio: 'Reviews the documents relevant to your legal question.', public_approved: true,
    } }))
    const catalog = `/api/editor/organizations/${organization.id}`
    const { product } = await responseBody<{ product: { id: string; slug: string; variants: Array<{ id: string }> } }>(await request.post(`${catalog}/products`, { data: {
      kind: 'service', active: true, name: 'Consultation for a future legal matter', description: 'Discuss your legal question with the attorney.',
      details: { preparation: 'Bring your consultation questions.', cancellation_policy: 'Contact the legal team before the consultation to cancel.' },
      variants: [{ name: 'Online consultation', prices: [{ unit_amount: 0, currency: 'USD' }] }],
    } }), 201)
    await responseBody(await request.put(`${catalog}/products/${product.id}/booking`, { data: {
      duration_minutes: 45, default_capacity: 1, confirmation_mode: 'review', online_payment_required: false, scheduling_mode: 'provider', assigned_member_id: attorney.id, held_online: true,
    } }))
    await responseBody(await request.put(`${catalog}/products/${product.id}/publication`, { data: { published: true } }))
    await responseBody(await request.put(`${catalog}/consultation`, { data: { mode: 'native' } }))
    const { sessions } = await responseBody<{ sessions: Array<{ id: string; starts_at: string; ends_at: string }> }>(await member.get(`/api/public/products/${product.slug}/sessions`, {
      headers: { 'x-preview-tenant': slug }, params: { location_id: 'online', from: day, to: day },
    }))
    const session = sessions.find(item => item.starts_at === `${day}T14:00:00.000Z`)
    expect(session, 'Published attorney hours expose an actual future consultation').toBeDefined()
    if (!session) throw new Error('The future consultation has no bookable session')
    const booking = await responseBody<{ request_id: string; status: string }>(await member.post(`/api/public/products/${product.slug}/book`, { headers: { 'x-preview-tenant': slug }, data: {
      session_id: session.id, variant_id: product.variants[0]!.id, party_size: 1, guest_name: 'Future consultation client', guest_email: 'buyer@playwright.example', idempotency_key: crypto.randomUUID(),
    } }), 201)
    expect(booking.status).toBe('pending')
    const futureClock = new Date(Date.now() + 21 * 86_400_000).toISOString()
    const commitmentPreview = await preview({ goalIds: [goal.id], availableMinutes: 0, asOf: futureClock })
    expect(commitmentPreview.considered.find(candidate => candidate.id === `guest_thread.reply:${threadId}`)?.eligibility.available).toBe(false)
    const committedConversation = commitmentPreview.considered.find(candidate => candidate.id === `guest_thread.reply:${booking.request_id}`)
    expect(committedConversation).toMatchObject({ eligibility: { available: true }, reference: { evidence: { kind: 'guest_thread', commitment: { kind: 'booking', status: 'pending', startsAt: session.starts_at, endsAt: session.ends_at } } } })
    expect(Date.parse(session.starts_at)).toBeGreaterThan(Date.parse(commitmentPreview.evaluatedAt))
    const afterCommitment = await preview({ goalIds: [goal.id], availableMinutes: 0, asOf: new Date(Date.now() + 35 * 86_400_000).toISOString() })
    expect(afterCommitment.considered.find(candidate => candidate.id === `guest_thread.reply:${booking.request_id}`)?.eligibility.available).toBe(false)
    const evaluationArtifact = testInfo.outputPath('recommendation-technical-evaluation.json')
    await writeFile(evaluationArtifact, JSON.stringify({
      evidenceType: 'synthetic_local_technical_cases',
      currentRuleBaseline: { beforeGoalChange: initialToday.cards.map(card => card.id), afterGoalChange: unchangedToday.cards.map(card => card.id) },
      groundedPreviews: { inboxPriority: inboxPreview, publicationPriority: publicationPreview, correctionHold: correctionPreview, completedPublication, freshInbound: freshInboundPreview },
      temporalEligibility: { staleUncommitted: aged, activeCommitment: commitmentPreview, endedCommitment: afterCommitment },
    }, null, 2))
    await testInfo.attach('recommendation-technical-evaluation.json', { path: evaluationArtifact, contentType: 'application/json' })

    const archived = await responseBody<{ goal: BusinessGoal }>(await request.patch(`${api}/goals/${goal.id}`, { data: { revision: currentGoal.revision, status: 'archived' } }))
    progress = await responseBody<Progress>(await request.get(`${api}/progress`))
    expect(progress.goals).toEqual([archived.goal])
    expect(progress.feedback.find(item => item.id === newFeedback.feedback.id)?.applicability).toEqual({ current: false, reasons: ['evidence_changed', 'goal_changed', 'goal_archived'] })

    await responseBody(await request.get('/api/organizations/org-demo/progress'), 404)
    await responseBody(await request.post('/api/organizations/org-demo/recommendations/preview', { data: { availableMinutes: 0 } }), 404)
    await responseBody(await request.post(`${api}/recommendations/preview`, { data: { availableMinutes: -1 } }), 400)
    await responseBody(await request.post(`${api}/recommendations/preview`, { data: { asOf: new Date(Date.now() - 1000).toISOString() } }), 400)
    await responseBody(await request.get(`${api}/progress/reference`, { params: { operation: 'article.update', subjectId: crypto.randomUUID() } }), 404)
    const { token } = await responseBody<{ token: string }>(await request.post(`${api}/invite-links`, { data: { role: 'member' } }), 201)
    await loginAs(member, baseURL!, 'user-e2e-demo-role-owner')
    const joined = await responseBody<{ role: string; organization: { id: string } }>(await member.post(`/api/invite-links/${token}/accept`))
    expect(joined).toMatchObject({ role: 'member', organization: { id: organization.id } })
    await responseBody(await member.get(`${api}/progress`), 404)
    await responseBody(await member.get(`${api}/progress/reference`, { params: { operation: 'article.update', subjectId: postId } }), 404)
    await responseBody(await member.post(`${api}/goals`, { data: { ...intent, idempotencyKey: crypto.randomUUID() } }), 404)
    await responseBody(await member.put(`${api}/recommendation-feedback`, { data: feedbackRequest }), 404)
    await responseBody(await member.post(`${api}/recommendations/preview`, { data: { availableMinutes: 0 } }), 404)
  } finally {
    try {
      await responseBody(await request.post('/api/auth/organization/delete', { headers: authRequestHeaders(baseURL!), data: { organizationId: organization.id } }))
      const organizations = await responseBody<Array<{ id: string }>>(await request.get('/api/auth/organization/list'))
      expect(organizations.map(item => item.id)).not.toContain(organization.id)
    } finally {
      await member.dispose()
    }
  }
})

test('business progress read-only contract uses the explicitly configured canary organization', async ({ request, baseURL }) => {
  const organizationId = process.env.CANARY_ORG_ID
  if (!organizationId) throw new Error('CANARY_ORG_ID must explicitly identify the tenant for the read-only progress check')
  await loginAs(request, baseURL!)
  const api = `/api/organizations/${encodeURIComponent(organizationId)}`
  const first = await responseBody<Progress>(await request.get(`${api}/progress`))
  const second = await responseBody<Progress>(await request.get(`${api}/progress`))
  expect(first.coverage).toEqual({
    supportedEvents: ['article.created', 'article.updated', 'article.published', 'thread.member_reply'],
    attribution: 'recorded_actor_only', article: 'persisted_change_only', webReply: 'stored_message_only',
    externalReply: 'provider_acceptance_requires_receipt',
    unverified: ['public_visibility', 'operation_completion', 'recipient_notification', 'conversation_resolution', 'business_goal_achievement'],
  })
  expect(second.coverage).toEqual(first.coverage)
  expect(second.goals).toEqual(first.goals)
  const decisions = (progress: Progress) => progress.feedback.map(({ applicability: _applicability, ...saved }) => saved)
  expect(decisions(second)).toEqual(decisions(first))
  if (!first.goals.some(goal => goal.status === 'active')) {
    const { preview: noGoalPreview } = await responseBody<{ preview: RecommendationPreview }>(await request.post(`${api}/recommendations/preview`, { data: {} }))
    expect(noGoalPreview).toMatchObject({ decision: 'needs_context', recommendations: [], reasoning: { model: null, usage: null } })
    expect(noGoalPreview.questions.length).toBeGreaterThan(0)
  }
  for (const outcome of first.outcomes) {
    const repeated = second.outcomes.find(item => item.id === outcome.id)
    expect(repeated, 'A canonical occurrence keeps its identity across progress reads').toMatchObject({
      id: outcome.id, event: outcome.event, subject: outcome.subject, actor: outcome.actor, occurredAt: outcome.occurredAt,
    })
  }
  // Audit history can describe a deleted article. Its immutable occurrence
  // remains valid; only an existing source can provide a current reference.
  for (const outcome of first.outcomes.filter(item => item.subject.kind === 'article')) {
    const article = await request.get(`/api/editor/organizations/${encodeURIComponent(organizationId)}/blog/${encodeURIComponent(outcome.subject.id)}`)
    if (article.status() === 404) continue
    const { post } = await responseBody<{ post: { id: string; status: string; updated_at: string } }>(article)
    expect(post.id).toBe(outcome.subject.id)
    const { reference } = await responseBody<{ reference: BusinessProgressReference }>(await request.get(`${api}/progress/reference`, {
      params: { operation: 'article.update', subjectId: outcome.subject.id },
    }))
    expect(reference).toMatchObject({ operation: 'article.update', subjectId: post.id, evidence: { kind: 'article', status: post.status, updatedAt: post.updated_at } })
    expect(reference.evidenceRevision).toMatch(/^[a-f0-9]{64}$/)
    break
  }
})
