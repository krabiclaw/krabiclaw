#!/usr/bin/env node
/**
 * Deterministic client import pipeline for KrabiClaw.
 *
 * Always runs --dry-run first to produce a reviewable manifest before any DB writes.
 *
 * Usage:
 *   node scripts/client-import.mjs \
 *     --slug pottery-house-krabi \
 *     --brand-name "Pottery House Krabi" \
 *     --vertical experience \
 *     --maps-url "https://www.google.com/maps/place/Pottery+House+Krabi/..." \
 *     --maps-url "https://www.google.com/maps/place/Beachfront+Pottery+Krabi/..." \
 *     --images ./new-client-Pottery-House-Krabi \
 *     --dry-run
 *
 * Environment variables:
 *   GOOGLE_PLACES_API_KEY  — required for Google Places lookup
 *
 * Outputs (in client-imports/<slug>/):
 *   client-manifest.json   — extracted business facts from Google Places
 *   media-manifest.json    — normalized image list ready for upload
 *   seed-preview.sql       — proposed INSERT statements (review before applying)
 *   missing-fields.json    — fields that could not be determined
 *   copy-scan.txt          — forbidden copy check against proposed seed
 */

import { parseArgs } from "node:util";
import { readdir, stat, lstat, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnYarn } from "./utils/spawn-yarn.mjs";
import { ALL_VERTICALS } from "../utils/vertical-copy.ts";
import { resolvePublicTemplate } from "../utils/template-registry.ts";
import { normalizeGoogleOpeningHours } from "../shared/reservation-hours.ts";
import { normalizeGoogleReview } from "../shared/google-review.ts";
import { prepareD1SeedFile } from "./utils/d1-seed-file.mjs";


const { values: rawArgs } = parseArgs({
  options: {
    slug: { type: "string" },
    "brand-name": { type: "string" },
    "organization-id": { type: "string" },
    vertical: { type: "string", default: "restaurant" },
    "maps-url": { type: "string", multiple: true, default: [] },
    images: { type: "string" },
    "images-place-id": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    approve: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
    "base-url": { type: "string" },
    email: { type: "string" },
  },
  allowPositionals: true,
});

const SLUG = rawArgs.slug;
const BRAND_NAME = rawArgs["brand-name"]?.trim();
const ORGANIZATION_ID = rawArgs["organization-id"]?.trim();

const SLUG_SAFE_PATTERN = /^[a-zA-Z0-9_-]+$/;
if (!SLUG_SAFE_PATTERN.test(SLUG)) {
  console.error(
    "Error: --slug contains invalid characters. Only letters, digits, hyphens, and underscores are allowed.",
  );
  process.exit(1);
}
const VERTICAL = rawArgs.vertical;
const MAPS_URLS = rawArgs["maps-url"] ?? [];
const IMAGES_DIR = rawArgs.images;
const REMOTE = rawArgs.remote ?? false;

if (VERTICAL && !ALL_VERTICALS.includes(VERTICAL)) {
  console.error(
    `Error: Invalid vertical "${VERTICAL}". Must be one of: ${ALL_VERTICALS.join(", ")}`,
  );
  process.exit(1);
}

const MODE = rawArgs.approve ? "approve" : rawArgs.apply ? "apply" : "dry-run";

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
if (MODE === "dry-run" && !BRAND_NAME) throw new Error("--brand-name is required; site identity must be supplied explicitly");

if (!SLUG) {
  console.error("Error: --slug is required");
  console.error(
    "Usage: node scripts/client-import.mjs --slug <slug> [--dry-run | --approve | --apply] [--remote]",
  );
  process.exit(1);
}
if (!ORGANIZATION_ID || !SLUG_SAFE_PATTERN.test(ORGANIZATION_ID)) {
  console.error("Error: --organization-id is required and must be the existing Better Auth organization ID.");
  process.exit(1);
}

const OUT_DIR = join(process.cwd(), "client-imports", SLUG);
await mkdir(OUT_DIR, { recursive: true });


// ── Route parity check ────────────────────────────────────────────────────────

const CONTENT_TYPES = ["products", "posts", "menu", "experiences", "locations", "reviews"];

function checkRouteParity() {
  const issues = [];

  for (const ct of CONTENT_TYPES) {
    const indexFile = join(process.cwd(), "pages", ct, "index.vue");
    const slugFile = join(process.cwd(), "pages", ct, "[slug].vue");
    const flatFile = join(process.cwd(), "pages", `${ct}.vue`);

    const hasIndex = existsSync(indexFile);
    const hasSlug = existsSync(slugFile);
    const hasFlat = existsSync(flatFile);

    // Conflict: flat file + slug file = broken nested routing (the experiences bug)
    if (hasFlat && hasSlug) {
      issues.push({
        type: "ERROR",
        message: `pages/${ct}.vue conflicts with pages/${ct}/[slug].vue — move to pages/${ct}/index.vue`,
      });
    }
    // Conflict: flat file + directory index = duplicate routes
    if (hasFlat && hasIndex) {
      issues.push({
        type: "ERROR",
        message: `pages/${ct}.vue and pages/${ct}/index.vue both exist — remove one`,
      });
    }
    // Warn: has slug routes but only flat index (no directory index alongside slug)
    if (hasFlat && !hasIndex && hasSlug) {
      issues.push({
        type: "WARN",
        message: `pages/${ct}.vue exists alongside pages/${ct}/[slug].vue — consider moving to pages/${ct}/index.vue`,
      });
    }
    // Warn: has directory index but no slug page for detail-capable content types
    if (hasIndex && !hasSlug && ["experiences", "posts"].includes(ct)) {
      issues.push({
        type: "WARN",
        message: `pages/${ct}/[slug].vue does not exist — detail pages will 404`,
      });
    }
  }

  return issues;
}


function extractPlaceIdFromUrl(url) {
  const explicitId = new URL(url).searchParams.get("query_place_id");
  if (explicitId) return explicitId;
  const chijMatch = url.match(/!1s(ChIJ[^!&%]+)/);
  if (chijMatch) {
    try {
      return decodeURIComponent(chijMatch[1]);
    } catch {
      return chijMatch[1];
    }
  }
  return null;
}

function extractBusinessNameFromUrl(url) {
  try {
    const u = new URL(url);
    const pathParts = u.pathname.split("/");
    const placeIdx = pathParts.indexOf("place");
    if (placeIdx >= 0 && pathParts[placeIdx + 1]) {
      return decodeURIComponent(pathParts[placeIdx + 1].replace(/\+/g, " "));
    }
  } catch {
    // Ignore invalid URLs
  }
  return null;
}

async function resolveShortUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.url;
  } catch {
    clearTimeout(timeout);
    return url;
  }
}

async function fetchPlaceDetails(placeId) {
  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": "id,displayName,formattedAddress,addressComponents,location,googleMapsUri,nationalPhoneNumber,internationalPhoneNumber,websiteUri,rating,userRatingCount,regularOpeningHours,reviews,timeZone",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Google Places details failed for ${placeId}: HTTP ${response.status}`);
  return response.json();
}

async function resolvePlace(rawUrl) {
  let url = rawUrl;

  // Follow short URLs
  if (url.includes("maps.app.goo.gl") || url.includes("goo.gl")) {
    console.log(`  Resolving short URL: ${url}`);
    url = await resolveShortUrl(url);
    console.log(`  Expanded to: ${url}`);
  }

  const name = extractBusinessNameFromUrl(url);
  const placeId = extractPlaceIdFromUrl(url);

  if (!placeId || !API_KEY) {
    return {
      source_url: rawUrl,
      name: name ?? null,
      error: API_KEY
        ? "Provide a Maps URL containing an explicit place ID (!1sChIJ... or query_place_id=...). Location selection is required."
        : "GOOGLE_PLACES_API_KEY not set — skipping Places API lookup",
    };
  }

  console.log(`  Place ID: ${placeId}`);
  const details = await fetchPlaceDetails(placeId);

  if (details.id !== placeId || !details.displayName?.text) throw new Error(`Google Places returned invalid identity for ${placeId}`);

  return {
    source_url: rawUrl,
    place_id: details.id,
    name: details.displayName?.text ?? null,
    formatted_address: details.formattedAddress ?? null,
    address_components: details.addressComponents ?? [],
    timezone: details.timeZone?.id ?? null,
    phone: details.nationalPhoneNumber ?? null,
    international_phone: details.internationalPhoneNumber ?? null,
    website: details.websiteUri ?? null,
    rating: details.rating ?? null,
    user_ratings_total: details.userRatingCount ?? null,
    lat: details.location?.latitude ?? null,
    lng: details.location?.longitude ?? null,
    opening_hours: normalizeGoogleOpeningHours(details.regularOpeningHours?.periods),
    reviews: (details.reviews ?? []).map(normalizeGoogleReview),
    maps_url: details.googleMapsUri ?? null,
    _raw: details,
  };
}

// ── Image scanning ────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

const MIME_MAP = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

function normalizeFilename(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9.\-_]/g, "")
    .replace(/-+/g, "-");
}

async function scanImages(dir) {
  if (!dir || !existsSync(dir)) {
    return { error: `Image directory not found: ${dir}`, files: [] };
  }

  // Resolve and normalize path to prevent traversal attacks
  const resolvedPath = join(process.cwd(), dir);
  const normalizedPath = join(resolvedPath);

  // Reject absolute paths or paths outside cwd
  if (
    dir.startsWith("/") ||
    dir.startsWith("..") ||
    !normalizedPath.startsWith(process.cwd())
  ) {
    return { error: `Invalid image directory path: ${dir}`, files: [] };
  }

  const dirStat = await stat(resolvedPath);
  const entries = (await readdir(resolvedPath)).sort();
  const files = [];

  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;

    const fullPath = join(resolvedPath, entry);
    const info = await lstat(fullPath);

    if (!info.isFile() || info.isSymbolicLink()) {
      continue;
    }
    const normalName = normalizeFilename(basename(entry, ext)) + ext;
    if (files.some(file => file.normalized_name === normalName)) throw new Error(`Duplicate normalized image filename: ${normalName}`);

    const contents = await readFile(fullPath);
    const hash = createHash("sha256").update(contents).digest("hex");

    const assignedTo = files.length === 0 ? "hero" : `gallery-${files.length}`;
    const r2Key = `organizations/${ORGANIZATION_ID}/media/${normalName}`;

    files.push({
      source_file: fullPath,
      original_name: entry,
      normalized_name: normalName,
      r2_key: r2Key,
      public_url: `https://media.krabiclaw.com/${r2Key}`,
      assigned_to: assignedTo,
      place_id: rawArgs["images-place-id"] ?? null,
      alt_text: null,
      hash: `sha256:${hash}`,
      size_bytes: info.size,
      uploaded_at: null,
    });
  }

  return {
    directory: dir,
    dir_mtime: dirStat.mtime.toISOString(),
    total: files.length,
    files,
  };
}

// ── Missing fields detection ──────────────────────────────────────────────────

function detectMissingFields(places) {
  const missing = [];

  for (const place of places) {
    if (place.error) {
      missing.push({
        location: place.name,
        field: "place_data",
        issue: place.error,
      });
      continue;
    }
    if (!place.phone && !place.international_phone)
      missing.push({ location: place.name, field: "phone" });
    if (!place.email)
      missing.push({
        location: place.name,
        field: "email",
        issue: "Not returned by Google Places API — supply via overrides.json",
      });
    if (!place.timezone) missing.push({ location: place.name, field: "timezone" });
    if (!place.opening_hours)
      missing.push({ location: place.name, field: "opening_hours" });
    if (!place.lat || !place.lng)
      missing.push({ location: place.name, field: "coordinates" });
    if (!place.formatted_address)
      missing.push({ location: place.name, field: "address" });
    if (!place.reviews?.length)
      missing.push({
        location: place.name,
        field: "reviews",
        issue: "No reviews returned from API",
      });
  }

  return missing;
}

// ── Forbidden copy scan ───────────────────────────────────────────────────────

const FORBIDDEN_BY_VERTICAL = {
  experience: [
    "restaurant",
    "kitchen",
    "dining",
    "chef",
    "menu",
    "table reservation",
    "catering",
    "dine",
    "Come dine",
    "From the kitchen",
    "Reserve a table",
    "one kitchen philosophy",
    "Dietary needs.*preferred seating",
  ],
  restaurant: [],
  retail: [],
  wellness: [],
  service: [
    "Come dine",
    "From the kitchen",
    "Reserve a table",
    "chef's table",
    "tasting menu",
    "one kitchen philosophy",
    "Also part of Saya",
  ],
};

function scanForbiddenCopy(sql, vertical) {
  const patterns = FORBIDDEN_BY_VERTICAL[vertical] ?? [];
  const hits = [];

  for (const pattern of patterns) {
    const re = new RegExp(pattern, "i");
    const lines = sql.split("\n");
    lines.forEach((line, i) => {
      if (re.test(line) && !line.trim().startsWith("--")) {
        hits.push({ pattern, line: i + 1, text: line.trim().slice(0, 100) });
      }
    });
  }

  return hits;
}

// ── Seed SQL generation ───────────────────────────────────────────────────────

function generateSeedSql(places, mediaManifest) {
  const orgId = ORGANIZATION_ID;
  const now = new Date().toISOString();

  const brandName = BRAND_NAME;

  const unresolved = places.filter((place) => place.error);
  if (unresolved.length) {
    throw new Error(`Cannot generate a seed with unresolved places: ${unresolved.map((place) => place.error).join("; ")}`);
  }

  const locationInserts = places
    .map((place, idx) => {
      const locId = `loc-${SLUG}-${idx}`;
      const phone = place.international_phone ?? place.phone ?? "NULL";
      const address = place.formatted_address
        ? `'${place.formatted_address.replace(/'/g, "''")}'`
        : "NULL";
      const mapsUrl = place.maps_url
        ? `'${place.maps_url.replace(/'/g, "''")}'`
        : "NULL";
      const lat = place.lat ?? "NULL";
      const lng = place.lng ?? "NULL";
      const hours = place.opening_hours
        ? `'${JSON.stringify(place.opening_hours).replace(/'/g, "''")}'`
        : "NULL";
      const timezone = place.timezone ? "'" + place.timezone.replace(/'/g, "''") + "'" : "NULL";
      const rating = place.rating ?? "NULL";
      const ratingCount = place.user_ratings_total ?? "NULL";
      const email = place.email
        ? `'${place.email.replace(/'/g, "''")}'`
        : "NULL";
      const slug = (place.name ?? "location")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const placeId = place.place_id
        ? `'${place.place_id.replace(/'/g, "''")}'`
        : "NULL";
      const lastSyncedAt = place.place_id ? `'${now}'` : "NULL";

      return `-- Location: ${place.name}
INSERT INTO business_locations (
  id, organization_id, slug, title, address, phone, email,
  maps_url, latitude, longitude, opening_hours, timezone,
  rating, review_count, google_place_id, last_synced_at, status
) VALUES (
  '${locId}', '${orgId}',
  '${slug}', '${(place.name ?? "").replace(/'/g, "''")}',
  ${address}, ${phone === "NULL" ? "NULL" : `'${phone}'`}, ${email},
  ${mapsUrl}, ${lat}, ${lng}, ${hours}, ${timezone},
  ${rating}, ${ratingCount}, ${placeId}, ${lastSyncedAt}, 'active'
) ON CONFLICT(id) DO UPDATE SET
  title = excluded.title, address = excluded.address,
  phone = excluded.phone, email = excluded.email, maps_url = excluded.maps_url,
  latitude = excluded.latitude, longitude = excluded.longitude,
  opening_hours = excluded.opening_hours, timezone = excluded.timezone,
  rating = excluded.rating, review_count = excluded.review_count,
  google_place_id = excluded.google_place_id, last_synced_at = excluded.last_synced_at,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');`;
    })
    .join("\n\n");

  const mediaAssets = mediaManifest.files
    .map((f, i) => {
      const assetId = `asset-${SLUG}-${i}`;
      const r2Key = f.r2_key;
      const publicUrl = `https://media.krabiclaw.com/${r2Key}`;
      const ext = f.normalized_name.split(".").pop()?.toLowerCase() ?? "";
      const mimeType = MIME_MAP[ext] ?? "application/octet-stream";
      return `INSERT INTO media_assets (id, organization_id, r2_key, public_url, file_name, mime_type, alt_text, kind, provider, source, status)
VALUES ('${assetId}', '${orgId}', '${r2Key}', '${publicUrl}', '${f.normalized_name}', '${mimeType}', '${brandName.replace(/'/g, "''")}', 'image', 'cloudflare_r2', 'uploaded', 'active')
ON CONFLICT(id) DO UPDATE SET
  r2_key = excluded.r2_key,
  public_url = excluded.public_url,
  file_name = excluded.file_name,
  mime_type = excluded.mime_type,
  alt_text = excluded.alt_text,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');`;
    })
    .join("\n");

  const reviewInserts = places.flatMap((place, index) => place.reviews.map(review => {
    const locationId = `loc-${SLUG}-${index}`;
    const values = [`gplaces-${locationId}-${review.google_review_id.replaceAll('/', '-')}`, orgId, locationId,
      review.google_review_id, review.author_name, review.rating, review.content, review.original_review_date,
      review.original_reference, JSON.stringify(review.google_review_metadata), now, now];
    const literal = value => value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
    return `INSERT INTO reviews (id, organization_id, location_id, google_review_id, author_name, rating, content, original_review_date, original_reference, google_review_metadata, created_at, updated_at, source, status)
VALUES (${values.map(literal).join(', ')}, 'google_places', 'approved')
ON CONFLICT(organization_id, location_id, google_review_id) DO UPDATE SET
  author_name=excluded.author_name, rating=excluded.rating, content=excluded.content, original_review_date=excluded.original_review_date,
  original_reference=excluded.original_reference, google_review_metadata=excluded.google_review_metadata, updated_at=excluded.updated_at;`;
  })).join('\n');
  if (mediaManifest.files.length > 51) throw new Error("A location supports one hero and at most 50 gallery images");
  const placements = mediaManifest.files.map((file, index) => {
    const locationIndex = places.findIndex(place => place.place_id === file.place_id);
    if (locationIndex < 0) throw new Error(`Image ${file.original_name} requires --images-place-id matching an imported place`);
    const locationId = `loc-${SLUG}-${locationIndex}`;
    const slot = index === 0 ? 'hero' : 'gallery';
    return `INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, status)
VALUES ('placement-${SLUG}-${index}', '${orgId}', 'business_location', '${locationId}', '${slot}', 'asset-${SLUG}-${index}', ${index === 0 ? 0 : index - 1}, 'active')
ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, slot=excluded.slot, asset_id=excluded.asset_id, sort_order=excluded.sort_order;`;
  }).join('\n');

  return `-- ============================================================
-- Seed: ${SLUG}  (vertical: ${VERTICAL})
-- Generated: ${now}
-- REVIEW CAREFULLY before applying — DO NOT run without checking
-- ============================================================

-- The tenant itself
UPDATE organization SET
  name = '${brandName.replace(/'/g, "''")}',
  theme_id = '${resolvePublicTemplate({ vertical: VERTICAL }).themeId}',
  subdomain = '${SLUG}',
  status = 'active',
  onboarding_status = 'active',
  default_currency = 'USD',
  vertical = '${VERTICAL}',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = '${orgId}';

-- Domains
INSERT INTO organization_domains (id, organization_id, domain, type, role, status, dns_status)
VALUES
  ('domain-${SLUG}-local', '${orgId}', '${SLUG}.localhost', 'subdomain', 'secondary', 'active', 'valid'),
  ('domain-${SLUG}-prod', '${orgId}', '${SLUG}.krabiclaw.com', 'subdomain', 'canonical', 'active', 'valid')
ON CONFLICT(id) DO NOTHING;

-- Locales
INSERT INTO organization_locales (id, organization_id, locale, label, is_source, status)
VALUES
  ('locale::${orgId}::en', '${orgId}', 'en', 'English', 1, 'published'),
  ('locale::${orgId}::th', '${orgId}', 'th', 'ไทย', 0, 'published')
ON CONFLICT(id) DO NOTHING;

-- Locations
${locationInserts}

-- Approved client media, explicit location placements, and Google reviews
${mediaAssets}
${placements}
${reviewInserts}
`;
}

// ── Route manifest ────────────────────────────────────────────────────────────

function generateRouteManifest(places) {
  const locations = places
    .filter((p) => !p.error)
    .map((p) => {
      const slug = (p.name ?? "location")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return `/locations/${slug}`;
    });

  const manifest = {
    generated_at: new Date().toISOString(),
    slug: SLUG,
    vertical: VERTICAL,
    locations,
    services: VERTICAL === "service" ? ["/services"] : [],
    tenant_pages:
      VERTICAL === "service"
        ? [
            "/about",
            "/pricing",
            "/donate",
            "/schedule",
            "/contact",
            "/blog",
            "/policies/privacy",
            "/policies/terms",
            "/third-party-notices",
          ]
        : [],
    // Experience slugs come from the experiences table; verify via bootstrap post-seed.
    experiences: [],
  };

  if (VERTICAL === "experience") {
    manifest._note =
      "Run client:verify --organization-id to discover experience slugs via bootstrap API";
  }

  return manifest;
}

// ── D1 row-count query (best-effort, for overwrite visibility) ────────────────

// wrangler's --json output is a single top-level array whose own "results"
// field is itself an array — a non-greedy [\s\S]*? match stops at the first
// `]` it finds, which is the inner results array's close, producing truncated,
// unparseable JSON. Slicing from the first `[` to the *last* `]` in the output
// captures the whole structure instead.
function extractD1JsonArray(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
}

function queryD1Count(table, organizationId, remote) {
  const flag = remote ? "--remote" : "--local";
  try {
    const result = spawnYarn(
      [
        "wrangler",
        "d1",
        "execute",
        "DB",
        flag,
        "--command",
        `SELECT COUNT(*) as n FROM ${table} WHERE organization_id = '${organizationId}'`,
        "--json",
      ],
      { encoding: "utf8", cwd: process.cwd() },
    );
    if (result.status !== 0) return null;
    const arr = extractD1JsonArray(result.stdout + (result.stderr ?? ""));
    const n = arr?.[0]?.results?.[0]?.n;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

// ── D1 single-row lookup (best-effort, for pre-apply ownership checks) ────────

// Throws on any query execution or parsing failure — this is used for
// tenant-boundary safety gates, where a failed lookup must abort the import,
// never be silently treated the same as "no matching row exists."
function queryD1Row(query, remote) {
  const flag = remote ? "--remote" : "--local";
  const result = spawnYarn(
    ["wrangler", "d1", "execute", "DB", flag, "--command", query, "--json"],
    { encoding: "utf8", cwd: process.cwd() },
  );
  if (result.error) {
    throw new Error(`D1 query failed to execute: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `D1 query exited with status ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  const arr = extractD1JsonArray(result.stdout + (result.stderr ?? ""));
  if (!arr) {
    throw new Error(
      `D1 query returned unparseable output: ${result.stdout.slice(0, 500)}`,
    );
  }
  return arr[0]?.results?.[0] ?? null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(
  `\n┌─ KrabiClaw Client Import ─────────────────────────────────────`,
);
console.log(`│  Slug:     ${SLUG}`);
console.log(`│  Vertical: ${VERTICAL}`);
console.log(`│  Mode:     ${MODE}${REMOTE ? " (remote DB)" : " (local DB)"}`);
console.log(
  `└──────────────────────────────────────────────────────────────\n`,
);

// ── Approve mode ─────────────────────────────────────────────────────────────

if (MODE === "approve") {
  const manifestPath = join(OUT_DIR, "client-manifest.json");
  const seedPath = join(OUT_DIR, "seed-preview.sql");

  if (!existsSync(manifestPath) || !existsSync(seedPath)) {
    console.error(
      "Error: No dry-run output found. Run --dry-run first to generate manifests.",
    );
    process.exit(1);
  }

  const manifestContent = await readFile(manifestPath, "utf8");
  const seedContent = await readFile(seedPath, "utf8");
  const hash = createHash("sha256")
    .update(manifestContent)
    .update(seedContent)
    .update(await readFile(join(OUT_DIR, "media-manifest.json"), "utf8"))
    .digest("hex");

  const mediaMeta = JSON.parse(await readFile(join(OUT_DIR, "media-manifest.json"), "utf8"));

  const approved = {
    approved: true,
    approved_by: process.env.USER ?? "unknown",
    approved_at: new Date().toISOString(),
    manifest_hash: hash,
    slug: SLUG,
    vertical: VERTICAL,
    api_key_available: !!process.env.GOOGLE_PLACES_API_KEY,
    media_dir: mediaMeta?.directory ?? null,
    media_dir_mtime: mediaMeta?.dir_mtime ?? null,
    media_count: mediaMeta.files.length,
  };

  const approvedPath = join(OUT_DIR, "approved.json");
  await writeFile(approvedPath, JSON.stringify(approved, null, 2), "utf8");

  console.log(`✓ Approval recorded: ${approvedPath}`);
  console.log(`  manifest_hash: ${hash}`);
  console.log(`\nNext: yarn client:import --slug ${SLUG} --organization-id ${ORGANIZATION_ID} --apply`);
  process.exit(0);
}


if (MODE === "apply") {
  const baseUrl = rawArgs["base-url"] || (REMOTE ? null : "http://localhost:3000");
  if (!baseUrl) throw new Error("Remote import verification requires --base-url for the target application.");
  if (!process.env.CANARY_LOGIN_PASSWORD) throw new Error("CANARY_LOGIN_PASSWORD is required to generate and verify imported social cards.");
  const approvedPath = join(OUT_DIR, "approved.json");
  const seedPath = join(OUT_DIR, "seed-preview.sql");
  const manifestPath = join(OUT_DIR, "client-manifest.json");

  // Gate 1: approved.json must exist
  if (!existsSync(approvedPath)) {
    console.error(
      "Error: No approved.json found. Run --approve first after reviewing the dry-run output.",
    );
    process.exit(1);
  }

  const approvedRaw = JSON.parse(await readFile(approvedPath, "utf8"));
  if (!approvedRaw.approved) {
    console.error(
      "Error: approved.json has approved: false — set it to true before applying.",
    );
    process.exit(1);
  }

  // Gate 2: hash verification
  if (!existsSync(manifestPath) || !existsSync(seedPath)) {
    console.error(
      "Error: Manifest or seed files missing. Re-run --dry-run and --approve.",
    );
    process.exit(1);
  }

  const manifestContent = await readFile(manifestPath, "utf8");
  const seedContent = await readFile(seedPath, "utf8");
  const currentHash = createHash("sha256")
    .update(manifestContent)
    .update(seedContent)
    .update(await readFile(join(OUT_DIR, "media-manifest.json"), "utf8"))
    .digest("hex");

  if (currentHash !== approvedRaw.manifest_hash) {
    console.error(
      "Error: Manifest hash mismatch — the dry-run output has changed since approval.",
    );
    console.error(
      "  Re-run --dry-run and --approve to refresh the approval for the current output.",
    );
    process.exit(1);
  }

  // Gate 3: stale approval timestamp
  const approvedFileStat = await stat(approvedPath);
  const manifestFileStat = await stat(manifestPath);
  const seedFileStat = await stat(seedPath);
  const latestManifestMs = Math.max(
    manifestFileStat.mtimeMs,
    seedFileStat.mtimeMs,
  );

  if (latestManifestMs > approvedFileStat.mtimeMs) {
    const newerFile =
      manifestFileStat.mtimeMs > seedFileStat.mtimeMs
        ? "client-manifest.json"
        : "seed-preview.sql";
    console.error(
      `Error: ${newerFile} is newer than approved.json — manifests changed after approval.`,
    );
    console.error("  Re-run --dry-run and --approve.");
    process.exit(1);
  }

  if ("api_key_available" in approvedRaw) {
    const keyNow = !!process.env.GOOGLE_PLACES_API_KEY;
    if (keyNow !== approvedRaw.api_key_available) {
      const was = approvedRaw.api_key_available ? "available" : "unavailable";
      const now = keyNow ? "available" : "unavailable";
      console.error(
        `Error: GOOGLE_PLACES_API_KEY was ${was} during dry-run but is ${now} now.`,
      );
      console.error(
        "  Re-run --dry-run and --approve to regenerate with current API access.",
      );
      process.exit(1);
    }
  }

  // Gate 5: media folder changed after approval
  if (approvedRaw.media_dir && existsSync(approvedRaw.media_dir)) {
    const currentDirStat = await stat(approvedRaw.media_dir);
    if (currentDirStat.mtime.toISOString() !== approvedRaw.media_dir_mtime) {
      console.error(
        `Error: Image directory was modified after approval: ${approvedRaw.media_dir}`,
      );
      console.error(
        "  Re-run --dry-run and --approve if image changes are intentional.",
      );
      process.exit(1);
    }
  }

  // Gate 6: approval invalidated by override
  if (approvedRaw.invalidated) {
    console.error(
      `Error: Approval was invalidated — ${approvedRaw.invalidated_reason ?? "overrides changed after approval"}`,
    );
    console.error(
      "  Re-run --approve after reviewing the regenerated manifests.",
    );
    process.exit(1);
  }

  const media = JSON.parse(await readFile(join(OUT_DIR, "media-manifest.json"), "utf8"));
  if (!media.files?.length) throw new Error("Client images are required before applying an import");
  for (const file of media.files) {
    const bytes = await readFile(file.source_file);
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== file.hash) throw new Error(`Image changed after approval: ${file.original_name}`);
  }

  {
    const org = queryD1Row(
      `SELECT id, subdomain FROM organization WHERE id = '${ORGANIZATION_ID}'`,
      REMOTE,
    );
    if (!org) {
      console.error(
        `Error: organization '${ORGANIZATION_ID}' was not found. Check --organization-id.`,
      );
      process.exit(1);
    }
    // The subdomain is the tenant's address, and this import claims it. An
    // organization already answering on a different one is not the tenant the
    // caller named, so the import stops rather than moving someone's address.
    if (org.subdomain && org.subdomain !== SLUG) {
      console.error(
        `Error: organization '${ORGANIZATION_ID}' already serves '${org.subdomain}', not '${SLUG}'.`,
      );
      console.error(
        "  Re-check --slug and --organization-id — this import would otherwise move a live address.",
      );
      process.exit(1);
    }
  }

  console.log(`✓ All gates passed (hash: ${currentHash.slice(0, 12)}…)`);
  console.log(
    `  Approved by: ${approvedRaw.approved_by} at ${approvedRaw.approved_at}`,
  );

  const config = await readFile('wrangler.toml', 'utf8');
  const bucket = [...config.matchAll(/\[\[r2_buckets\]\]([^]*?)(?=\n\[|$)/g)]
    .find(match => /binding\s*=\s*"MEDIA_BUCKET"/.test(match[1]))?.[1].match(/bucket_name\s*=\s*"([^"]+)"/)?.[1];
  if (!bucket) throw new Error('MEDIA_BUCKET is missing from wrangler.toml');
  for (const file of media.files) {
    const mimeType = MIME_MAP[extname(file.normalized_name).slice(1)];
    const result = spawnYarn(['wrangler', 'r2', 'object', 'put', `${bucket}/${file.r2_key}`, REMOTE ? '--remote' : '--local', '--file', file.source_file, '--content-type', mimeType]);
    if (result.status !== 0) throw new Error(`Client image upload failed: ${file.original_name}`);
  }

  const TRACKED = [
    "business_locations",
    "reviews",
    "content_documents",
    "media_assets",
    "experiences",
  ];
  const before = {};
  console.log("\n→ Querying current row counts...");
  for (const table of TRACKED) {
    before[table] = queryD1Count(table, ORGANIZATION_ID, REMOTE) ?? "?";
  }

  console.log(
    `\n→ Executing seed SQL against ${REMOTE ? "remote" : "local"} D1...`,
  );
  const d1Flag = REMOTE ? "--remote" : "--local";
  const preparedSeed = await prepareD1SeedFile(seedPath);
  if (preparedSeed.splitCount) {
    console.log(`  Split ${preparedSeed.splitCount} oversized INSERT statement chunk(s) for D1 execution.`);
  }
  let applyResult;
  try {
    applyResult = spawnYarn(["wrangler", "d1", "execute", "DB", d1Flag, "--file", preparedSeed.path]);
  } finally {
    await preparedSeed.cleanup();
  }
  if (applyResult.status !== 0) {
    console.error("\n✗ Seed execution failed — check wrangler output above.");
    process.exit(1);
  }

  // Overwrite visibility — query after
  const after = {};
  for (const table of TRACKED) {
    after[table] = queryD1Count(table, ORGANIZATION_ID, REMOTE) ?? "?";
  }

  // Print diff table
  const anyCountsAvailable = TRACKED.some((t) => typeof before[t] === "number");
  if (anyCountsAvailable) {
    console.log("\n  Table                  before   after   delta");
    console.log("  " + "─".repeat(48));
    for (const table of TRACKED) {
      const b = before[table];
      const a = after[table];
      const delta =
        typeof b === "number" && typeof a === "number"
          ? a - b > 0
            ? `+${a - b}`
            : String(a - b)
          : "?";
      console.log(
        `  ${table.padEnd(22)} ${String(b).padStart(6)}   ${String(a).padStart(5)}   ${String(delta).padStart(5)}`,
      );
    }
  }

  const cardArgs = ["local:cards", "--base-url", baseUrl, "--organization-id", ORGANIZATION_ID];
  if (rawArgs.email) cardArgs.push("--email", rawArgs.email);
  const cards = spawnYarn(cardArgs);
  if (cards.status !== 0) throw new Error("Seed applied, but social-card generation failed. Import handoff is incomplete.");
  const verification = spawnYarn(["client:verify", "--url", baseUrl, "--vertical", VERTICAL, "--organization-id", ORGANIZATION_ID, "--slug", SLUG, "--tenant-slug", SLUG]);
  if (verification.status !== 0) throw new Error("Seed applied, but client verification failed. Import handoff is incomplete.");
  console.log("\nSeed, social cards, and public verification completed.");
  process.exit(0);
}

// ── Step 1: Route parity ─────────────────────────────────────────────────────

console.log("→ Checking route parity...");
const parityIssues = checkRouteParity();
if (parityIssues.length === 0) {
  console.log("  ✓ All route files look correct");
} else {
  for (const issue of parityIssues) {
    const icon = issue.type === "ERROR" ? "✗" : "⚠";
    console.log(`  ${icon} [${issue.type}] ${issue.message}`);
  }
}

// ── Step 2: Google Places ────────────────────────────────────────────────────

console.log("\n→ Resolving Google Places data...");

if (!API_KEY) {
  console.log(
    "  ⚠ GOOGLE_PLACES_API_KEY not set — Places API calls will be skipped",
  );
}

const places = [];
for (const url of MAPS_URLS) {
  console.log(`  Resolving: ${url.slice(0, 80)}...`);
  const place = await resolvePlace(url);
  places.push(place);
  if (place.name && !place.error) {
    console.log(`  ✓ ${place.name} (${place.phone ?? "no phone"})`);
  } else {
    console.log(`  ⚠ ${place.error ?? "Unknown error"}`);
  }
}

if (places.length === 0) {
  console.log("  ⚠ No Maps URLs provided — location data will be empty");
}

// ── Step 3: Image scan ───────────────────────────────────────────────────────

console.log("\n→ Scanning images...");
const mediaManifest = await scanImages(IMAGES_DIR);

if (mediaManifest.error) {
  console.log(`  ⚠ ${mediaManifest.error}`);
  console.log("Provide --images <dir> and --images-place-id <place-id>. Apply requires client photos.");
} else {
  console.log(
    `  ✓ Found ${mediaManifest.total} images in ${mediaManifest.directory}`,
  );
  for (const f of mediaManifest.files.slice(0, 5)) {
    console.log(`    ${f.original_name} → ${f.normalized_name}`);
  }
  if (mediaManifest.files.length > 5) {
    console.log(`    ... and ${mediaManifest.files.length - 5} more`);
  }
}

// ── Step 3b: Apply overrides ─────────────────────────────────────────────────

const overridesPath = join(OUT_DIR, "overrides.json");
if (existsSync(overridesPath)) {
  const overrides = JSON.parse(await readFile(overridesPath, "utf8"));
  for (const [placeId, fields] of Object.entries(overrides)) {
    const place = places.find(candidate => candidate.place_id === placeId);
    if (!place) throw new Error(`Override place_id ${placeId} is not in this import`);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Invalid location overrides');
    for (const [key, entry] of Object.entries(fields)) {
      if (!entry || typeof entry.value !== 'string') throw new Error(`Invalid override ${key}`);
      const value = entry.value;
      if (key === 'phone') { place.phone = value; place.international_phone = value; }
      else if (key === 'address') place.formatted_address = value;
      else if (key === 'title') place.name = value;
      else if (key === 'website') place.website = value;
      else if (key === 'email') place.email = value;
      else if (key === 'lat' || key === 'lng') {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error(`Invalid coordinate override ${key}`);
        place[key] = number;
      } else throw new Error(`Unknown override field ${key}`);
    }
  }
}

// ── Step 4: Missing fields ───────────────────────────────────────────────────

console.log("\n→ Detecting missing fields...");
const missing = detectMissingFields(places);
if (missing.length === 0) {
  console.log("  ✓ No missing required fields");
} else {
  for (const m of missing) {
    console.log(
      `  ⚠ ${m.location}: missing ${m.field}${m.issue ? ` (${m.issue})` : ""}`,
    );
  }
}

// ── Step 5: Generate seed SQL ────────────────────────────────────────────────

console.log("\n→ Generating seed preview...");
const seedSql = generateSeedSql(
  places,
  mediaManifest.files ? mediaManifest : { files: [] },
);

// ── Step 5b: Generated-copy inventory ────────────────────────────────────────

console.log("\n→ Building generated-copy inventory...");

function buildGeneratedCopyInventory(places, mediaManifest) {
  const inventory = [];

  // Location slugs — computed from business name, not from Google Places directly
  for (const place of places.filter((p) => !p.error)) {
    const slug = (place.name ?? "location")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    inventory.push({
      table: "business_locations",
      field: "slug",
      value: slug,
      provenance: "generated",
      source_inputs: ["place.name"],
      note: "Slugified from business name — verify no collision with other sites",
    });

    // Description is null unless provided
    inventory.push({
      table: "business_locations",
      field: "description",
      value: place.description ?? null,
      provenance: place.description ? "google_maps" : "missing",
      source_inputs: place.description ? ["google_maps"] : [],
      note: place.description
        ? null
        : "No description from Places API — fill before launch",
    });
  }

  // Site brand_description — always null from this pipeline
  inventory.push({
    table: "sites",
    field: "brand_description",
    value: null,
    provenance: "missing",
    source_inputs: [],
    note: "Not available from Places API — write manually or via ChowBot",
  });

  // Media alt_text — this pipeline has no source for it. Alt text describes
  // what is in the picture, and neither the slug nor the file name knows that.
  for (const file of mediaManifest.files ?? []) {
    inventory.push({
      table: "media_assets",
      field: "alt_text",
      value: null,
      provenance: "missing",
      source_inputs: [],
      note: `No alt text for ${file.assigned_to} — write one before launch, or the image ships unreadable to screen readers and worthless to search`,
    });
  }

  // Review text — sourced from Google Places if present
  for (const place of places.filter((p) => !p.error && p.reviews?.length)) {
    for (const review of place.reviews) {
      inventory.push({
        table: "reviews",
        field: "content",
        value:
          review.content?.slice(0, 80) + (review.content?.length > 80 ? "…" : ""),
        provenance: "google_maps",
        source_inputs: ["google_maps_review"],
        note: `Rating ${review.rating}/5 by ${review.author_name}`,
      });
    }
  }

  return inventory;
}

const generatedCopyInventory = buildGeneratedCopyInventory(
  places,
  mediaManifest.files ? mediaManifest : { files: [] },
);

const generatedCount = generatedCopyInventory.filter(
  (i) => i.provenance === "generated",
).length;
const missingCount = generatedCopyInventory.filter(
  (i) => i.provenance === "missing",
).length;
console.log(
  `  ✓ ${generatedCopyInventory.length} fields catalogued (${generatedCount} generated, ${missingCount} missing)`,
);

// ── Step 6: Forbidden copy scan ──────────────────────────────────────────────

console.log("\n→ Scanning for forbidden copy...");
const copyHits = scanForbiddenCopy(seedSql, VERTICAL);
let copyReport;

if (copyHits.length === 0) {
  console.log("  ✓ No forbidden copy found in proposed seed");
  copyReport = "PASS — no forbidden copy detected\n";
} else {
  for (const hit of copyHits) {
    console.log(
      `  ✗ Line ${hit.line}: pattern "${hit.pattern}" matched: ${hit.text}`,
    );
  }
  copyReport =
    `FAIL — ${copyHits.length} forbidden copy hit(s)\n\n` +
    copyHits.map((h) => `Line ${h.line} [${h.pattern}]: ${h.text}`).join("\n") +
    "\n";
}

// ── Step 7: Write manifests ───────────────────────────────────────────────────

console.log("\n→ Writing manifests...");

const clientManifest = {
  generated_at: new Date().toISOString(),
  slug: SLUG,
  vertical: VERTICAL,
  brand_name: BRAND_NAME,
  locations: places,
  forbidden_copy_domains: FORBIDDEN_BY_VERTICAL[VERTICAL] ?? [],
};

// Remove the verbose provider payload from the durable manifest.
const manifestForFile = JSON.parse(
  JSON.stringify(clientManifest, (k, v) => (k === "_raw" ? undefined : v)),
);

const routeManifest = generateRouteManifest(places);

const files = {
  "client-manifest.json": JSON.stringify(manifestForFile, null, 2),
  "media-manifest.json": JSON.stringify(mediaManifest, null, 2),
  "route-manifest.json": JSON.stringify(routeManifest, null, 2),
  "generated-copy.json": JSON.stringify(generatedCopyInventory, null, 2),
  "seed-preview.sql": seedSql,
  "missing-fields.json": JSON.stringify(missing, null, 2),
  "copy-scan.txt": copyReport,
  "route-parity.json": JSON.stringify(parityIssues, null, 2),
};

for (const [name, content] of Object.entries(files)) {
  const path = join(OUT_DIR, name);
  await writeFile(path, content, "utf8");
  console.log(`  ✓ ${path}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(
  `\n┌─ Summary ──────────────────────────────────────────────────────`,
);
console.log(
  `│  Places resolved:  ${places.filter((p) => !p.error).length} / ${places.length}`,
);
console.log(`│  Images found:     ${mediaManifest.files?.length ?? 0}`);
console.log(`│  Missing fields:   ${missing.length}`);
console.log(`│  Copy violations:  ${copyHits.length}`);
console.log(`│  Route issues:     ${parityIssues.length}`);
console.log(`│  Output:           client-imports/${SLUG}/`);
console.log(`└──────────────────────────────────────────────────────────────`);

console.log(`
Next steps:
  1. Review:   client-imports/${SLUG}/client-manifest.json
               client-imports/${SLUG}/seed-preview.sql
               client-imports/${SLUG}/route-manifest.json
               client-imports/${SLUG}/generated-copy.json   ← hallucination review surface
               client-imports/${SLUG}/copy-scan.txt
  2. Review image placement and hashes in client-imports/${SLUG}/media-manifest.json. Apply uploads approved images before database writes.
  3. Approve:  yarn client:import --slug ${SLUG} --organization-id ${ORGANIZATION_ID} --approve
  4. Apply:    yarn client:import --slug ${SLUG} --organization-id ${ORGANIZATION_ID} --apply
  5. Verify:   yarn client:verify --url http://localhost:3000 --vertical ${VERTICAL} --organization-id ${ORGANIZATION_ID} --slug ${SLUG}
  6. Release + verify prod:
               Merge through staging to main; CI deploys and verifies each environment.
               yarn client:verify --url https://${SLUG}.krabiclaw.com --vertical ${VERTICAL} --organization-id ${ORGANIZATION_ID} --slug ${SLUG}

  Or use the onboard wrapper (steps 1-5 in one command):
               yarn client:onboard --slug ${SLUG} --organization-id ${ORGANIZATION_ID} --vertical ${VERTICAL}
`);
