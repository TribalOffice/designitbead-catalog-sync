// Auto-draft a bead_colors migration for the new rocaille finishes (Pearl,
// Opaque/Luster, Opaque/Matte, Transparent) and the new pony bead styles
// (Translucent, Pearl, Glow, Metallic), sourced from the latest normalized
// Shipwreck scrape.
//
// READS:
//   .env.local                                     SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   ./out/shipwreck_seed_beads.normalized.json     latest scrape, incl. `finish`
//
// WRITES:
//   ./out/generated_migrations/<timestamp>_expand_rocaille_finishes_and_pony_styles.sql
//
// This file is a DRAFT for human review — copy it into
// designitbead/supabase/migrations/ only after spot-checking hex/name pairs.
// Hex values are a best-effort color-word guess, not a calibrated match.

const fs = require("fs");
const path = require("path");

// ── Load .env.local (same pattern as import-to-supabase.js) ────────────────
const envPath = path.join(__dirname, ".env.local");
if (!fs.existsSync(envPath)) {
  console.error(`✗ Missing ${envPath}`);
  process.exit(1);
}
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("✗ .env.local must define SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

async function pgrest(qpath) {
  const url = `${SUPABASE_URL}/rest/v1/${qpath}`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}\n${await res.text()}`);
  return res.json();
}

// ── Rocaille finish → new/existing bead_type slug ───────────────────────────
const ROCAILLE_FINISH_MAP = {
  "Silver Lined":       "silver-lined",
  "Pearl":              "rocaille-pearl",
  "Opaque/Luster":      "rocaille-luster",
  "Opaque/Matte":       "rocaille-matte",
  "Transparent":        "rocaille-transparent",
  "Transparent/Luster": "rocaille-transparent",
  "Transparent/Neon":   "rocaille-transparent",
  "Transparent/Matte":  "rocaille-transparent",
};

// ── Pony finish → the slugs already reserved in src/designer/beadSystems.js ─
const PONY_FINISH_MAP = {
  "Transparent":        "pony-translucent",
  "Transparent/Matte":  "pony-translucent",
  "Pearl":              "pony-pearl",
  "Glow in the Dark":   "pony-glow",
};

const ID_PREFIX = {
  "silver-lined":         "sl",
  "rocaille-pearl":       "rpl",
  "rocaille-luster":      "rol",
  "rocaille-matte":       "rom",
  "rocaille-transparent": "rtr",
  "pony-translucent":     "pnx",
  "pony-pearl":           "pnp",
  "pony-glow":            "png",
  "pony-metallic":        "pnm",
};

// Display-order bands — clear of every existing range (see migration history:
// rocaille-opaque 1-52, silver-lined 1001-1036, delica 2001-2331, pony-opaque
// 5001-5048).
const ORDER_START = {
  "silver-lined":         1037,
  "rocaille-pearl":       3000,
  "rocaille-luster":      3200,
  "rocaille-matte":       3400,
  "rocaille-transparent": 3600,
  "pony-translucent":     5100,
  "pony-pearl":           5200,
  "pony-glow":            5300,
  "pony-metallic":        5500,
};

// ── Best-effort color-word → hex heuristic ──────────────────────────────────
// NOT a calibrated color match — every row gets a `-- TODO(hex): review` flag
// when nothing matches, and should be spot-checked in AdminColorControl.
const BASE_COLORS = {
  black: "#222222", white: "#F2F2ED", ivory: "#F3ECDD", cream: "#F0E6C8",
  gray: "#8C8C88", grey: "#8C8C88", charcoal: "#3A3A38", silver: "#C8C8C4",
  red: "#C4342E", crimson: "#B22232", ruby: "#8E2A3A", maroon: "#5C2530",
  burgundy: "#5E2233", wine: "#5A2436", rust: "#A34424",
  orange: "#E08A2E", coral: "#E8896F", peach: "#EEB08E", amber: "#C9862C",
  topaz: "#B67A2C", salmon: "#EA9887",
  yellow: "#E8C63C", gold: "#C9A24C", mustard: "#C7A03A", honey: "#D4A75A",
  caramel: "#B37A3E",
  green: "#4C8C5B", emerald: "#2E8A62", mint: "#8FCBA8", olive: "#7C7C3E",
  forest: "#2E5C3C", hunter: "#33502E", lime: "#8FBF3E", chartreuse: "#9FC23E",
  seafoam: "#7FBFA8", jade: "#3E9C74",
  blue: "#3E6FA8", navy: "#233A5C", sapphire: "#2E4E8E", cobalt: "#2A4E9C",
  turquoise: "#3EA0A8", aqua: "#4CB6BE", teal: "#2E7C82", denim: "#4C688C",
  periwinkle: "#8C9AD4", sky: "#7FB6DC", indigo: "#2E2E6E",
  purple: "#7A4E9C", violet: "#7A5CA8", amethyst: "#8A5C9C", lavender: "#B6A0CC",
  lilac: "#C2A8D4", orchid: "#B06CA8", plum: "#5E3452", mauve: "#9C7488",
  pink: "#DE8CA8", magenta: "#C43E8E", fuchsia: "#CC3E9C", rose: "#C97088",
  brown: "#6E4A34", chocolate: "#4A3020", bronze: "#7A5432", copper: "#A6602E",
  tan: "#C9A876", beige: "#D6C4A0", khaki: "#B6A876", taupe: "#8A7A68",
  sand: "#D4BF96", champagne: "#E0CBA0", nickel: "#A8A8A2",
  crystal: "#E4E4DE",
};
// Longer phrases first so "hot pink" wins over a lone "pink".
const PHRASES = {
  "hot pink": "#E23E8E", "baby pink": "#F2C4D2", "dusty rose": "#C88A94",
  "sea foam": "#7FBFA8", "royal blue": "#274E9C", "sky blue": "#7FB6DC",
  "kelly green": "#3C9A50", "forest green": "#2E5C3C", "hunter green": "#33502E",
  "dark red": "#7A2228", "dark blue": "#233A5C", "dark green": "#2E5C3C",
  "dark purple": "#4E2E5C", "dark brown": "#3E2818", "dark orange": "#B85E1E",
  "dark yellow": "#C79A28", "dark pink": "#B85C82", "dark turquoise": "#2E7C82",
  "dark aqua": "#2E7C82", "dark amethyst": "#5E3E6E", "dark topaz": "#8E5E20",
  "dark navy": "#182640", "dark sapphire": "#233A6E", "dark cobalt": "#1E3A78",
  "light green": "#A8D4B4", "light blue": "#A8C8E8", "light pink": "#F0C4D4",
  "light purple": "#C8A8DE", "light orange": "#F0B878", "light yellow": "#F2E08C",
  "light turquoise": "#A0DCE0", "light aqua": "#A8E0E4", "light gray": "#C4C4C0",
  "light grey": "#C4C4C0", "light brown": "#9C7452", "light lavender": "#D8CCE8",
  "medium brown": "#7A5238", "medium green": "#5CA070", "medium red": "#B23430",
  "chalk white": "#EDE9DD", "pearl white": "#EDEAE2", "opal white": "#EDE6DC",
  "smoky black": "#2A2A28", "gunmetal": "#3A3E42", "night glow": "#E8E8E0",
  "christmas green": "#2E6E3E", "xmas green": "#2E6E3E",
  "root beer": "#4E3020", "ghost gray": "#84888C", "ghost grey": "#84888C",
  "powder blue": "#A8C4DC", "slate blue": "#5C7CA8", "capri blue": "#3E6EB0",
  "montana blue": "#33689C", "petal pink": "#E6D2DC",
};
const MODIFIER_LIGHT = /\b(light|lt|pale|pastel)\b/i;
const MODIFIER_DARK  = /\b(dark|deep)\b/i;

function blend(hex, toward, amount) {
  const h = hex.replace("#", "");
  const t = toward.replace("#", "");
  const c = (a, b) => Math.round(parseInt(a, 16) * (1 - amount) + parseInt(b, 16) * amount);
  const r = c(h.slice(0, 2), t.slice(0, 2));
  const g = c(h.slice(2, 4), t.slice(2, 4));
  const b = c(h.slice(4, 6), t.slice(4, 6));
  return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0").toUpperCase()).join("");
}

const NOISE_WORDS = /\b(trans|transparent|opaque|silverlined|lined|luster|lstr|matte|ab|iris|ceylon|ii|ornela|preciosa|cz|czech|seed|beads?|pony|usa|ppk|pcs?|ct|pl|bead|bicone|coated|dyed|neon)\b/gi;

function guessHex(colorNameGuess) {
  if (!colorNameGuess) return null;
  const cleaned = colorNameGuess.toLowerCase().replace(NOISE_WORDS, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  for (const phrase of Object.keys(PHRASES)) {
    if (cleaned.includes(phrase)) return PHRASES[phrase];
  }

  const words = cleaned.split(" ");
  let base = null;
  for (const w of words) {
    if (BASE_COLORS[w]) { base = BASE_COLORS[w]; break; }
  }
  if (!base) return null;

  if (MODIFIER_LIGHT.test(cleaned)) return blend(base, "#FFFFFF", 0.32);
  if (MODIFIER_DARK.test(cleaned))  return blend(base, "#000000", 0.28);
  return base;
}

function titleCaseName(colorNameGuess, title) {
  const raw = (colorNameGuess || title || "Unnamed").trim();
  return raw.replace(/\s+/g, " ");
}

function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

(async () => {
  console.log("Fetching existing bead_colors for de-dupe...");
  const existing = await pgrest("bead_colors?select=id,sku,bead_type");
  const existingIds  = new Set(existing.map(r => r.id));
  const existingSkus = new Set(existing.map(r => (r.sku || "").toUpperCase()).filter(Boolean));
  console.log(`  ${existing.length} existing rows, ${existingSkus.size} with a SKU.`);

  const rows = JSON.parse(fs.readFileSync(
    path.join(__dirname, "out", "shipwreck_seed_beads.normalized.json"), "utf8"));

  const counters = {};
  const outRows = [];      // { bead_type, id, name, hex, sku, hexIsGuess }
  const skipped = {};      // finish -> count, for the "out of scope" summary
  const dupSkipped = { rocaille: 0, pony: 0 };

  // ── Rocaille candidates ───────────────────────────────────────────────
  for (const r of rows) {
    const inCollection = r.source_collection === "rocaille-seed-beads"
      || (r.all_collections || []).includes("rocaille-seed-beads");
    if (!inCollection || r.size_label !== "11/0") continue;
    const beadType = ROCAILLE_FINISH_MAP[r.finish];
    if (!beadType) {
      if (r.finish) skipped[r.finish] = (skipped[r.finish] || 0) + 1;
      continue;
    }
    const sku = (r.shipwreck_sku || "").toUpperCase();
    if (!sku || existingSkus.has(sku)) { dupSkipped.rocaille++; continue; }
    const id = `${ID_PREFIX[beadType]}-${sku.toLowerCase()}`;
    if (existingIds.has(id)) { dupSkipped.rocaille++; continue; }
    existingSkus.add(sku); existingIds.add(id); // guard within this run too
    const hex = guessHex(r.color_name_guess);
    outRows.push({
      beadType, id, sku,
      name: titleCaseName(r.color_name_guess, r.title),
      hex: hex || "#9E9E9E",
      hexIsGuess: !hex,
      brand: "Preciosa",
    });
  }

  // ── Pony candidates ───────────────────────────────────────────────────
  const NONROUND = /\b(flower|heart|disc|face|strawberry|star)\b/i;
  for (const r of rows) {
    if (r.source_collection !== "large-hole-pony-beads") continue;
    const title = r.title || "";
    if (!/\bpony\b/i.test(title)) continue;
    if (/\bmix(ed)?\b/i.test(title)) continue;
    if (NONROUND.test(title)) continue;
    if (!/9mm/i.test(title)) continue;

    let beadType = PONY_FINISH_MAP[r.finish];
    if (!beadType && !r.finish && /\b(nickel|copper|gold|silver|metallic)\b/i.test(title)) {
      beadType = "pony-metallic";
    }
    if (!beadType) {
      if (r.finish) skipped[r.finish] = (skipped[r.finish] || 0) + 1;
      continue; // plain Opaque (already curated) or unmapped finish
    }
    const sku = (r.shipwreck_sku || "").toUpperCase();
    if (!sku || existingSkus.has(sku)) { dupSkipped.pony++; continue; }
    const id = `${ID_PREFIX[beadType]}-${sku.toLowerCase()}`;
    if (existingIds.has(id)) { dupSkipped.pony++; continue; }
    existingSkus.add(sku); existingIds.add(id);
    const hex = guessHex(r.color_name_guess);
    outRows.push({
      beadType, id, sku,
      name: titleCaseName(r.color_name_guess, r.title),
      hex: hex || "#9E9E9E",
      hexIsGuess: !hex,
      // Same brand text as the existing Opaque pony line — no supplier name,
      // and no separate "bundle" sub-brand; it's all just "Pony Bead".
      brand: "Pony Bead",
    });
  }

  // ── Assign display_order per bead_type band ──────────────────────────
  for (const row of outRows) {
    const start = ORDER_START[row.beadType];
    counters[row.beadType] = (counters[row.beadType] ?? start);
    row.display_order = counters[row.beadType]++;
    row.bead_size = row.beadType.startsWith("pony") ? "6x9mm" : "11/0";
  }

  // ── Emit SQL ──────────────────────────────────────────────────────────
  const byType = {};
  for (const row of outRows) (byType[row.beadType] ||= []).push(row);

  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const outDir = path.join(__dirname, "out", "generated_migrations");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${ts}_expand_rocaille_finishes_and_pony_styles.sql`);

  const lines = [];
  lines.push(`-- Auto-drafted by generate-migration.js on ${new Date().toISOString()}.`);
  lines.push(`-- Source: catalog-sync scrape of shipwreckbeads.com.`);
  lines.push(`--`);
  lines.push(`-- DRAFT — review before applying. Hex values are a best-effort guess from`);
  lines.push(`-- each product's color-name text, NOT a calibrated color match. Rows`);
  lines.push(`-- flagged with a TODO(hex) comment had no keyword match at all and fell`);
  lines.push(`-- back to neutral gray — those need a manual hex pick in AdminColorControl`);
  lines.push(`-- before customers rely on them for photo-import color matching.`);
  lines.push(`--`);
  lines.push(`-- Counts:`);
  for (const [type, list] of Object.entries(byType)) lines.push(`--   ${type.padEnd(24)}: ${list.length}`);
  lines.push(`--   TOTAL new bead_colors     : ${outRows.length}`);
  lines.push(`--`);
  lines.push(`-- Idempotent — ON CONFLICT (id) DO NOTHING.`);
  lines.push(``);
  lines.push(`insert into public.bead_colors (`);
  lines.push(`  id, name, hex, tiers, min_tier, bead_type, bead_size, brand, sku,`);
  lines.push(`  contrast, opacity, light_strength, light_amount, display_order`);
  lines.push(`) values`);

  const valueLines = outRows.map((row, i) => {
    const comment = row.hexIsGuess
      ? `\n  -- TODO(hex): review "${sqlEscape(row.name)}" — no keyword match, using neutral gray`
      : "";
    const comma = i === outRows.length - 1 ? "" : ",";
    return `${comment}\n  ('${row.id}', '${sqlEscape(row.name)}', '${row.hex}', '{pro}'::text[], 'pro', ` +
      `'${row.beadType}', '${row.bead_size}', '${sqlEscape(row.brand)}', '${row.sku}', ` +
      `1.0, 1.0, 0.0, 30, ${row.display_order})${comma}`;
  });
  lines.push(valueLines.join("").replace(/^\n/, ""));
  lines.push(`on conflict (id) do nothing;`);

  fs.writeFileSync(outFile, lines.join("\n") + "\n");

  console.log(`\nWrote ${outFile}`);
  console.log(`\nNew rows by bead_type:`);
  for (const [type, list] of Object.entries(byType)) console.log(`  ${type.padEnd(24)} ${list.length}`);
  console.log(`  TOTAL                    ${outRows.length}`);
  console.log(`\nSkipped — de-duped against existing catalog: rocaille ${dupSkipped.rocaille}, pony ${dupSkipped.pony}`);
  console.log(`\nAvailable but out of scope this round (by finish):`);
  console.log(JSON.stringify(skipped, null, 2));
  const guessCount = outRows.filter(r => r.hexIsGuess).length;
  console.log(`\n${guessCount} of ${outRows.length} rows had no hex keyword match (flagged TODO(hex), using #9E9E9E).`);
})().catch(e => { console.error(e); process.exit(1); });
