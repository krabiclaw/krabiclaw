#!/usr/bin/env node

import { authHeaders, BASE_URL, expectStatus, expectValue, fail, mcp, ORGANIZATION_ID, pass, run, toolData } from './utils/mcp-check.mjs'

async function main() {
  console.log(`Checking MCP edit flow at ${BASE_URL}`)
  const headers = await authHeaders()

  const welcome = await mcp(headers, 'list_organizations')
  expectStatus('list_organizations succeeds', welcome)
  const welcomeData = toolData(welcome.body)
  if (Array.isArray(welcomeData?.organizations)) pass('list_organizations returns organizations array')
  else fail('list_organizations did not return organizations array', welcome.body)

  const organizationId = ORGANIZATION_ID
  if (!organizationId) throw new Error('Pass --organization-id for a disposable organization provisioned through local setup or the CMS.')

  const list = await mcp(headers, 'list_organizations')
  expectStatus('list_organizations succeeds', list)
  const organizations = toolData(list.body)?.organizations ?? []
  if (organizations.some(entry => entry?.id === organizationId)) pass('list_organizations includes the editable organization')
  else fail('list_organizations does not include the editable organization', { organizationId, organizations })

  const setWorkspace = await mcp(headers, 'set_workspace_context', { organization_id: organizationId })
  expectStatus('set_workspace_context succeeds', setWorkspace)
  const setWorkspaceData = toolData(setWorkspace.body)
  expectValue('set_workspace_context stores the active organization', setWorkspaceData?.context?.organization_id === organizationId, setWorkspaceData)

  const getWorkspace = await mcp(headers, 'get_workspace_context')
  expectStatus('get_workspace_context succeeds', getWorkspace)
  const workspaceData = toolData(getWorkspace.body)
  expectValue('get_workspace_context returns the active organization', workspaceData?.context?.organization_id === organizationId, workspaceData)
  expectValue('get_workspace_context marks one active organization', Array.isArray(workspaceData?.organizations) && workspaceData.organizations.filter(entry => entry?.active === true).length === 1 && workspaceData.organizations.find(entry => entry?.active === true)?.id === organizationId, workspaceData)

  const draftTitle = `MCP edit check ${Date.now()}`
  const pageList = await mcp(headers, 'list_site_pages', { locale: 'en' })
  expectStatus('list_site_pages succeeds', pageList)
  const homeVariant = toolData(pageList.body)?.pages?.find(page => page?.path === '/')
  if (!homeVariant?.id) {
    fail('list_site_pages did not return the home variant', pageList.body)
    process.exit(1)
  }
  const contentBefore = await mcp(headers, 'get_site_page', { variant_id: homeVariant.id })
  expectStatus('get_site_page succeeds before update', contentBefore)
  const pageBefore = toolData(contentBefore.body)?.page
  const blocks = pageBefore?.blocks
  if (!Array.isArray(blocks)) {
    fail('get_site_page did not return canonical blocks', contentBefore.body)
    process.exit(1)
  }
  // update_site_page replaces the document, so state the path, title, position
  // and identity that were just read rather than leaving them to be filled in.
  const save = await mcp(headers, 'update_site_page', {
    variant_id: homeVariant.id,
    updated_at: pageBefore.document.updated_at,
    path: pageBefore.path,
    title: pageBefore.title,
    sort_order: pageBefore.sort_order,
    page_type: pageBefore.page_type,
    recipe: pageBefore.recipe,
    blocks: blocks.map(block => ({
      id: block.id,
      type: block.type,
      position: block.position,
      data: block?.type === 'hero'
        ? { ...block.data, title: draftTitle, subtitle: 'Edited through MCP edit-flow checker' }
        : block.data,
      media: block.media ?? [],
    })),
  })
  expectStatus('update_site_page succeeds', save)
  const saveData = toolData(save.body)
  expectValue('update_site_page preserves the home variant', saveData?.page?.id === homeVariant.id, saveData)

  const content = await mcp(headers, 'get_site_page', { variant_id: homeVariant.id })
  expectStatus('get_site_page succeeds', content)
  const hero = toolData(content.body)?.page?.blocks?.find(block => block?.type === 'hero')
  if (hero?.data?.title === draftTitle) pass('canonical content includes updated hero title')
  else fail('canonical content did not include updated hero title', hero)

}

run(main)
