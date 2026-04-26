// Import the curated 26 Preciosa Opaque 11/0 colors into Supabase, then auto-match
// each one against Shipwreck SKUs and populate supplier_inventory.
//
// READS:
//   .env.local                                      SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   ./out/shipwreck_seed_beads.normalized.json      Shipwreck catalog (5,777 products)
//
// WRITES (idempotent — safe to re-run):
//   bead_palettes        1 row   (Preciosa Opaque 11/0)
//   bead_colors          26 rows (the curated set, ported 1:1 from src/data/beadColors.js)
//   supplier_inventory   N rows  (one per matched Shipwreck SKU)
//
// SAFETY: idempotency is by slug for palettes/colors and (supplier, supplier_sku) for inventory.
// Re-running will UPSERT, never duplicate.

const fs = require("fs");
const path = require("path");

// ── Load .env.local manually — no dotenv dep ───────────────────────────────
const envPath = path.join(__dirname, ".env.local");
if (!fs.existsSync(envPath)) {
  console.error(`✗ Missing ${envPath}`);
  console.error(`  Create it with these two lines (get values from Supabase Dashboard → Settings → API):`);
  console.error(`    SUPABASE_URL=https://xxxxx.supabase.co`);
  console.error(`    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...   (the service_role key, NOT anon)`);
  process.exit(1);
}
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("✗ .env.local must define SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// ── Tier mapping: existing tiers:[...] arrays → new min_tier enum ──────────
// 'guest' is implicit when array contains 'guest'; 'studio' for studio+pro; 'pro' for pro-only.
function tiersToMinTier(tiersArray) {
  if (tiersArray.includes("guest"))  return "guest";
  if (tiersArray.includes("hobby"))  return "hobby";
  if (tiersArray.includes("studio")) return "studio";
  return "pro";
}

// ── Curated palette: ported 1:1 from src/data/beadColors.js ────────────────
// Embedded here (instead of importing the JS) so this script is self-contained.
const PRECIOSA_OPAQUE_11_0 = {
  palette: {
    slug:           "preciosa-opaque-11-0",
    brand:          "Preciosa",
    brand_line:     "Opaque",
    size_label:     "11/0",
    bead_width_mm:  1.32,    // from BeadTool4 catalog: Preciosa Rocailles (Size 11)
    bead_height_mm: 2.17,
    display_name:   "Preciosa Opaque 11/0",
    description:    "Traditional Czech opaque seed beads in size 11/0 — the customizer's default palette.",
    display_order:  1,
  },
  colors: [
    // Guest+Hobby+Studio+Pro (6 base)
    { slug:"op-white",         name:"White",                    hex:"#FFFFFF", tiers:["guest","hobby","studio","pro"] },
    { slug:"op-black",         name:"Black",                    hex:"#1A1714", tiers:["guest","hobby","studio","pro"] },
    { slug:"op-med-red",       name:"Medium Red",               hex:"#C8232A", tiers:["guest","hobby","studio","pro"] },
    { slug:"op-orange",        name:"Orange",                   hex:"#E8641E", tiers:["guest","hobby","studio","pro"] },
    { slug:"op-yellow",        name:"Yellow",                   hex:"#F5C800", tiers:["guest","hobby","studio","pro"] },
    { slug:"op-royal-blue",    name:"Royal Blue",               hex:"#1030A0", tiers:["guest","hobby","studio","pro"] },
    // Studio+Pro (12 more)
    { slug:"op-bone",          name:"Bone Effect",              hex:"#EDE0C8", tiers:["studio","pro"] },
    { slug:"op-tan",           name:"Tan Effect",               hex:"#C8A87A", tiers:["studio","pro"] },
    { slug:"op-lt-brown",      name:"Light Brown",              hex:"#A0724A", tiers:["studio","pro"] },
    { slug:"op-dk-red",        name:"Dark Red",                 hex:"#8B0F12", tiers:["studio","pro"] },
    { slug:"op-dk-pink",       name:"Dark Pink",                hex:"#D44070", tiers:["studio","pro"] },
    { slug:"op-tq-green",      name:"Turquoise Green",          hex:"#00A882", tiers:["studio","pro"] },
    { slug:"op-pale-blue",     name:"Pale Blue",                hex:"#A8C8E8", tiers:["studio","pro"] },
    { slug:"op-lt-tq-blue",    name:"Light Turquoise Blue",     hex:"#40C0C8", tiers:["studio","pro"] },
    { slug:"op-tq-blue",       name:"Turquoise Blue",           hex:"#00A0B4", tiers:["studio","pro"] },
    { slug:"op-teal-blue",     name:"Teal Blue",                hex:"#007888", tiers:["studio","pro"] },
    { slug:"op-med-blue",      name:"Medium Blue",              hex:"#2858C0", tiers:["studio","pro"] },
    { slug:"op-navy-blue",     name:"Navy Blue",                hex:"#0A1858", tiers:["studio","pro"] },
    // Pro only (8 more)
    { slug:"op-lt-red",        name:"Light Red",                hex:"#E8514A", tiers:["pro"] },
    { slug:"op-brick-red",     name:"Brick Red Mahogany",       hex:"#7A2820", tiers:["pro"] },
    { slug:"op-gold",          name:"Gold",                     hex:"#C89A00", tiers:["pro"] },
    { slug:"op-lime",          name:"Lime Green",               hex:"#78C814", tiers:["pro"] },
    { slug:"op-lt-green",      name:"Light Green",              hex:"#4AA040", tiers:["pro"] },
    { slug:"op-dk-green",      name:"Dark Green",               hex:"#1A5C28", tiers:["pro"] },
    { slug:"op-bright-green",  name:"Bright Green",             hex:"#00C832", tiers:["pro"] },
    { slug:"op-pale-tq-blue",  name:"Pale Turquoise Blue",      hex:"#8ED8E0", tiers:["pro"] },
  ],
};

// ── Match a curated color name against Shipwreck Preciosa product titles ───
// Shipwreck titles look like: "11SB109: CZ Seed Bead Op Black 11/0 6HK"
// Strategy: normalize both sides, look for the color name as a phrase after "Op ".
function normalizeForMatch(s) {
  return s
    .toLowerCase()
    .replace(/\bop(aque)?\b/g, "")
    .replace(/\bcz\b/g, "")
    .replace(/\bseed bead(s)?\b/g, "")
    .replace(/\d{1,2}\/0\b/g, "")
    .replace(/\d+(\.\d+)?\s*(hk|hank|gm|gram|str|strand)s?\b/gi, "")
    .replace(/[\-—,:.()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchSkus(colorName, preciosaProducts) {
  const normColor = normalizeForMatch(colorName);
  const matches = [];
  for (const p of preciosaProducts) {
    const normTitle = normalizeForMatch(p.title || "");
    // Color name must appear as a substring (whole-word boundaries via padding)
    const padded = " " + normTitle + " ";
    if (padded.includes(" " + normColor + " ")) {
      matches.push(p);
    }
  }
  return matches;
}

function packInfoFromTitle(title) {
  if (!title) return { unit: null, size: null };
  const hk = title.match(/(\d+(?:\.\d+)?)\s*(?:HK|Hanks?)\b/i);
  if (hk) return { unit: "hank", size: parseFloat(hk[1]) };
  const gm = title.match(/(\d+(?:\.\d+)?)\s*(?:GM|Gm|g|Grams?|gram)\b/);
  if (gm) return { unit: "gram", size: parseFloat(gm[1]) };
  const str = title.match(/(\d+(?:\.\d+)?)\s*(?:STR|Strands?)\b/i);
  if (str) return { unit: "strand", size: parseFloat(str[1]) };
  return { unit: null, size: null };
}

// ── Tiny REST wrapper — no @supabase/supabase-js dependency ────────────────
async function pgrest(method, table, body, query = "") {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query}`;
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

(async () => {
  console.log(`Importing into ${SUPABASE_URL}\n`);

  // ── 1. Upsert palette ────────────────────────────────────────────────────
  console.log("→ Upserting bead_palettes …");
  const [palette] = await pgrest("POST", "bead_palettes", [PRECIOSA_OPAQUE_11_0.palette],
    "?on_conflict=slug");
  console.log(`  ✓ palette id ${palette.id}`);

  // ── 2. Upsert colors ─────────────────────────────────────────────────────
  console.log("→ Upserting bead_colors …");
  const colorRows = PRECIOSA_OPAQUE_11_0.colors.map((c, i) => ({
    palette_id:    palette.id,
    slug:          c.slug,
    name:          c.name,
    hex:           c.hex,
    min_tier:      tiersToMinTier(c.tiers),
    display_order: i,
  }));
  const insertedColors = await pgrest("POST", "bead_colors", colorRows, "?on_conflict=palette_id,slug");
  console.log(`  ✓ ${insertedColors.length} colors upserted`);

  // ── 3. Match against Shipwreck and populate supplier_inventory ───────────
  console.log("→ Loading Shipwreck normalized snapshot …");
  const shipwreckPath = path.join(__dirname, "out", "shipwreck_seed_beads.normalized.json");
  const all = JSON.parse(fs.readFileSync(shipwreckPath, "utf8"));
  const preciosa11 = all.filter(r =>
    r.brand_family === "Preciosa" &&
    r.size_label === "11/0" &&
    /\bop(aque)?\b/i.test(r.title || "")   // Opaque finish only
  );
  console.log(`  ${preciosa11.length} candidate Preciosa Opaque 11/0 products`);

  console.log("→ Matching curated colors to SKUs …");
  const slugById = Object.fromEntries(insertedColors.map(c => [c.slug, c.id]));
  const inventoryRows = [];
  const report = [];
  for (const c of PRECIOSA_OPAQUE_11_0.colors) {
    const matches = matchSkus(c.name, preciosa11);
    report.push({ color: c.name, slug: c.slug, sku_count: matches.length, skus: matches.map(m => m.shipwreck_sku) });
    for (const m of matches) {
      const pack = packInfoFromTitle(m.title);
      inventoryRows.push({
        color_id:             slugById[c.slug],
        supplier:             "shipwreck",
        supplier_sku:         m.shipwreck_sku || m.handle,
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

  console.log(`→ Upserting ${inventoryRows.length} supplier_inventory rows …`);
  // Chunk into 500-row batches to keep PostgREST happy.
  const CHUNK = 500;
  for (let i = 0; i < inventoryRows.length; i += CHUNK) {
    const chunk = inventoryRows.slice(i, i + CHUNK);
    await pgrest("POST", "supplier_inventory", chunk, "?on_conflict=supplier,supplier_sku");
    process.stdout.write(`  ${Math.min(i + CHUNK, inventoryRows.length)}/${inventoryRows.length}\r`);
  }
  console.log(`\n  ✓ inventory upsert complete`);

  // ── 4. Matching report ──────────────────────────────────────────────────
  console.log("\n=== MATCHING REPORT ===");
  const unmatched = report.filter(r => r.sku_count === 0);
  const matched   = report.filter(r => r.sku_count >  0);
  console.log(`Matched:   ${matched.length}/26 colors → ${inventoryRows.length} SKUs`);
  console.log(`Unmatched: ${unmatched.length}/26 colors`);
  console.log("");
  console.log("Per-color SKU counts:");
  for (const r of report.sort((a,b) => b.sku_count - a.sku_count)) {
    const flag = r.sku_count === 0 ? " ⚠ NO MATCH — needs manual SKU assignment"
               : r.sku_count >  6 ? " ⚠ many matches — likely some false positives"
               : "";
    console.log(`  ${String(r.sku_count).padStart(3)} ${r.color.padEnd(28)} (${r.slug})${flag}`);
  }
  if (unmatched.length) {
    console.log("\nUnmatched colors — Shipwreck doesn't carry an obvious match. Options:");
    console.log("  • Manually find the SKU at shipwreckbeads.com and INSERT into supplier_inventory");
    console.log("  • Or accept that color isn't currently sourceable from Shipwreck (it's still in bead_colors)");
  }

  // Write the report to a JSON file for follow-up review.
  fs.writeFileSync(path.join(__dirname, "out", "import_match_report.json"),
    JSON.stringify({ palette_id: palette.id, generated_at: new Date().toISOString(), report }, null, 2));
  console.log("\nWrote out/import_match_report.json for review.\n");
})();
