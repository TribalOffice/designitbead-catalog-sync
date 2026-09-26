// Refresh supplier prices + stock in Supabase from the local catalog pulls.
// Run by hand (refresh.bat runs it last); nothing here is scheduled.
//
// READS:
//   .env.local                                      SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   ./out/shipwreck_seed_beads.normalized.json      Shipwreck pull (shipwreck.js)
//   ./out/beadtin_barrels.normalized.json           Bead Tin pull (beadtin.js) — pony beads
//
// WRITES (only after you confirm — see "Safety" below):
//   supplier_inventory      Shipwreck: N rows per color (pack-size variants), matched
//                           by the curated bead_colors.sku family (as before).
//                           Bead Tin: updates the existing 'beadtin' rows (price,
//                           stock, pack weight) by SKU. Never adds bead colors.
//   bead_colors.available / .cheapest_price_usd
//                           recomputed from ALL of a color's supplier rows (any
//                           supplier). Colors with NO supplier rows are skipped —
//                           they're never marked unavailable just because the
//                           Shipwreck pull doesn't carry them (the old bug that
//                           would have switched off every Bead Tin pony bead).
//
// Prices: price_usd is the supplier's REGULAR price (MSRP) — the higher of the
//   Shopify price and compare_at_price (msrp.js). Supplier sales are ignored so
//   they never move kit costs; compare_at_price_usd keeps the raw value for reference.
//
// Safety: shows what would change, then asks "Apply these changes to Supabase?".
//   node import-to-supabase.js            → report + y/N prompt
//   node import-to-supabase.js --dry-run  → report only, never writes
//   node import-to-supabase.js --yes      → report + write without asking

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { regularPrice, onSale } = require("./msrp");

const DRY = process.argv.includes("--dry-run");
const YES = process.argv.includes("--yes");

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
const SUPABASE_URL = (process.env.SUPABASE_URL || "")
  .replace(/\/+$/, "")
  .replace(/\/rest\/v1$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("✗ .env.local must define SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// ── PostgREST helpers ──────────────────────────────────────────────────────
async function pgrest(method, p, body, query = "") {
  const url = `${SUPABASE_URL}/rest/v1/${p}${query}`;
  const headers = {
    "apikey": SERVICE_KEY,
    "Authorization": `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=minimal,resolution=merge-duplicates",
  };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${res.statusText}\n${text}`);
  return text ? JSON.parse(text) : null;
}
// GET every row (PostgREST caps responses at 1000 rows).
async function getAll(table, select) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${select}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Range: `${from}-${from + 999}` },
    });
    if (!res.ok) throw new Error(`GET ${table} → ${res.status} ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// ── Shipwreck helpers (unchanged matching rules) ───────────────────────────
// 11SB164R → 11SB164 (R = retail single-hank pack); suffix variants stripped too.
function skuFamily(sku) {
  if (!sku) return null;
  return sku
    .toUpperCase()
    .replace(/-?(STR|ITR|SR|MER|PCR|LCR|PC|LC|HCR|HC|SCR|SC|MX|MX\d+)$/, "")
    .replace(/R$/, "");
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

const loadJson = (file) => {
  const p = path.join(__dirname, "out", file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};
const key = (supplier, sku) => `${supplier}|${String(sku).toUpperCase()}`;
const usd = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

function ask(q) {
  if (!process.stdin.isTTY) return Promise.resolve("");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim().toLowerCase()); }));
}

(async () => {
  console.log(`Supabase: ${SUPABASE_URL}${DRY ? "   (dry run — nothing will be written)" : ""}\n`);

  const colors = await getAll("bead_colors", "id,name,sku,available,cheapest_price_usd");
  const current = await getAll("supplier_inventory",
    "bead_color_id,supplier,supplier_sku,price_usd,compare_at_price_usd,available,pack_unit,pack_size,shopify_product_id,product_url,product_title");
  const curByKey = new Map(current.map(r => [key(r.supplier, r.supplier_sku), r]));
  console.log(`Loaded ${colors.length} bead colors, ${current.length} supplier rows.`);

  const now = new Date().toISOString();
  const upserts = [];   // full supplier_inventory rows (same keys on every row)
  const onSaleKeys = new Set();   // SKUs on sale at the supplier right now — reporting only
  const row = (r) => {
    if (r.sale) onSaleKeys.add(key(r.supplier, r.supplier_sku));
    return {
      bead_color_id: r.bead_color_id, supplier: r.supplier, supplier_sku: r.supplier_sku,
      shopify_product_id: r.shopify_product_id ?? null, product_url: r.product_url ?? null,
      product_title: r.product_title ?? null, pack_unit: r.pack_unit ?? null, pack_size: r.pack_size ?? null,
      price_usd: r.price_usd ?? null, compare_at_price_usd: r.compare_at_price_usd ?? null,
      available: !!r.available, last_synced_at: now,
    };
  };

  // ── Shipwreck ────────────────────────────────────────────────────────────
  const shipwreck = loadJson("shipwreck_seed_beads.normalized.json");
  if (!shipwreck) console.log("\n(no Shipwreck pull found — skipping Shipwreck)");
  else {
    const skuIndex = new Map();
    for (const p of shipwreck) if (p.shipwreck_sku) skuIndex.set(p.shipwreck_sku.toUpperCase(), p);
    let matchedColors = 0;
    for (const c of colors) {
      const family = skuFamily(c.sku);
      if (!family) continue;
      let hit = 0;
      for (const [sku, p] of skuIndex) {
        if (!(sku === family || sku.startsWith(family + "R") || sku.startsWith(family + "-"))) continue;
        hit++;
        const old = curByKey.get(key("shipwreck", p.shipwreck_sku)) || {};
        const pack = packInfoFromTitle(p.title);
        upserts.push(row({
          bead_color_id: c.id, supplier: "shipwreck", supplier_sku: p.shipwreck_sku,
          shopify_product_id: p.shopify_product_id, product_url: p.product_url, product_title: p.title,
          pack_unit: pack.unit ?? old.pack_unit, pack_size: pack.size ?? old.pack_size,
          price_usd: regularPrice(p.variant?.price_usd, p.variant?.compare_at_price_usd),
          compare_at_price_usd: p.variant?.compare_at_price_usd ?? null, sale: onSale(p.variant?.price_usd, p.variant?.compare_at_price_usd),
          available: p.variant?.available === true,
        }));
      }
      if (hit) matchedColors++;
    }
    // Existing Shipwreck rows the family match didn't reach (most Delica /
    // silver-lined colors have no bead_colors.sku yet) — refresh by their own SKU.
    const done = new Set(upserts.map(u => key(u.supplier, u.supplier_sku)));
    let direct = 0, missing = 0;
    for (const r of current) {
      if (r.supplier !== "shipwreck" || done.has(key(r.supplier, r.supplier_sku))) continue;
      const p = skuIndex.get(String(r.supplier_sku).toUpperCase());
      if (!p) { missing++; continue; }
      upserts.push(row({
        ...r, shopify_product_id: p.shopify_product_id, product_url: p.product_url, product_title: p.title,
        price_usd: regularPrice(p.variant?.price_usd, p.variant?.compare_at_price_usd) ?? r.price_usd,
        compare_at_price_usd: p.variant?.compare_at_price_usd ?? null, sale: onSale(p.variant?.price_usd, p.variant?.compare_at_price_usd),
        available: p.variant?.available === true,
      }));
      direct++;
    }
    console.log(`\nShipwreck: ${shipwreck.length} products pulled → ${upserts.length} rows (${matchedColors} colors by SKU family + ${direct} existing rows by their own SKU)`);
    if (missing) console.log(`  ⚠ ${missing} existing Shipwreck rows not in this pull (delisted?) — left unchanged`);
  }

  // ── Bead Tin (pony) ──────────────────────────────────────────────────────
  const beadtin = loadJson("beadtin_barrels.normalized.json");
  const btRows = current.filter(r => r.supplier === "beadtin");
  if (!beadtin) console.log("\n(no Bead Tin pull found — skipping Bead Tin)");
  else {
    const bySku = new Map(beadtin.filter(p => p.sku).map(p => [p.sku.toUpperCase(), p]));
    const gone = [];
    for (const r of btRows) {
      const p = bySku.get(String(r.supplier_sku).toUpperCase());
      if (!p) { gone.push(r.supplier_sku); continue; }
      upserts.push(row({
        ...r, shopify_product_id: p.shopify_product_id, product_url: p.product_url, product_title: p.title,
        pack_unit: "gram", pack_size: p.grams || r.pack_size,
        price_usd: regularPrice(p.price_usd, p.compare_at_price_usd) ?? r.price_usd,
        compare_at_price_usd: p.compare_at_price_usd ?? null, sale: onSale(p.price_usd, p.compare_at_price_usd),
        available: p.available,
      }));
    }
    const stocked = new Set(btRows.map(r => String(r.supplier_sku).toUpperCase()));
    const notStocked = beadtin.filter(p => p.product_type === "750" && p.sku && !stocked.has(p.sku.toUpperCase())
      && !/mix|&|ombre/i.test(p.title));
    console.log(`\nBead Tin: ${beadtin.length} products pulled → ${btRows.length - gone.length} of ${btRows.length} palette SKUs matched`);
    if (gone.length) console.log(`  ⚠ no longer listed by Bead Tin: ${gone.join(", ")}`);
    console.log(`  ${notStocked.length} single-color 500-pc Bead Tin beads aren't in the palette (not added — FYI only)`);
  }

  // One row per supplier SKU — a SKU family can match two colors, and a batch
  // upsert that touches the same (supplier, sku) twice is rejected by Postgres.
  // Keep the row linked to the color the SKU already belongs to, else the color
  // whose own sku IS this SKU (e.g. 11SB274 → "TR Sapphire", 11SB274R → "Trans
  // Sapphire" — the 2026-09-18 import added hank sizes as separate colors),
  // else the first match.
  {
    const skuOf = new Map(colors.map(c => [c.id, String(c.sku || "").toUpperCase()]));
    const rank = (u, owner) => (owner && u.bead_color_id === owner ? 2
      : skuOf.get(u.bead_color_id) === String(u.supplier_sku).toUpperCase() ? 1 : 0);
    const pick = new Map();
    for (const u of upserts) {
      const k = key(u.supplier, u.supplier_sku);
      const had = pick.get(k);
      const owner = curByKey.get(k)?.bead_color_id;
      if (!had || rank(u, owner) > rank(had, owner)) pick.set(k, u);
    }
    const dupes = upserts.length - pick.size;
    upserts.length = 0;
    upserts.push(...pick.values());
    if (dupes) console.log(`\n(${dupes} duplicate SKU matches collapsed — each supplier SKU stays linked to one color)`);
  }

  // ── What would change in supplier_inventory ─────────────────────────────
  const priceChanges = [], wentOut = [], backIn = [], added = [];
  for (const u of upserts) {
    const old = curByKey.get(key(u.supplier, u.supplier_sku));
    if (!old) { added.push(u); continue; }
    if (old.price_usd != null && u.price_usd != null && Number(old.price_usd) !== Number(u.price_usd)) priceChanges.push({ u, old });
    if (old.available && !u.available) wentOut.push(u);
    if (!old.available && u.available) backIn.push(u);
  }
  console.log(`\n=== Supplier rows: ${upserts.length} to refresh ===`);
  console.log(`  new rows          ${added.length}`);
  const ups = priceChanges.filter(({ u, old }) => Number(u.price_usd) > Number(old.price_usd)).length;
  console.log(`  price changes     ${priceChanges.length}  (${ups} up, ${priceChanges.length - ups} down — regular/MSRP prices)`);
  console.log(`  went out of stock ${wentOut.length}`);
  console.log(`  back in stock     ${backIn.length}`);
  const saleCount = upserts.filter(u => onSaleKeys.has(key(u.supplier, u.supplier_sku))).length;
  if (saleCount) console.log(`  FYI ${saleCount} of these are on sale at the supplier right now — sale ignored, regular (MSRP) price recorded.`);
  for (const { u, old } of priceChanges.slice(0, 15)) console.log(`    ${u.supplier} ${u.supplier_sku}: ${usd(old.price_usd)} → ${usd(u.price_usd)}`);
  for (const u of wentOut.slice(0, 15)) console.log(`    out: ${u.supplier} ${u.supplier_sku} (${u.bead_color_id})`);
  for (const u of backIn.slice(0, 15)) console.log(`    back: ${u.supplier} ${u.supplier_sku} (${u.bead_color_id})`);

  // ── Color summary from ALL supplier rows (any supplier) ─────────────────
  const merged = new Map(current.map(r => [key(r.supplier, r.supplier_sku), r]));
  for (const u of upserts) merged.set(key(u.supplier, u.supplier_sku), u);
  const rowsByColor = new Map();
  for (const r of merged.values()) {
    if (!rowsByColor.has(r.bead_color_id)) rowsByColor.set(r.bead_color_id, []);
    rowsByColor.get(r.bead_color_id).push(r);
  }
  const patches = [];
  let skipped = 0;
  for (const c of colors) {
    const rs = rowsByColor.get(c.id);
    if (!rs || !rs.length) { skipped++; continue; }   // no supplier data → leave the color alone
    const inStock = rs.filter(r => r.available && r.price_usd != null);
    const cheapest = inStock.length ? Math.min(...inStock.map(r => Number(r.price_usd))) : null;
    const available = rs.some(r => r.available);
    const curCheap = c.cheapest_price_usd == null ? null : Number(c.cheapest_price_usd);
    if (c.available !== available || curCheap !== cheapest) {
      patches.push({ id: c.id, name: c.name, available, cheapest_price_usd: cheapest, was: c.available });
    }
  }
  const flipsOff = patches.filter(p => p.was !== false && p.available === false);
  console.log(`\n=== Bead colors ===`);
  console.log(`  ${patches.length} colors' stock/price summary would update (${flipsOff.length} become unavailable)`);
  console.log(`  ${skipped} colors have no supplier rows — left unchanged (never marked unavailable)`);
  for (const p of flipsOff.slice(0, 20)) console.log(`    unavailable: ${p.name} (${p.id})`);

  fs.writeFileSync(path.join(__dirname, "out", "import_report.json"), JSON.stringify({
    generated_at: now, dry_run: DRY, price_basis: "regular (MSRP) — supplier sales ignored", upserts: upserts.length, added: added.length,
    price_changes: priceChanges.map(({ u, old }) => ({ supplier: u.supplier, sku: u.supplier_sku, was: old.price_usd, now: u.price_usd })),
    went_out_of_stock: wentOut.map(u => `${u.supplier} ${u.supplier_sku}`),
    back_in_stock: backIn.map(u => `${u.supplier} ${u.supplier_sku}`),
    color_patches: patches, colors_without_supplier_rows: skipped,
  }, null, 2));
  console.log(`\nWrote out/import_report.json`);

  // ── Confirm, then write ─────────────────────────────────────────────────
  if (DRY) { console.log("\nDry run — nothing written."); return; }
  if (!YES) {
    const a = await ask("\nApply these changes to Supabase? (y/N) ");
    if (a !== "y" && a !== "yes") { console.log("Nothing written."); return; }
  }

  console.log(`\n→ Writing ${upserts.length} supplier rows …`);
  for (let i = 0; i < upserts.length; i += 500) {
    await pgrest("POST", "supplier_inventory", upserts.slice(i, i + 500), "?on_conflict=supplier,supplier_sku");
  }
  console.log(`→ Updating ${patches.length} bead colors …`);
  for (const p of patches) {
    await pgrest("PATCH", "bead_colors", { available: p.available, cheapest_price_usd: p.cheapest_price_usd },
      `?id=eq.${encodeURIComponent(p.id)}`);
  }
  console.log("✓ Done.");
})().catch(e => { console.error("\n✗ " + e.message); process.exit(1); });
