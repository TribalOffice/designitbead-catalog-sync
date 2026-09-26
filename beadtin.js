// Polite Shopify catalog pull from beadtin.com — the pony bead supplier
// (9mm barrel pony beads, SKU 750-xxx = 500 pcs, 750Sxxx = 100 pcs, …M = matte).
// Same approach as shipwreck.js: the public /collections/{handle}/products.json
// endpoint, ~1.5 s between requests, identifying User-Agent. ~5 requests.
//
// WRITES: out/beadtin_barrels.normalized.json (one row per product)
//
// Guard: if the pull returns under half the previous product count it's almost
// certainly a block / network failure, not real de-listings — the previous file
// is kept and the script exits non-zero.

const fs = require("fs");
const path = require("path");

const OUT_DIR = path.resolve(__dirname, "out");
const OUT_PATH = path.join(OUT_DIR, "beadtin_barrels.normalized.json");
const COLLECTION = "9mm-barrel-pony-beads";
const DELAY_MS = 1500;
const PAGE_LIMIT = 250;
const UA = "designitbead-catalog-sync/0.1 (research; contact: fastwhirlwind@gmail.com)";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}`);
  return res.json();
}

// Tags look like "Color_Black", "Finish_Opaque", "Origin_USA".
const tagValues = (tags, key) =>
  (tags || []).filter(t => t.startsWith(key + "_")).map(t => t.slice(key.length + 1));

function normalize(p) {
  const v = (p.variants && p.variants[0]) || {};
  return {
    shopify_product_id: p.id,
    sku: v.sku || null,
    title: p.title,
    handle: p.handle,
    product_type: p.product_type,          // 750 = 500 pcs, 750S = 100 pcs, C750… = other packs
    colors: tagValues(p.tags, "Color"),
    finishes: tagValues(p.tags, "Finish"),
    origin: tagValues(p.tags, "Origin")[0] || null,
    price_usd: v.price ? parseFloat(v.price) : null,
    compare_at_price_usd: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
    grams: v.grams || null,
    available: (p.variants || []).some(x => x.available === true),
    image_url: p.images?.[0]?.src?.split("?")[0] || null,
    product_url: `https://www.beadtin.com/products/${p.handle}`,
    updated_at: p.updated_at,
  };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const prev = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, "utf8")) : null;

  console.log(`[beadtin ${COLLECTION}]`);
  const products = [];
  for (let page = 1; page < 50; page++) {
    const url = `https://www.beadtin.com/collections/${COLLECTION}/products.json?limit=${PAGE_LIMIT}&page=${page}`;
    process.stdout.write(`  page ${page} ... `);
    let data;
    try { data = await fetchJson(url); }
    catch (e) { console.log(`ERROR: ${e.message}`); break; }
    const batch = data.products || [];
    console.log(`${batch.length} products`);
    if (!batch.length) break;
    products.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
    await sleep(DELAY_MS);
  }

  if (prev && products.length < Math.max(50, prev.length * 0.5)) {
    console.error(`\n⚠ ABORTING: pulled ${products.length} products vs ${prev.length} last time — keeping the previous file.`);
    process.exit(2);
  }

  const rows = products.map(normalize);
  fs.writeFileSync(OUT_PATH, JSON.stringify(rows, null, 2));
  const inStock = rows.filter(r => r.available).length;
  console.log(`\n✓ ${rows.length} Bead Tin products (${inStock} in stock) → out/beadtin_barrels.normalized.json`);
})();
