import assert from "node:assert/strict";
import test from "node:test";

import { describeErrorForTelemetry, errorChainForTelemetry } from "../../shared/error-telemetry.ts";
import { mcpDiagnosticPayload, summarizeForTelemetry } from "../../server/utils/mcp-telemetry.ts";

test('startup diagnostics preserve workflow content and redact credentials in both structured data and MCP text', () => {
  const product = { id: 'product-one', kind: 'experience', name: 'Ume Set', password: 'private-password',
    token: 'private-token', url: 'https://example.test/experiences/ume?signature=private-signature' };
  const payload = mcpDiagnosticPayload({
    product, content: [{ type: 'text', text: JSON.stringify(product) }, { type: 'image', data: 'private-binary', mimeType: 'image/png' }],
    _meta: { attachment: 'private-host-data' },
    notes: 'Bearer private-bearer and sk_live_privateKey',
  })!;
  assert.doesNotMatch(payload, /private-password|private-token|private-signature|private-binary|private-host-data|private-bearer|sk_live_privateKey/);
  const captured = JSON.parse(payload);
  assert.equal(captured._diagnostic, true);
  assert.equal(captured.data.product.name, 'Ume Set');
  assert.equal(captured.data.product.id, 'product-one');
  assert.equal(JSON.parse(captured.data.content[0].text).kind, 'experience');
  assert.equal(captured.data.product.url, 'https://example.test/experiences/ume?[redacted]');
});

test('oversized and circular diagnostics remain valid JSON with explicit loss markers', () => {
  const shared = { name: 'Ume Set' };
  const circular: Record<string, unknown> = { name: 'Menu', product: shared, structuredContent: shared,
    content: [{ type: 'text', text: JSON.stringify(shared) }] };
  circular.self = circular;
  const captured = JSON.parse(mcpDiagnosticPayload(circular)!).data;
  assert.equal(captured.self, '[circular]');
  assert.equal(captured.structuredContent.name, 'Ume Set');
  const oversized = JSON.parse(mcpDiagnosticPayload({ text: '🍱'.repeat(200_000) })!);
  assert.equal(oversized._diagnostic, true);
  assert.equal(oversized.truncated, true);
  assert.ok(oversized.original_length > oversized.preview.length);
});

test("MCP summaries retain only typed operational fields, including inside known result containers", () => {
  const privateText = 'Alice Customer customer@example.com password-secret';
  const summary = summarizeForTelemetry({
    name: privateText, guest_name: privateText, message: privateText, notes: privateText,
    password: privateText, token: privateText, download_url: privateText,
    status: 'success', count: 2, confirm: true,
    structuredContent: { booking: { status: 'confirmed', party_size: 3, notes: privateText } },
    data: { status: privateText, count: privateText },
    content: [{ text: privateText }],
  });
  assert.deepEqual(JSON.parse(summary!), {
    status: 'success', count: 2, confirm: true,
    structuredContent: { booking: { status: 'confirmed', party_size: 3 } },
  });
  assert.doesNotMatch(summary!, /Alice|customer@|password-secret/);
  assert.equal(summarizeForTelemetry({ name: privateText, message: privateText }), null);
  assert.equal(summarizeForTelemetry(privateText), null);
  assert.equal(summarizeForTelemetry({ count: Infinity, total: NaN }), null);
});

test("unknown keys and cyclic payloads cannot enter MCP summaries", () => {
  const payload: Record<string, unknown> = { count: 1 };
  payload.data = payload;
  payload.secret = 'hidden';
  const summary = summarizeForTelemetry(payload)!;
  assert.ok(summary.length < 4000);
  assert.doesNotMatch(summary, /hidden|secret/);
  assert.equal(JSON.parse(summary).count, 1);
});

test("describeErrorForTelemetry preserves a nested database root cause", () => {
  const cause = new Error("D1_ERROR: CHECK constraint failed: media_assets_category_check");
  const error = new Error(
    `Failed query: INSERT INTO media_assets (${"column,".repeat(200)})\nparams: https://signed.example/secret,customer@example.com`,
    { cause },
  );

  const description = describeErrorForTelemetry(error, 500);

  assert.ok(description.length <= 500);
  assert.match(description, /^Failed query: INSERT INTO media_assets/);
  assert.match(description, /CHECK constraint failed: media_assets_category_check$/);
  assert.match(description, /middle truncated/);
  assert.doesNotMatch(description, /signed\.example|customer@example\.com/);
});

test("describeErrorForTelemetry handles circular cause chains", () => {
  const error = new Error("outer") as Error & { cause?: unknown };
  error.cause = error;

  assert.equal(describeErrorForTelemetry(error), "outer");
});

test("provider error chains retain the cause without logging credentials", () => {
  const cause = new Error("Invalid API Key provided: sk_test_example123; Authorization: Bearer private-token");
  cause.name = "StripeAuthenticationError";
  const chain = errorChainForTelemetry(new Error("Billing plans are temporarily unavailable", { cause }));

  assert.equal(chain[1]?.name, "StripeAuthenticationError");
  assert.match(chain[1]!.message, /Invalid API Key provided/);
  assert.doesNotMatch(JSON.stringify(chain), /sk_test_example123|private-token/);
});
