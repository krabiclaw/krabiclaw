---
name: write-help-docs
description: Create or update KrabiClaw customer help articles through the canonical CMS, with verified instructions and live screenshots of relevant workflows.
---

# Write customer help docs

Publish a useful, self-contained article on the explicitly selected site's docs
collection. KrabiClaw's help belongs to organization `platform`; a customer's
site has its own organization, content, domain and SEO. Use the connected
KrabiClaw MCP tools for CMS reads and writes. Read the current article and retain
its block IDs and concurrency token when editing.

## Verify the instructions

Walk the current running UI before describing a workflow. Use its exact labels,
navigation and status wording. Check the canonical domain service for behavior
that cannot be established without a consequential write, such as refund timing
or fee handling. Do not perform a real refund, change a bank account or create a
customer notification to illustrate a guide. Exercise mutations only through
the repository's documented local disposable-data flow.

Explain the task, prerequisites, steps, expected result and relevant recovery
paths. Use customer-friendly phrasing consistent with the actual policy. Keep
provider research in operator documentation; customer help should explain what
to do on the customer's own site without depending on a provider article.

## Required live screenshots

For each workflow section where seeing the controls helps the reader, capture
the actual running application at the relevant step. Include the navigation or
surrounding labels needed to orient the reader and the control being explained.
A general dashboard image cannot stand in for the refund form, a payout detail
or another distinct workflow. Policy-only sections do not need decorative images.

Screenshots must show the current UI after loading finishes. Do not use generated
mockups, reconstructed screens, repository source images, loading skeletons or
an unrelated provider screenshot as evidence of KrabiClaw's behavior. Capture
provider-owned controls only from the authorized real provider interface and
label the provider boundary explicitly.

Use a clean authorized account or the documented local fixture. Exclude names,
contact details, invoice identifiers, payment amounts, bank details, credentials
and unrelated customer information. Prefer a screenshot clip that retains the
useful controls while excluding private data. If a local fixture is necessary,
identify it in the caption and verify its labels match the deployed application.
Do not invent sample state or alter the page DOM to fabricate a screenshot.

Review each capture visually for legibility, framing, privacy and agreement with
the adjacent instructions. Upload the file to the selected organization's media
library through `save_media_attachment`. Insert an `image` block immediately
after the relevant instructions, using the returned asset ID in the block's
`media` placement. Add meaningful alt text and a short caption describing the
screen and its purpose. Keep the introduction first so a workflow screenshot
does not accidentally become the article cover or social card.

If an essential screen cannot be reached, report the specific missing access or
state and finish the sections that can be verified. Do not mark the article
complete while required screenshots are absent.

## Verify publication

Read the article back through MCP, open its public URL, and verify the text and
images in the rendered page at desktop and narrow widths. Fetch each published
image to confirm it is publicly usable. Check headings, table of contents,
caption placement and relevant internal links.

Verify the same canonical content appears in the site's sitemap, docs index,
Markdown mirror and applicable LLM projections. Titles, descriptions and
canonical URLs must belong to the target site. Keep a concise operator record
of the inspected workflow, screenshot date/environment and published article
URLs; refresh screenshots when the UI changes.
