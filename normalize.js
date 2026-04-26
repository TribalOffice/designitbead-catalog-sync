// Re-normalize the raw Shipwreck dumps with smarter brand classification.
// Uses vendor field as primary signal (much more reliable than title regex),
// falls back to manufacturer-code detection in titles.
// Reads only from disk — no re-fetching.

const fs = require("fs");
const path = require("path");

const OUT_DIR = path.resolve(__dirname, "out");
const RAW_DIR = path.join(OUT_DIR, "shipwreck_raw");

const COLLECTIONS = [
  "miyuki-delica-seed-beads",
  "miyuki-japanese-seed-beads",
  "rocaille-seed-beads",
  "charlotte-and-true-cut-seed-beads",
  "bugle-beads",
  "3-cut-seed-beads",
  "vintage-seed-beads",
  "seed-beads",
];

// Bead-size whitelist — anything else is a regex false positive.
const VALID_SIZES = new Set(["6/0", "8/0", "10/0", "11/0", "12/0", "13/0", "14/0", "15/0"]);

const RE = {
  shipwreck_sku: /^([A-Z0-9][A-Z0-9.\-/]{2,15})(?=[:\s])/,
  // Miyuki Delica: DB001, DB-001, DBC0038, DBSC-0038, DBM-001, DBS-001, DBL-001 etc.
  miyuki_delica:  /\b(DB[A-Z]{0,2}\-?\d{1,4}[A-Z]?)\b/,
  // Miyuki Round Rocaille: RR-001, RR0001, M-001 (rare)
  miyuki_round:   /\b(RR\-?\d{1,4}[A-Z]?)\b/,
  // Toho Round: TR-11-22, TR11-22, 11-22 in context
  toho_round:     /\b(TR\-?\d{1,2}\-\d{1,4}[FA-Z]?)\b/,
  toho_treasure:  /\b(TT\-?\d{1,2}\-\d{1,4}[FA-Z]?)\b/,
  toho_hex:       /\b(HC\-?\d{1,2}\-\d{1,4}[FA-Z]?)\b/,
  // Czech Preciosa codes appear in title sometimes as 5- or 6-digit
  size:           /\b(\d{1,2}\/0)\b/,
  pack_grams:     /(\d+(?:\.\d+)?)\s*(?:GM|Gm|g|G|Grams?|gram)\b/,
  pack_hanks:     /(\d+(?:\.\d+)?)\s*(?:Hanks?|HANK|HK)\b/,
  pack_strands:   /(\d+(?:\.\d+)?)\s*(?:Strands?|STR)\b/,
};

function classifyByVendor(vendor) {
  if (!vendor) return null;
  const v = vendor.trim();
  if (/^Preciosa/i.test(v))                       return { brand: "Preciosa Czech Seed Bead", brand_family: "Preciosa" };
  if (/^Prairie Edge$/i.test(v))                  return { brand: "Vintage Venetian / Italian", brand_family: "Vintage" };
  if (/^Miyuki/i.test(v))                         return { brand: "Miyuki", brand_family: "Miyuki" };
  if (/^Toho/i.test(v))                           return { brand: "Toho", brand_family: "Toho" };
  if (/^BeadSmith/i.test(v) || /Helby/i.test(v))  return { brand: null, brand_family: "BeadSmith Distribution" }; // detect from title
  if (/^Shipwreck/i.test(v) || /^My Store$/i.test(v)) return { brand: "Shipwreck House / Bundle", brand_family: "Shipwreck" };
  if (/Eclates/i.test(v))                         return { brand: "Eclates de Perles", brand_family: "Other" };
  if (/Bead Chest/i.test(v))                      return { brand: "Bead Chest", brand_family: "Other" };
  if (/Starman/i.test(v))                         return { brand: "Czech Glass (Starman)", brand_family: "Other" };
  return null;
}

function classifyByCode(code) {
  if (!code) return null;
  if (/^DB/i.test(code))  return { brand: "Miyuki Delica", brand_family: "Miyuki" };
  if (/^RR/i.test(code))  return { brand: "Miyuki Round Rocaille", brand_family: "Miyuki" };
  if (/^TR/i.test(code))  return { brand: "Toho Round", brand_family: "Toho" };
  if (/^TT/i.test(code))  return { brand: "Toho Treasure", brand_family: "Toho" };
  if (/^HC/i.test(code))  return { brand: "Toho Hex Cut", brand_family: "Toho" };
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
    title.match(RE.toho_hex)?.[1] ||
    null;
  if (code) out.manufacturer_code = code.toUpperCase().replace(/-/g, "");

  const size = title.match(RE.size);
  if (size && VALID_SIZES.has(size[1])) out.size_label = size[1];

  const grams = title.match(RE.pack_grams);
  if (grams) out.pack_grams = parseFloat(grams[1]);
  const hanks = title.match(RE.pack_hanks);
  if (hanks) out.pack_hanks = parseFloat(hanks[1]);
  const strands = title.match(RE.pack_strands);
  if (strands) out.pack_strands = parseFloat(strands[1]);

  // Color name guess.
  let color = title;
  if (out.shipwreck_sku) color = color.replace(out.shipwreck_sku + ":", "").replace(out.shipwreck_sku, "");
  if (code) color = color.replace(new RegExp(code.replace(/-/g, "[-\\s]?"), "i"), "");
  color = color
    .replace(/\b(Delica|Miyuki|Toho|Treasure|Round|Rocaille|Hex|Cube|Tila|Charlotte|True Cut|Cut|Seed Beads?|CZ|Bundle|Bundles?)\b/gi, "")
    .replace(/\b\d{1,2}\/0\b/g, "")
    .replace(/\b\d+(?:\.\d+)?\s*(GM|Gm|g|Grams?|gram|Hanks?|HANK|HK|Strands?|STR)\b/gi, "")
    .replace(/[\-—,:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (color) out.color_name_guess = color;

  return out;
}

function normalize(product, sourceCollection) {
  const v = (product.variants && product.variants[0]) || {};
  const parsed = parseTitle(product.title || "");

  // Vendor is the primary classifier — much cleaner than title regex.
  const vendorClass = classifyByVendor(product.vendor);
  const codeClass = classifyByCode(parsed.manufacturer_code);

  // For BeadSmith/distributor vendors the brand name comes from the code.
  // For Preciosa, vendor is canonical and codes are in title only sometimes.
  const cls = (vendorClass?.brand) ? vendorClass : (codeClass || vendorClass) || { brand: null, brand_family: null };

  return {
    shopify_product_id: product.id,
    handle: product.handle,
    source_collection: sourceCollection,
    vendor_raw: product.vendor,
    brand: cls.brand,
    brand_family: cls.brand_family,
    product_type: product.product_type,
    tags: product.tags,
    title: product.title,
    ...parsed,
    variant: {
      id: v.id,
      sku: v.sku,
      price_usd: v.price ? parseFloat(v.price) : null,
      compare_at_price_usd: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
      grams_per_pack: v.grams || null,
      available: v.available === true,
    },
    image_url: product.images?.[0]?.src || null,
    image_count: product.images?.length || 0,
    product_url: `https://www.shipwreckbeads.com/products/${product.handle}`,
    created_at: product.created_at,
    updated_at: product.updated_at,
  };
}

const allProductsById = new Map();
const collectionMembership = new Map();

for (const handle of COLLECTIONS) {
  const file = path.join(RAW_DIR, `${handle}.json`);
  if (!fs.existsSync(file)) { console.log(`(skip) ${handle} — no raw file`); continue; }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const p of data.products) {
    if (!allProductsById.has(p.id)) allProductsById.set(p.id, p);
    const list = collectionMembership.get(p.id) || [];
    if (!list.includes(handle)) list.push(handle);
    collectionMembership.set(p.id, list);
  }
}

const normalized = [];
for (const [id, p] of allProductsById) {
  const memberships = collectionMembership.get(id) || [];
  const primary = COLLECTIONS.find(c => memberships.includes(c)) || memberships[0];
  const row = normalize(p, primary);
  row.all_collections = memberships;
  normalized.push(row);
}

fs.writeFileSync(path.join(OUT_DIR, "shipwreck_seed_beads.normalized.json"),
  JSON.stringify(normalized, null, 2));

const stats = {
  total_unique_products: normalized.length,
  by_brand_family: {},
  by_brand: {},
  by_size: {},
  with_manufacturer_code: normalized.filter(r => r.manufacturer_code).length,
  with_size_label: normalized.filter(r => r.size_label).length,
  in_stock: normalized.filter(r => r.variant.available).length,
  out_of_stock: normalized.filter(r => !r.variant.available).length,
  unclassified: normalized.filter(r => !r.brand_family).length,
};
for (const r of normalized) {
  const bf = r.brand_family || "(unclassified)";
  const b  = r.brand || "(unclassified)";
  stats.by_brand_family[bf] = (stats.by_brand_family[bf] || 0) + 1;
  stats.by_brand[b] = (stats.by_brand[b] || 0) + 1;
  if (r.size_label) stats.by_size[r.size_label] = (stats.by_size[r.size_label] || 0) + 1;
}

fs.writeFileSync(path.join(OUT_DIR, "shipwreck_stats.json"), JSON.stringify(stats, null, 2));
console.log(JSON.stringify(stats, null, 2));
