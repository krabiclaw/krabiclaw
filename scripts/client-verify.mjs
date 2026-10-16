#!/usr/bin/env node
import { parseOpeningHours } from '../shared/reservation-hours.ts';
import { formatOpeningHours } from '../utils/formatters.ts';
/**
 * Post-deploy smoke test for a KrabiClaw tenant site.
 *
 * Usage:
 *   node scripts/client-verify.mjs --url https://www.potteryhousekrabi.com --vertical experience
 *   node scripts/client-verify.mjs --url https://www.potteryhousekrabi.com --vertical experience \
 *     --organization-id org-user-pottery-house --slug pottery-house-krabi
 *
 * With --slug, writes reports to client-imports/<slug>/:
 *   verify-report.latest.json    — structured results for this run
 *   verify-report.previous.json  — previous run (for diffing)
 *   verify-diff.txt              — regression diff between runs
 *   verify-report.txt            — human-readable summary
 *   client-handoff.md            — client-ready handoff document (on pass)
 *
 * Exit code 0 = all checks passed. Non-zero = failures found.
 */

import { parseArgs } from "node:util";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  environmentTenantAliasHostname,
  usesTenantHeader,
} from "../server/utils/tenant-hosts.ts";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    vertical: { type: "string", default: "restaurant" },
    "organization-id": { type: "string" },
    "tenant-slug": { type: "string" },
    slug: { type: "string" },
    "out-dir": { type: "string" },
    "evidence-dir": { type: "string" },
    "require-screenshots": { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (!args.url) {
  console.error(
    "Usage: node scripts/client-verify.mjs --url <site-url> --vertical <vertical> [--organization-id <id>] [--slug <slug>]",
  );
  process.exit(1);
}

const VERTICAL = args.vertical;
const ORGANIZATION_ID = args["organization-id"];
const TENANT_SLUG = args["tenant-slug"];
const inputUrl = new URL(args.url);
const environmentAlias = TENANT_SLUG
  ? environmentTenantAliasHostname(inputUrl.hostname, TENANT_SLUG)
  : "";
if (environmentAlias) inputUrl.hostname = environmentAlias;
const BASE = inputUrl.toString().replace(/\/$/, "");
const TENANT_HEADERS =
  TENANT_SLUG && usesTenantHeader(new URL(BASE).hostname)
    ? { "x-preview-tenant": TENANT_SLUG, "cache-control": "no-store" }
    : {};
const OUT_DIR =
  args["out-dir"] ??
  (args.slug ? join(process.cwd(), "client-imports", args.slug) : null);

if (VERTICAL === "service") {
  const blawbyArgs = ["scripts/verify-blawby-site.mjs", "--url", BASE];
  if (ORGANIZATION_ID) blawbyArgs.push("--organization-id", ORGANIZATION_ID);
  if (args["tenant-slug"]) blawbyArgs.push("--tenant-slug", args["tenant-slug"]);

  const importManifest = OUT_DIR ? join(OUT_DIR, "blawby-import.json") : null;
  if (importManifest && existsSync(importManifest)) {
    blawbyArgs.push("--import-manifest", importManifest);
  }

  const evidenceDir = args["evidence-dir"] ?? (args["require-screenshots"] ? OUT_DIR : null);
  if (evidenceDir) {
    blawbyArgs.push("--evidence-dir", evidenceDir);
  }
  if (args["require-screenshots"]) {
    blawbyArgs.push("--require-screenshots");
  }
  if (OUT_DIR) {
    blawbyArgs.push("--out", join(OUT_DIR, "blawby-evidence-bundle.json"));
  }

  const result = spawnSync(process.execPath, blawbyArgs, {
    cwd: process.cwd(),
    stdio: "inherit",
    timeout: 10 * 60 * 1000,
  });
  if (result.error?.code === "ETIMEDOUT") {
    console.error("Blawby verifier timed out after 10 minutes.");
    process.exit(124);
  }
  if (result.error) {
    console.error(`Blawby verifier failed to launch: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// ── Copy constraints ──────────────────────────────────────────────────────────

const FORBIDDEN_COPY = {
  experience: [
    "Come dine with us",
    "Reserve a table",
    "From the kitchen",
    "one kitchen philosophy",
    "Catering & events",
    "chef's table",
    "tasting menu",
    "dine differently",
    "Also part of Saya",
    "Ember & Slice",
    "kikuzuki",
  ],
  restaurant: [],
  retail: [],
  wellness: [],
  service: [],
};

const REQUIRED_COPY = {
  experience: [
    { pattern: /book a class/i, label: 'CTA: "Book a class"' },
    { pattern: /from the studio/i, label: 'Posts eyebrow: "From the studio"' },
  ],
  restaurant: [],
  retail: [],
  wellness: [],
  service: [],
};

// ── Route lists ───────────────────────────────────────────────────────────────

const CORE_ROUTES = [
  "/",
  "/locations",
  "/reviews",
  "/qa",
  "/posts",
  "/about",
  "/contact",
];

const VERTICAL_ROUTES = {
  experience: ["/products", "/reservations"],
  restaurant: ["/menu", "/reservations"],
  retail: ["/locations"],
  wellness: ["/products", "/reservations"],
  service: ["/reservations"],
};

const REQUIRED_ROUTES_BY_VERTICAL = {
  experience: [...CORE_ROUTES, "/products", "/reservations"],
  restaurant: [...CORE_ROUTES, "/menu", "/reservations"],
  retail: [...CORE_ROUTES],
  wellness: [...CORE_ROUTES, "/products", "/reservations"],
  service: [...CORE_ROUTES, "/reservations"],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

let failures = 0;
let passes = 0;

const reportLines = [];
const reportResults = [];

function pass(msg) {
  console.log(`  ✓ ${msg}`);
  reportLines.push(`PASS  ${msg}`);
  reportResults.push({ status: "pass", message: msg });
  passes++;
}
function fail(msg) {
  console.error(`  ✗ ${msg}`);
  reportLines.push(`FAIL  ${msg}`);
  reportResults.push({ status: "fail", message: msg });
  failures++;
}
function info(msg) {
  console.log(`\n${msg}`);
  reportLines.push(`\n${msg}`);
}

async function get(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers = new Headers(opts.headers);
    for (const [name, value] of Object.entries(TENANT_HEADERS)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      ...opts,
      headers,
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 0,
      text: async () => "",
      json: async () => ({}),
      statusText: err.message,
    };
  }
}

// Bootstrap is fetched once and cached — phases 3, 6, 7 all reuse it
let _bootstrapData = null;
async function getBootstrap() {
  if (_bootstrapData !== null) return _bootstrapData;
  if (!ORGANIZATION_ID) return null;
  const res = await get(`/api/public/shell`);
  if (!res.ok) return null;
  _bootstrapData = await res.json();
  return _bootstrapData;
}

// ── Phase 1: Route status codes ───────────────────────────────────────────────

info("── Route status checks");

const routes = REQUIRED_ROUTES_BY_VERTICAL[VERTICAL] ?? [
  ...CORE_ROUTES,
  ...(VERTICAL_ROUTES[VERTICAL] ?? []),
];
const pageHtml = {};

for (const route of routes) {
  const res = await get(route);
  if (res.ok) {
    pass(`GET ${route} → ${res.status}`);
    pageHtml[route] = await res.text();
  } else {
    fail(`GET ${route} → ${res.status} ${res.statusText}`);
  }
}

// ── Phase 1b: Route manifest verification ────────────────────────────────────

if (OUT_DIR) {
  const routeManifestPath = join(OUT_DIR, "route-manifest.json");
  if (existsSync(routeManifestPath)) {
    info("── Route manifest checks (from client:import dry-run)");
    const routeManifest = JSON.parse(await readFile(routeManifestPath, "utf8"));

    for (const route of [
      ...(routeManifest.locations ?? []),
      ...(routeManifest.experiences ?? []),
    ]) {
      if (pageHtml[route]) {
        pass(`Route manifest: ${route} (already verified)`);
        continue;
      }
      const res = await get(route);
      if (res.ok) {
        pass(`Route manifest: GET ${route} → ${res.status}`);
        pageHtml[route] = await res.text();
      } else {
        const kind = routeManifest.locations?.includes(route)
          ? "location"
          : "experience";
        fail(
          `Route manifest: GET ${route} → ${res.status} — expected ${kind} slug missing`,
        );
      }
    }
  }
}

// ── Phase 2: Experience / Product slug routing ────────────────────────────────

// Wellness sells Products on the same /products route as experience, so it is
// checked here too: gating on experience/restaurant let a wellness site pass
// verification without its product routes ever being loaded.
if (ORGANIZATION_ID && (VERTICAL === "experience" || VERTICAL === "restaurant" || VERTICAL === "wellness")) {
  info("── Slug route checks");

  // Every Saya vertical sells Products; only the route segment differs.
  const pageKind = VERTICAL === "restaurant" ? "menu" : "products";
  const apiPath = `/api/public/page?page=${pageKind}&datasets=products`;
  const res = await get(apiPath);

  if (res.ok) {
    const data = await res.json();
    const items = data.products ?? [];

    if (items.length === 0) {
      fail("Bootstrap returned 0 products — nothing to slug-check");
    } else {
      const locationsById = new Map((data.shell?.locations ?? []).map((location) => [location.id, location]));
      for (const item of items.slice(0, 5)) {
        if (!item.slug) continue;
        // A Product's page lives under the location that offers it, in the
        // segment this vertical presents its catalogue at.
        const segment = VERTICAL === "restaurant" ? "menu" : "products";
        const owning = (item.locations ?? []).find((entry) => entry.published && locationsById.has(entry.location_id));
        const route = `/locations/${locationsById.get(owning?.location_id)?.slug}/${segment}/${item.slug}`;
        if (route.includes('/undefined/')) {
          fail(`Product ${item.id ?? item.slug} has no resolvable owning location`);
          continue;
        }
        const r = await get(route);
        if (r.ok) {
          pass(`GET ${route} → ${r.status}`);
          pageHtml[route] = await r.text();
        } else {
          fail(`GET ${route} → ${r.status}`);
        }
      }
    }
  } else {
    fail(`Bootstrap API ${apiPath} → ${res.status}`);
  }
}

// ── Phase 3: Location slug routing ───────────────────────────────────────────

if (ORGANIZATION_ID) {
  info("── Location slug checks");
  const data = await getBootstrap();

  if (data) {
    const locs = data.locations ?? [];
    if (locs.length === 0) {
      fail("Bootstrap returned 0 locations");
    } else {
      for (const loc of locs) {
        const route = `/locations/${loc.slug}`;
        if (pageHtml[route]) {
          pass(`GET ${route} → cached`);
          continue;
        }
        const r = await get(route);
        if (r.ok) {
          pass(`GET ${route} → ${r.status}`);
          pageHtml[route] = await r.text();
        } else {
          fail(`GET ${route} → ${r.status}`);
        }
      }
    }
  } else {
    fail("Bootstrap API unavailable — location slug checks skipped");
  }
}

// ── Phase 4: Forbidden copy scan ─────────────────────────────────────────────

info("── Forbidden copy scan");

const forbidden = FORBIDDEN_COPY[VERTICAL] ?? [];
const foundViolations = [];
for (const [route, html] of Object.entries(pageHtml)) {
  for (const str of forbidden) {
    if (html.toLowerCase().includes(str.toLowerCase())) {
      foundViolations.push({ route, str });
    }
  }
}

if (foundViolations.length > 0) {
  fail(
    `Forbidden copy found: ${foundViolations.map((f) => `"${f.str}" on ${f.route}`).join(", ")}`,
  );
} else if (forbidden.length === 0) {
  pass("No forbidden copy to scan (or no HTML fetched)");
} else {
  pass("Forbidden copy scan complete");
}

// ── Phase 5: Social cards ────────────────────────────────────────────────────
//
// Checks what a crawler sees. Social cards are generated by Satori when media
// changes through the API, but content written straight to the database by a
// seed or an import never invokes the generator, so a tenant can ship with no
// og:image at all. That used to be invisible because the reader fell back to
// the site logo; it no longer does, and this gate is what catches it.
//
// og:image:width is only emitted for a generated social_card, so its presence
// distinguishes a real card from any other image that reached the tag.

info("── Social cards");

const OG_IMAGE = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i;
const OG_WIDTH = /<meta[^>]+property="og:image:width"[^>]+content="(\d+)"/i;

const routesWithHtml = Object.entries(pageHtml);
if (routesWithHtml.length === 0) {
  fail("No HTML fetched — social cards could not be checked");
} else {
  const missing = [];
  const notGenerated = [];
  for (const [route, html] of routesWithHtml) {
    const image = html.match(OG_IMAGE)?.[1];
    if (!image) {
      missing.push(route);
      continue;
    }
    if (html.match(OG_WIDTH)?.[1] !== "1200") notGenerated.push(route);
  }

  if (missing.length > 0) {
    fail(
      `No og:image on ${missing.length} route(s): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""}. Regenerate this organization's social cards.`,
    );
  } else if (notGenerated.length > 0) {
    fail(
      `og:image is not a generated 1200x630 social card on ${notGenerated.length} route(s): ${notGenerated.slice(0, 5).join(", ")}${notGenerated.length > 5 ? " …" : ""}`,
    );
  } else {
    pass(`Generated social card on all ${routesWithHtml.length} fetched route(s)`);
  }
}

// ── Phase 5: Required copy check ─────────────────────────────────────────────

info("── Required copy check");

const required = REQUIRED_COPY[VERTICAL] ?? [];
if (required.length > 0) {
  const allHtml = Object.values(pageHtml).join("\n");
  for (const { pattern, label } of required) {
    if (pattern.test(allHtml)) pass(`Found required copy: ${label}`);
    else fail(`Missing required copy: ${label}`);
  }
}

// ── Phase 5b: Image alt text ─────────────────────────────────────────────────
//
// Checks the alt text a crawler and a screen reader actually receive.
//
// Alt text describes what is in the picture, so the only place it can come from
// is someone looking at that picture. Every other source is a guess wearing its
// clothes, and the guesses were shipping: the NCLS import wrote media slot names
// into media_assets.alt_text (article_inline_image, home_hero_background), the
// MCP upload path fell back to the file name, and the renderers papered over
// both by borrowing the page title or the CTA label. 141 of that tenant's 142
// assets carried a machine key instead of a sentence.
//
// None of it was visible, because every image had *an* alt attribute and a
// crawler cannot tell a description from a slug. This gate can: real alt text is
// not a slug, not a file name, not the word "image", and not the same sentence
// pasted onto every picture on the site. Short is fine — a logo's alt is the
// brand name — so the rule names the words that never describe anything rather
// than banning brevity.
//
// An empty alt is deliberately NOT a failure. alt="" is the correct, meaningful
// markup for a decorative image, and HTML alone cannot distinguish one from a
// forgotten description. Failing on it would fire on every tenant with a hero
// backdrop, and a gate that cries wolf is a gate people learn to skip. Empty
// alts are counted and reported so the number stays in view.

info("── Image alt text");

const IMG_TAG = /<img\b[^>]*>/gi;
const ALT_ATTR = /\salt\s*=\s*"([^"]*)"/i;
const SRC_ATTR = /\ssrc\s*=\s*"([^"]*)"/i;
const MACHINE_KEY = /^[a-z0-9]+(?:[_.][a-z0-9]+)+$/;
const FILE_NAME = /\.(?:png|jpe?g|webp|gif|svg|avif)$/i;
const GENERIC_ALT = new Set(["image", "img", "photo", "picture", "thumbnail", "untitled", "screenshot", "graphic", "banner"]);

const ARTICLE_BODY = /<article\b[\s\S]*?<\/article>/gi;

// An image inside <article> is the content the page exists to show, so an empty
// alt there is a missing description, not a decorative one. Outside it — site
// chrome, a hero backdrop layered under text — alt="" is the correct markup.
// The distinction matters because the epoch backfill clears the machine keys
// that were standing in for alt text: without it, this gate would go quiet at
// exactly the moment 140 placed images lost their (false) descriptions.
const altBySrc = new Map();
const contentImageSrcs = new Set();
for (const html of Object.values(pageHtml)) {
  for (const tag of html.match(IMG_TAG) ?? []) {
    const src = tag.match(SRC_ATTR)?.[1];
    if (!src || src.startsWith("data:")) continue;
    if (!altBySrc.has(src)) altBySrc.set(src, tag.match(ALT_ATTR)?.[1] ?? null);
  }
  for (const body of html.match(ARTICLE_BODY) ?? []) {
    for (const tag of body.match(IMG_TAG) ?? []) {
      const src = tag.match(SRC_ATTR)?.[1];
      if (src && !src.startsWith("data:")) contentImageSrcs.add(src);
    }
  }
}

if (altBySrc.size === 0) {
  pass("No rendered images to alt-check");
} else {
  const timesUsed = new Map();
  for (const alt of altBySrc.values()) {
    const text = alt?.trim();
    if (text) timesUsed.set(text, (timesUsed.get(text) ?? 0) + 1);
  }

  const unusable = [];
  let decorative = 0;
  for (const [src, alt] of altBySrc) {
    const text = alt?.trim() ?? "";
    const where = src.slice(-60);
    if (text === "" && contentImageSrcs.has(src)) unusable.push(`no alt text on a content image — ${where}`);
    else if (text === "") decorative += 1;
    else if (MACHINE_KEY.test(text)) unusable.push(`machine key "${text}" — ${where}`);
    else if (FILE_NAME.test(text)) unusable.push(`file name "${text}" — ${where}`);
    else if (GENERIC_ALT.has(text.toLowerCase())) unusable.push(`says nothing "${text}" — ${where}`);
    else if (timesUsed.get(text) > 2) unusable.push(`"${text}" reused on ${timesUsed.get(text)} different images`);
  }

  const described = altBySrc.size - decorative - unusable.length;
  if (unusable.length > 0) {
    for (const offender of [...new Set(unusable)].slice(0, 20)) fail(`Image alt: ${offender}`);
    if (unusable.length > 20) fail(`Image alt: ${unusable.length - 20} further image(s) with unusable alt text`);
  } else {
    pass(`Alt text describes the subject on all ${described} non-decorative image(s)`);
  }
  if (decorative > 0) info(`  ${decorative} image(s) marked decorative with alt=""`);
}

// ── Phase 6: Bootstrap image URL validation ───────────────────────────────────

if (ORGANIZATION_ID) {
  info("── Bootstrap image URL validation");
  const data = await getBootstrap();

  if (data) {
    const imageUrls = new Set();
    for (const entity of [...(data.locations ?? []), ...(data.products ?? [])]) {
      for (const media of entity.media ?? []) {
        if (media.public_url) imageUrls.add(media.public_url);
        if (media.thumbnail_url) imageUrls.add(media.thumbnail_url);
      }
    }

    if (imageUrls.size === 0) {
      fail("No image URLs found in bootstrap response");
    } else {
      for (const url of imageUrls) {
        if (!url || url.startsWith("data:")) continue;
        const r = await get(url, { method: "HEAD" });
        if (r.ok) pass(`Image OK: ${url.slice(0, 80)}`);
        else fail(`Image ${r.status}: ${url.slice(0, 80)}`);
      }
    }
  }
}

// ── Phase 7: Contact data ─────────────────────────────────────────────────────

if (ORGANIZATION_ID) {
  info("── Contact data check");
  const data = await getBootstrap();

  if (data) {
    const phones = (data.locations ?? []).map((l) => l.phone).filter(Boolean);
    const emails = Object.values(data.config ?? {}).filter(
      (v) => typeof v === "string" && v.includes("@"),
    );

    if (phones.length > 0) pass(`Phone present: ${phones[0]}`);
    else fail("No phone number in any location");

    if (emails.length > 0) pass(`Email present: ${emails[0]}`);
    else pass("No contact email in site config (allowed for WhatsApp-only contact setups)");

    const allJson = JSON.stringify(data);
    if (allJson.includes("bamboo.chow@gmail.com") && ORGANIZATION_ID !== "org-bVY8SxxUuG6Ctk2CQnfCk8T2cPsj4jJX")
      fail("Kikuzuki placeholder email found in another tenant response");
    if (allJson.includes("Ember & Slice") && ORGANIZATION_ID !== "org-demo")
      fail("Demo site data (Ember & Slice) found in another tenant response");

    // Guard: static fallback phone must not be served
    if (allJson.includes("+66 81 270 2616") && !allJson.includes("bamboo")) {
      fail(
        "Static Saya fallback phone number found — location phone is not client data",
      );
    }
  }
}

// ── Phase 7b: Media manifest provenance check ─────────────────────────────────

if (OUT_DIR) {
  const mediaManifestPath = join(OUT_DIR, "media-manifest.json");
  if (existsSync(mediaManifestPath)) {
    info("── Media provenance check");
    const media = JSON.parse(await readFile(mediaManifestPath, "utf8"));
    const allHtml = Object.values(pageHtml).join("\n");

    for (const file of media.files ?? []) {
      const localExists = file.source_file
        ? existsSync(file.source_file)
        : false;
      const localLabel = localExists ? "yes" : "no";

      // HEAD check against deployed public URL
      let httpStatus = "n/a";
      if (file.public_url) {
        const r = await get(file.public_url, { method: "HEAD" });
        httpStatus = r.ok ? String(r.status) : String(r.status || "err");
      }

      const usedOnPage = file.public_url
        ? allHtml.includes(file.public_url)
        : false;

      const label = `${file.normalized_name ?? file.original_name}: local=${localLabel} public=${httpStatus} on-page=${usedOnPage ? "yes" : "no"}`;

      if (httpStatus !== "n/a" && !["200", "304"].includes(httpStatus)) {
        fail(`Media: ${label}`);
      } else {
        pass(`Media: ${label}`);
      }
    }

    if ((media.files ?? []).length === 0) {
      info("  (no media files in manifest)");
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

const summaryLine = `  ${passes} passed  ${failures} failed`;
console.log(`\n${"─".repeat(60)}`);
console.log(summaryLine);
console.log(`${"─".repeat(60)}`);

// ── Phase 8: Write report files with diffing ──────────────────────────────────

if (OUT_DIR) {
  await mkdir(OUT_DIR, { recursive: true });

  const reportJson = {
    verified_at: new Date().toISOString(),
    url: BASE,
    vertical: VERTICAL,
    organization_id: ORGANIZATION_ID ?? null,
    passes,
    failures,
    passed: failures === 0,
    results: reportResults,
  };

  // Rotate previous report
  const latestPath = join(OUT_DIR, "verify-report.latest.json");
  const previousPath = join(OUT_DIR, "verify-report.previous.json");
  const diffPath = join(OUT_DIR, "verify-diff.txt");
  const txtPath = join(OUT_DIR, "verify-report.txt");

  let previousReport = null;
  if (existsSync(latestPath)) {
    try {
      previousReport = JSON.parse(await readFile(latestPath, "utf8"));
      await writeFile(
        previousPath,
        JSON.stringify(previousReport, null, 2),
        "utf8",
      );
    } catch {
      // Ignore read/write errors
    }
  }

  await writeFile(latestPath, JSON.stringify(reportJson, null, 2), "utf8");

  // Write human-readable txt
  const txtLines = [
    "KrabiClaw Site Verification Report",
    `URL:      ${BASE}`,
    `Vertical: ${VERTICAL}`,
    `Date:     ${reportJson.verified_at}`,
    `Result:   ${failures === 0 ? "PASSED" : "FAILED"}`,
    "─".repeat(60),
    ...reportLines,
    "─".repeat(60),
    summaryLine,
  ];
  await writeFile(txtPath, txtLines.join("\n") + "\n", "utf8");

  // Generate diff vs previous run
  if (previousReport) {
    const prevByMsg = new Map(
      previousReport.results.map((r) => [r.message, r.status]),
    );
    const diffLines = [
      `Verify diff: ${previousReport.verified_at} → ${reportJson.verified_at}`,
      "─".repeat(60),
    ];
    let regressions = 0;
    let fixes = 0;
    let unchanged = 0;

    for (const r of reportResults) {
      const prev = prevByMsg.get(r.message);
      if (!prev) {
        diffLines.push(`  NEW   [${r.status.toUpperCase()}] ${r.message}`);
      } else if (prev !== r.status) {
        const arrow = r.status === "fail" ? "⬇ REGRESSED" : "⬆ FIXED";
        diffLines.push(`  ${arrow}  ${r.message}`);
        if (r.status === "fail") regressions++;
        else fixes++;
      } else {
        unchanged++;
      }
    }

    // Report checks that disappeared
    const newMsgs = new Set(reportResults.map((r) => r.message));
    for (const [msg, status] of prevByMsg) {
      if (!newMsgs.has(msg))
        diffLines.push(`  GONE  [${status.toUpperCase()}] ${msg}`);
    }

    diffLines.push("─".repeat(60));
    diffLines.push(
      `  ${regressions} regression(s)  ${fixes} fix(es)  ${unchanged} unchanged`,
    );

    await writeFile(diffPath, diffLines.join("\n") + "\n", "utf8");

    if (regressions > 0) {
      console.error(
        `\n  ⚠ ${regressions} regression(s) vs previous run — see ${relative(process.cwd(), diffPath)}`,
      );
    } else if (fixes > 0) {
      console.log(`\n  ↑ ${fixes} fix(es) vs previous run`);
    }
  }

  console.log(`\n  Reports:`);
  console.log(`    ${relative(process.cwd(), latestPath)}`);
  if (previousReport) console.log(`    ${relative(process.cwd(), diffPath)}`);
  console.log(`    ${relative(process.cwd(), txtPath)}`);
}

// ── Phase 9: Client handoff document ─────────────────────────────────────────

function formatHandoffAddress(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";

  const parts = [];
  if (Array.isArray(value.addressLines)) {
    parts.push(...value.addressLines.filter((part) => typeof part === "string" && part.trim()));
  }
  for (const key of ["locality", "administrativeArea", "postalCode", "countryCode"]) {
    const part = value[key];
    if (typeof part === "string" && part.trim()) parts.push(part.trim());
  }
  return [...new Set(parts)].join(", ");
}

function formatHandoffHours(value) {
  const hours = parseOpeningHours(typeof value === 'string' ? JSON.parse(value) : value ?? null);
  return formatOpeningHours(hours).map(row => row.day + ': ' + row.hours).join('; ');
}

if (OUT_DIR && failures === 0) {
  const clientManifestPath = join(OUT_DIR, "client-manifest.json");
  const data = await getBootstrap();

  const handoffLines = [
    `# Client Handoff: ${args.slug ?? ORGANIZATION_ID ?? BASE}`,
    "",
    `**Verified:** ${new Date().toISOString().slice(0, 10)}  `,
    `**Status:** PASSED (${passes} checks)  `,
    `**Vertical:** ${VERTICAL}  `,
    "",
    "## Live Site",
    "",
    `- URL: ${BASE}`,
    "",
  ];

  if (data?.locations?.length) {
    handoffLines.push("## Locations", "");
    for (const loc of data.locations) {
      if (typeof loc.title !== "string" || !loc.title.trim()) {
        throw new Error("Cannot generate client handoff: location title is missing");
      }
      handoffLines.push(`### ${loc.title.trim()}`);
      if (loc.phone) handoffLines.push(`- Phone: ${loc.phone}`);
      if (loc.address) {
        const address = formatHandoffAddress(loc.address);
        if (!address) throw new Error(`Cannot generate client handoff: address is malformed for ${loc.title}`);
        handoffLines.push(`- Address: ${address}`);
      }
      if (loc.maps_url) handoffLines.push(`- Maps: ${loc.maps_url}`);
      if (loc.opening_hours) {
        const hours = formatHandoffHours(loc.opening_hours);
        if (!hours) throw new Error(`Cannot generate client handoff: opening hours are malformed for ${loc.title}`);
        handoffLines.push(`- Hours: ${hours}`);
      }
      handoffLines.push("");
    }
  }

  if (data?.config) {
    const emails = Object.values(data.config).filter(
      (v) => typeof v === "string" && v.includes("@"),
    );
    if (emails.length) {
      handoffLines.push("## Contact Email", "", `- ${emails[0]}`, "");
    } else {
      handoffLines.push("## Contact Email", "", "- Not configured (WhatsApp/phone-only contact setup)", "");
    }
  }

  // Experience slugs from page HTML discovery
  const expRoutes = Object.keys(pageHtml).filter((r) =>
    r.startsWith("/experiences/"),
  );
  if (expRoutes.length) {
    handoffLines.push("## Experience Slugs", "");
    for (const r of expRoutes) handoffLines.push(`- ${BASE}${r}`);
    handoffLines.push("");
  }

  // Image count from media manifest
  const mediaManifestPath = join(OUT_DIR, "media-manifest.json");
  if (existsSync(mediaManifestPath)) {
    const media = JSON.parse(await readFile(mediaManifestPath, "utf8"));
    if (media.files?.length) {
      handoffLines.push(`## Images (${media.files.length} total)`, "");
      for (const f of media.files) {
        handoffLines.push(
          `- \`${f.public_url}\` — ${f.assigned_to} (${f.hash?.slice(0, 19) ?? "no hash"})`,
        );
      }
      handoffLines.push("");
    }
  }

  if (existsSync(clientManifestPath)) {
    const manifest = JSON.parse(await readFile(clientManifestPath, "utf8"));
    const sources = manifest.locations.map(location => location.source_url).filter(Boolean);
    if (sources.length) {
      handoffLines.push("## Google Source URLs", "");
      for (const s of sources) handoffLines.push(`- ${s}`);
      handoffLines.push("");
    }
  }

  // Missing fields
  const missingPath = join(OUT_DIR, "missing-fields.json");
  if (existsSync(missingPath)) {
    const missing = JSON.parse(await readFile(missingPath, "utf8"));
    if (missing.length) {
      handoffLines.push("## Known Missing Fields", "");
      for (const m of missing)
        handoffLines.push(
          `- **${m.location}**: ${m.field}${m.issue ? ` (${m.issue})` : ""}`,
        );
      handoffLines.push("");
    } else {
      handoffLines.push("## Known Missing Fields", "", "- None", "");
    }
  }

  handoffLines.push(
    "## Verification Summary",
    "",
    `${passes} checks passed, ${failures} failed.`,
  );

  const handoffPath = join(OUT_DIR, "client-handoff.md");
  await writeFile(handoffPath, handoffLines.join("\n") + "\n", "utf8");
  console.log(
    `    ${relative(process.cwd(), handoffPath)}  ← client handoff ready`,
  );
}

if (failures > 0) {
  console.error(`\n  FAILED — fix the issues above before shipping\n`);
  process.exit(1);
} else {
  console.log(`\n  PASSED — organization looks good\n`);
  process.exit(0);
}
