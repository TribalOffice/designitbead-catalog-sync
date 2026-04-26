// Populate supplier_inventory from Shipwreck snapshot, anchored on the existing
// bead_colors.sku column (much more reliable than name matching — your curation
// already records which Shipwreck SKU represents each color).
//
// READS:
//   .env.local                                     SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   ./out/shipwreck_seed_beads.normalized.json     5,777-product catalog from weekly sync
//
// WRITES (idempotent — safe to re-run):
//   supplier_inventory                              N rows per color (pack-size variants)
//   bead_colors.cheapest_price_usd / .available     denormalized summary, updated per color
//
// Strategy:
//   1. Fetch all bead_colors (text id is the slug, sku is the curated Shipwreck SKU).
//   2. For each color, derive a "SKU family" by stripping the trailing R suffix
//      (R = small retail pack, e.g. 11SB164R). The family is `11SB164`, which
//      Shipwreck packages in multiple sizes: 11SB164 (6HK), 11SB164R (1HK), etc.
//   3. Find all Shipwreck products whose shipwreck_sku starts with the family.
//   4. Upsert each as a supplier_inventory row.
//   5. Update bead_colors.cheapest_price_usd + available from the matched SKUs.

const fs = require("fs");
const path = require("path");

// ── Load .env.local ────────────────────────────────────────────────────────
const envPath = path.join(__dirname, ".env.local");
if (!fs.existsSync(envPath)) {
  console.error(`✗ Missing ${envPath}`);
  console.error(`  Copy .env.local.example → .env.local and fill in:`);
  console.error(`    SUPABASE_URL=https://xxxxx.supabase.co`);
  console.error(`    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...   (the service_role key, NOT anon)`);
  process.exit(1);
}
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
// Normalize SUPABASE_URL — strip trailing slash and any /rest/v1 suffix.
// (Supabase Dashboard's Data API page shows the full REST endpoint, easy to copy by mistake.)
const SUPABASE_URL = (process.env.SUPABASE_URL || "")
  .replace(/\/+$/, "")
  .replace(/\/rest\/v1$/, "");
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("✗ .env.local must define SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// ── PostgREST helper ───────────────────────────────────────────────────────
async function pgrest(method, path, body, query = "") {
  const url = `${SUPABASE_URL}/rest/v1/${path}${query}`;
  const headers = {
    "apikey":         SERVICE_KEY,
    "Authorization":  `Bearer ${SERVICE_KEY}`,
    "Content-Type":   "application/json",
    "Prefer":         "return=representation,resolution=merge-duplicates",
  };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${res.statusText}\n${text}`);
  return text ? JSON.parse(text) : null;
}

// ── Derive a SKU family from a curated SKU ─────────────────────────────────
// 11SB164R    → 11SB164  (R = retail single-hank pack)
// 11SB164     → 11SB164
// 11SB100-STR → 11SB100  (suffix variants like -STR, -ITR, -SR, -MER, -PCR)
function skuFamily(sku) {
  if (!sku) return null;
  return sku
    .toUpperCase()
    .replace(/-?(STR|ITR|SR|MER|PCR|LCR|PC|LC|HCR|HC|SCR|SC|MX|MX\d+)$/, "")
    .replace(/R$/, "");
}

function packInfoFromTitle(title) {
  if (!title) return { unit: null, size: null };
  const hk  = title.match(/(\d+(?:\.\d+)?)\s*(?:HK|Hanks?)\b/i);
  if (hk)  return { unit: "hank",   size: parseFloat(hk[1])  };
  const gm  = title.match(/(\d+(?:\.\d+)?)\s*(?:GM|Gm|g|Grams?|gram)\b/);
  if (gm)  return { unit: "gram",   size: parseFloat(gm[1])  };
  const str = title.match(/(\d+(?:\.\d+)?)\s*(?:STR|Strands?)\b/i);
  if (str) return { unit: "strand", size: parseFloat(str[1]) };
  return { unit: null, size: null };
}

(async () => {
  console.log(`Importing into ${SUPABASE_URL}\n`);

  // ── 1. Pull existing bead_colors ────────────────────────────────────────
  console.log("→ Loading bead_colors from Supabase …");
  const colors = await pgrest("GET", "bead_colors", null, "?select=id,name,sku,bead_type,bead_size,brand");
  console.log(`  ${colors.length} colors found`);

  // ── 2. Load Shipwreck snapshot ──────────────────────────────────────────
  console.log("→ Loading Shipwreck normalized snapshot …");
  const shipwreckPath = path.join(__dirname, "out", "shipwreck_seed_beads.normalized.json");
  const all = JSON.parse(fs.readFileSync(shipwreckPath, "utf8"));
  console.log(`  ${all.length} Shipwreck products`);

  // Index Shipwreck products by SKU prefix for fast family lookup.
  const skuIndex = new Map();
  for (const p of all) {
    const sku = (p.shipwreck_sku || "").toUpperCase();
    if (!sku) continue;
    skuIndex.set(sku, p);
  }

  // ── 3. Match each color to its SKU family ───────────────────────────────
  console.log("→ Matching colors to Shipwreck SKU families …");
  const inventoryRows = [];
  const colorSummary  = []; // for updating bead_colors with cheapest_price_usd + available

  for (const c of colors) {
    const family = skuFamily(c.sku);
    if (!family) {
      colorSummary.push({ id: c.id, name: c.name, sku: c.sku, family: null, matches: 0 });
      continue;
    }
    // Find all Shipwreck SKUs that start with the family (catches base + R + suffixed variants).
    const matches = [];
    for (const [sku, p] of skuIndex) {
      // Match: SKU is exactly the family OR family + ending suffix (R, -STR, -ITR, etc.)
      if (sku === family || sku.startsWith(family + "R") || sku.startsWith(family + "-")) {
        matches.push(p);
      }
    }
    colorSummary.push({ id: c.id, name: c.name, sku: c.sku, family, matches: matches.length });

    for (const m of matches) {
      const pack = packInfoFromTitle(m.title);
      inventoryRows.push({
        bead_color_id:        c.id,
        supplier:             "shipwreck",
        supplier_sku:         m.shipwreck_sku,
        shopify_product_id:   m.shopify_product_id,
        product_url:          m.product_url,
        product_title:        m.title,
        pack_unit:            pack.unit,
        pack_size:            pack.size,
        price_usd:            m.variant?.price_usd ?? null,
        compare_at_price_usd: m.variant?.compare_at_price_usd ?? null,
        available:            m.variant?.available === true,
        last_synced_at:       new Date().toISOString(),
      });
    }
  }

  // ── 4. Upsert supplier_inventory in batches ─────────────────────────────
  console.log(`→ Upserting ${inventoryRows.length} supplier_inventory rows …`);
  const CHUNK = 500;
  for (let i = 0; i < inventoryRows.length; i += CHUNK) {
    const chunk = inventoryRows.slice(i, i + CHUNK);
    await pgrest("POST", "supplier_inventory", chunk, "?on_conflict=supplier,supplier_sku");
    process.stdout.write(`  ${Math.min(i + CHUNK, inventoryRows.length)}/${inventoryRows.length}\r`);
  }
  console.log(`\n  ✓ inventory upsert complete`);

  // ── 5. Update bead_colors with denormalized summary (cheapest_price + available) ─
  console.log("→ Updating bead_colors summary fields …");
  for (const c of colors) {
    const matched = inventoryRows.filter(r => r.bead_color_id === c.id);
    const inStock = matched.filter(r => r.available);
    const cheapest = inStock.length
      ? Math.min(...inStock.map(r => r.price_usd).filter(p => p != null))
      : null;
    await pgrest("PATCH", "bead_colors", {
      cheapest_price_usd: isFinite(cheapest) ? cheapest : null,
      available:          inStock.length > 0,
    }, `?id=eq.${encodeURIComponent(c.id)}`);
  }
  console.log(`  ✓ ${colors.length} bead_colors summary fields refreshed`);

  // ── 6. Matching report ─────────────────────────────────────────────────
  console.log("\n=== MATCHING REPORT ===");
  const sorted = [...colorSummary].sort((a, b) => b.matches - a.matches);
  const unmatched = sorted.filter(s => s.matches === 0);
  console.log(`Matched:   ${sorted.filter(s => s.matches > 0).length}/${colors.length} colors → ${inventoryRows.length} SKU rows`);
  console.log(`Unmatched: ${unmatched.length}/${colors.length} colors\n`);
  console.log("Per-color SKU counts:");
  for (const s of sorted) {
    const flag = s.matches === 0
      ? (s.family ? `  ⚠ family ${s.family} not in Shipwreck snapshot` : `  ⚠ no sku on bead_colors row`)
      : "";
    console.log(`  ${String(s.matches).padStart(3)}  ${s.name.padEnd(28)} (${s.id.padEnd(20)}) sku=${s.sku.padEnd(12)}${flag}`);
  }

  fs.writeFileSync(path.join(__dirname, "out", "import_match_report.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), report: colorSummary }, null, 2));
  console.log("\nWrote out/import_match_report.json for review.\n");

  console.log("Verify in Supabase SQL Editor:");
  console.log("  select * from bead_colors_with_stock order by name limit 5;");
  console.log("  select bead_color_id, count(*) from supplier_inventory group by 1 order by 2 desc limit 10;");
})();
