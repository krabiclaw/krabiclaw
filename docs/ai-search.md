# AI Search

Krabiclaw uses Cloudflare AI Search as the single retrieval backend for platform knowledge.

## Instance layout

- Namespace: `default`
- Production instance: `krabiclaw-platform-knowledge`. AI Search has no local,
  E2E, preview, or staging binding.

### Provisioning an instance

The instance is infrastructure and is created once, out of band — the application never
creates one at runtime. A rebuild against a missing instance fails and names it, which is
the intended outcome: it means the environment is not provisioned, not that a blog write
went wrong.

```bash
yarn wrangler ai-search create <AI_SEARCH_INSTANCE_ID> --namespace default --type builtin
```

`ensurePlatformKnowledgeInstance()` then re-asserts the retrieval configuration
(`platformKnowledgeInstanceConfig()` in `server/utils/public-search.ts`) at the start of
every rebuild, so index method, fusion, tokenizer, and the custom metadata schema always
match the code that queries them.

Krabiclaw uses the native production `AI_SEARCH` Workers namespace binding for
instance management, indexing, and search queries in the built-in `default` namespace.

## Indexed corpus

One instance holds two kinds of document, told apart by metadata:

- The platform's own corpus, with no `organization_id`: published platform docs and blog posts,
  the help FAQ, and the public platform pages (home, pricing, features, templates).
  Canonical metadata lives in [config/platform-knowledge.ts](../config/platform-knowledge.ts).
- Each business's slice, carrying its `organization_id`: its published blog (the `tenant_blog`
  surface, read by its public site) and every record its dashboard can open — locations,
  products and collections, Q&A, posts, pages, articles including drafts, guest threads,
  members and media (the `dashboard` surface). `buildWorkspaceDocuments()` in
  [server/utils/public-search.ts](../server/utils/public-search.ts) builds these; each
  document carries the dashboard URL it opens at.

The dashboard's command palette reads `/api/dashboard/search`, which checks the member's
access to the organization and filters the query to `surface = dashboard` and
`organization_id IN (<that organization>, '')`, so a business sees its own records and the platform's
guides and nothing else. Navigation rows in the palette come from the Menu's own
navigation, not the index.

## Keeping a business's slice current

Every write to a site's data queues a "this site changed" row
(`publicResourceCacheInvalidationQuery`, table `public_resource_cache_invalidations`) in the
write's own batch: content documents, products and collections, locations, media, guest
threads at intake, and Better Auth's member hooks. The drainer
(`drainPublicResourceCacheInvalidations`) clears the site's caches in every
environment. In production it also runs `syncOrganizationSearchIndex()`, which lists the site's own items by its hashed
organization key segment, rebuilds its documents from D1, uploads the ones whose
`content_hash` changed and deletes the ones that are gone. Dashboard editor responses
and mutating MCP tool calls purge the site's caches before reporting success and never
wait on AI Search: the scheduled task drains queued work every two minutes. A failed
drain row is retried and then retained as failed for reconciliation. Cloudflare indexes
an accepted upload asynchronously; nothing waits for it to finish.

## Rebuild flow

Run the production rebuild with:

```bash
yarn ai-search:sync:prod
```

Required secret:

- `PLATFORM_SEARCH_REINDEX_SECRET`

The script calls `POST /api/internal/search/reindex` for the platform corpus, then
for each returned organization with `?organization=<id>`. Each request performs a bounded
batch; the script repeats that pass until its reported pending count reaches zero.

To initialize or reconcile one explicitly named organization's slice against the
Worker serving the corresponding D1 snapshot, use the same command with its internal ID:

```bash
yarn ai-search:sync:prod --organization <organization-id>
```

This calls only the named organization's production slice; it does not rebuild
the platform or other businesses.

Production CI (`.github/workflows/ci.yml`) runs a blocking rebuild when a file
that defines the indexed corpus or its rendering changes, including the MCP
registry behind the generated tool reference. Production verification waits for
the deployed build and assets to converge, checks the published MCP documentation,
then rebuilds the search index. A failed rebuild fails production verification.
Nonproduction drains purge caches only; they do not access or require AI Search.

## Environment expectations

- AI Search is production-only. `wrangler.toml` binds it only on the production Worker.
- Production should not be treated as healthy after indexed content changes until the AI Search rebuild has completed successfully.
