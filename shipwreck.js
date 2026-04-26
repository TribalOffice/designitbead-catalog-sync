// Polite Shopify catalog pull from shipwreckbeads.com.
// Uses the public /collections/{handle}/products.json endpoint — same data Shopify
// serves to its own theme. Self-imposed ~1.5s delay between requests, identifying
// User-Agent. Outputs raw + normalized JSON for downstream Supabase import.

const fs = require("fs");
const path = require("path");

const OUT_DIR = path.resolve(__dirname, "out");
const RAW_DIR = path.join(OUT_DIR, "shipwreck_raw");
const DELAY_MS = 1500;
const PAGE_LIMIT = 250; // Shopify /products.json hard cap
const UA = "designitbead-catalog-sync/0.1 (research; contact: fastwhirlwind@gmail.com)";

// Seed-bead sub-collections worth pulling. Bundles intentionally excluded
// (mixed packs, not single colors). Vendor-of-record collections come first.
const COLLECTIONS = [
  "miyuki-delica-seed-beads",          // primary target — Delicas
  "miyuki-japanese-seed-beads",        // parent: includes Round, Tila, Cube, Hex
  "rocaille-seed-beads",               // Czech rocailles
  "charlotte-and-true-cut-seed-beads",
  "bugle-beads",
  "3-cut-seed-beads",
  "vintage-seed-beads",
  "seed-beads",                        // parent of all — catches stragglers
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}`);
  return res.json();
}

async function pullCollection(handle) {
  const products = [];
  for (let page = 1; page < 200; page++) {
    const url = `https://www.shipwreckbeads.com/collections/${handle}/products.json?limit=${PAGE_LIMIT}&page=${page}`;
    process.stdout.write(`  page ${page} ... `);
    let data;
    try { data = await fetchJson(url); }
    catch (e) { console.log(`ERROR: ${e.message}`); break; }

    const batch = data.products || [];
    console.log(`${batch.length} products`);
    if (batch.length === 0) break;
    products.push(...batch);

    if (batch.length < PAGE_LIMIT) break;
    await sleep(DELAY_MS);
  }
  return products;
}

// Title patterns observed:
//   "14SD109R: DB010 Delica Opaque Black 11/0 - 9GM"
//   "11SV625-MX Antique Venetian Opaline Seed Beads, 11/0 — Spring Garden Mix 10 Grams"
//   "Some Title ... TR-11-22 Toho ... 15/0 ..."
// We extract: supplier_sku, manufacturer_code, brand, size_label, pack_grams, color_name (best-effort).
const RE = {
  // First token at start, optionally followed by ":" — the Shipwreck SKU
  shipwreck_sku: /^([A-Z0-9][A-Z0-9.\-/]{2,15})(?=[:\s])/,
  // Common manufacturer codes in title (Miyuki Delica DB/DBC/DBM/DBS/DBL, Miyuki Round RR, Toho TR/TT/HC, Preciosa PR)
  miyuki_delica:  /\b(DB[CMSL]?\-?\d{1,4}[A-Z]?)\b/,
  miyuki_round:   /\b(RR\-?\d{1,4}[A-Z]?)\b/,
  toho_round:     /\b(TR\-\d{1,2}\-\d{1,4}[A-Z]?)\b/,
  toho_treasure:  /\b(TT\-\d{1,2}\-\d{1,4}[A-Z]?)\b/,
  // Bead size like "11/0", "15/0", "8/0", "6/0"
  size:           /\b(\d{1,2}\/0)\b/,
  // Pack size grams "9GM", "10 Grams", "1 Hank"
  pack_grams:     /(\d+(?:\.\d+)?)\s*(?:GM|Gm|g|G|Grams?|gram)\b/,
  pack_hanks:     /(\d+(?:\.\d+)?)\s*(?:Hanks?|HANK)\b/,
};

function classifyBrand(code) {
  if (!code) return null;
  if (/^DB/i.test(code))  return "Miyuki Delica";
  if (/^RR/i.test(code))  return "Miyuki Round Rocaille";
  if (/^TR/i.test(code))  return "Toho Round";
  if (/^TT/i.test(code))  return "Toho Treasure";
  return null;
}

function parseTitle(title) {
  const out = { raw_title: title };

  const sku = title.match(RE.shipwreck_sku);
  if (sku) out.shipwreck_sku = sku[1];

  const code =
    title.match(RE.miyuki_delica)?.[1] ||
    title.match(RE.miyuki_round)?.[1] ||
    title.match(RE.toho_treasure)?.[1] ||
    title.match(RE.toho_round)?.[1] ||
    null;
  if (code) {
    out.manufacturer_code = code.toUpperCase().replace(/-/g, "");
    out.brand = classifyBrand(code);
  }

  const size = title.match(RE.size);
  if (size) out.size_label = size[1];

  const grams = title.match(RE.pack_grams);
  if (grams) out.pack_grams = parseFloat(grams[1]);
  const hanks = title.match(RE.pack_hanks);
  if (hanks) out.pack_hanks = parseFloat(hanks[1]);

  // Crude color-name guess: drop the SKU prefix and the manufacturer/size/pack tokens.
  let color = title;
  if (out.shipwreck_sku) color = color.replace(out.shipwreck_sku + ":", "").replace(out.shipwreck_sku, "");
  if (code) color = color.replace(new RegExp(code, "i"), "");
  color = color
    .replace(/\b(Delica|Miyuki|Toho|Treasure|Round|Rocaille|Hex|Cube|Tila|Charlotte|True Cut|Seed Beads?)\b/gi, "")
    .replace(/\b\d{1,2}\/0\b/g, "")
    .replace(/\b\d+(?:\.\d+)?\s*(GM|Gm|g|Grams?|gram|Hanks?|HANK)\b/g, "")
    .replace(/[\-—,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (color) out.color_name_guess = color;

  return out;
}

function normalize(product, sourceCollection) {
  const v = (product.variants && product.variants[0]) || {};
  const parsed = parseTitle(product.title || "");
  return {
    shopify_product_id: product.id,
    handle: product.handle,
    source_collection: sourceCollection,
    vendor: product.vendor,
    product_type: product.product_type,
    tags: product.tags,
    title: product.title,
    ...parsed,
    variant: {
      id: v.id,
      sku: v.sku,
      price_usd: v.price ? parseFloat(v.price) : null,
      compare_at_price_usd: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
      grams: v.grams || null,
      available: v.available === true,
    },
    image_url: product.images?.[0]?.src || null,
    image_count: product.images?.length || 0,
    product_url: `https://www.shipwreckbeads.com/products/${product.handle}`,
    created_at: product.created_at,
    updated_at: product.updated_at,
  };
}

(async () => {
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const allProductsById = new Map();        // dedup across overlapping collections
  const collectionMembership = new Map();   // product_id -> [collections]

  for (const handle of COLLECTIONS) {
    console.log(`\n[${handle}]`);
    let products = [];
    try { products = await pullCollection(handle); }
    catch (e) { console.log(`  collection failed: ${e.message}`); continue; }

    fs.writeFileSync(path.join(RAW_DIR, `${handle}.json`),
      JSON.stringify({ collection: handle, fetched_at: new Date().toISOString(), count: products.length, products }, null, 2));
    console.log(`  saved raw → ${handle}.json (${products.length} products)`);

    for (const p of products) {
      if (!allProductsById.has(p.id)) allProductsById.set(p.id, p);
      const list = collectionMembership.get(p.id) || [];
      if (!list.includes(handle)) list.push(handle);
      collectionMembership.set(p.id, list);
    }
    await sleep(DELAY_MS); // gap between collections too
  }

  // Normalize: prefer the most specific collection a product belongs to as `source_collection`.
  const specificityOrder = COLLECTIONS; // first = most specific
  const normalized = [];
  for (const [id, p] of allProductsById) {
    const memberships = collectionMembership.get(id) || [];
    const primary = specificityOrder.find(c => memberships.includes(c)) || memberships[0];
    const row = normalize(p, primary);
    row.all_collections = memberships;
    normalized.push(row);
  }

  fs.writeFileSync(path.join(OUT_DIR, "shipwreck_seed_beads.normalized.json"),
    JSON.stringify(normalized, null, 2));

  // Quick stats for the writeup.
  const stats = {
    total_unique_products: normalized.length,
    by_brand: {},
    by_size: {},
    with_manufacturer_code: normalized.filter(r => r.manufacturer_code).length,
    in_stock: normalized.filter(r => r.variant.available).length,
    out_of_stock: normalized.filter(r => !r.variant.available).length,
    avg_price: (normalized.reduce((s, r) => s + (r.variant.price_usd || 0), 0) / normalized.length).toFixed(2),
  };
  for (const r of normalized) {
    const b = r.brand || "(unclassified)";
    stats.by_brand[b] = (stats.by_brand[b] || 0) + 1;
    if (r.size_label) stats.by_size[r.size_label] = (stats.by_size[r.size_label] || 0) + 1;
  }

  fs.writeFileSync(path.join(OUT_DIR, "shipwreck_stats.json"), JSON.stringify(stats, null, 2));

  console.log("\n=== DONE ===");
  console.log(JSON.stringify(stats, null, 2));
  console.log(`\nWrote:`);
  console.log(`  out/shipwreck_raw/*.json                       (raw per-collection dumps)`);
  console.log(`  out/shipwreck_seed_beads.normalized.json       (deduped, parsed, Supabase-ready)`);
  console.log(`  out/shipwreck_stats.json                       (summary counts)`);
})();
