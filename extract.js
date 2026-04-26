// Extract recoverable data from BeadTool4's BeadTool.db into portable JSON.
// What we get: palette catalog (names, descriptions, physical bead sizes, UUIDs),
// free pattern names, print layout names, stamp library names.
// What we do NOT get: actual color codes / hex values — those live in the encrypted
// `data` BLOB (btf64e magic + AES-grade ciphertext, key embedded in BeadTool4.exe).

const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

// Windows-only one-time extraction. DB lives in the BeadTool4 install dir.
const DB_PATH = process.env.BEADTOOL_DB || "C:/Program Files (x86)/BeadTool4/BeadTool.db";
const OUT_DIR = path.resolve(__dirname, "out");

// Tiny XML attribute/text extractor — the meta blobs are simple flat XML, no need for a full parser.
function attr(xml, tag, name) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}
function textOf(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function parseMeta(blob) {
  if (!blob) return null;
  const xml = Buffer.isBuffer(blob) ? blob.toString("utf8") : String(blob);
  if (!xml.startsWith("<?xml")) return { raw: xml };

  const widthStr  = attr(xml, "size", "width");
  const heightStr = attr(xml, "size", "height");

  return {
    uuid:        attr(xml, "information", "uuid"),
    revision:    attr(xml, "information", "revision"),
    created:     attr(xml, "information", "created"),
    modified:    attr(xml, "information", "modified"),
    author: {
      name:      attr(xml, "author", "name")    || null,
      company:   attr(xml, "author", "company") || null,
      email:     attr(xml, "author", "email")   || null,
      website:   attr(xml, "author", "website") || null,
    },
    bead_size_mm: (widthStr && heightStr)
      ? { width: parseFloat(widthStr), height: parseFloat(heightStr) }
      : null,
    name:        textOf(xml, "name"),
    description: textOf(xml, "description"),
  };
}

const TYPE_NAMES = { 1: "pattern", 2: "palette", 3: "layout", 5: "stamp" };

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// Object tree: build a parent → children map, plus name lookup for folder paths.
const allRows = db.prepare("SELECT id, role, type, state, locked, parent, place, name, length(meta) AS meta_len, length(data) AS data_len FROM objects").all();
const byId = new Map(allRows.map(r => [r.id, r]));
function pathOf(id) {
  const parts = [];
  let cur = byId.get(id);
  while (cur && cur.id !== -1) {
    parts.unshift(cur.name || `#${cur.id}`);
    if (cur.parent === -1 || cur.parent == null) break;
    cur = byId.get(cur.parent);
  }
  return parts.join(" / ");
}

// Pull every record with a meta blob; parse XML; bucket by type.
const detailed = db.prepare("SELECT id, role, type, parent, place, name, meta, length(data) AS data_len FROM objects").all();

const buckets = { palette: [], pattern: [], layout: [], stamp: [], folder: [], other: [] };

for (const row of detailed) {
  const typeName = TYPE_NAMES[row.type] || "unknown";
  const isFolder = row.role === 0;
  const meta = parseMeta(row.meta);

  const record = {
    id:           row.id,
    type:         typeName,
    name:         row.name,
    folder_path:  pathOf(row.parent),
    parent_id:    row.parent,
    place:        row.place,
    encrypted_data_bytes: row.data_len || 0,
    meta,
  };

  if (isFolder) {
    buckets.folder.push({ id: row.id, type: typeName, name: row.name, parent_id: row.parent, path: pathOf(row.id) });
  } else if (buckets[typeName]) {
    buckets[typeName].push(record);
  } else {
    buckets.other.push(record);
  }
}

// Options + tags + tips for completeness.
const options = db.prepare("SELECT name, value, desc FROM options").all();
const tags    = db.prepare("SELECT id, locked, tag, length(value) AS value_bytes FROM tags").all();
const tips    = db.prepare("SELECT id, tip FROM tips").all();

const out = {
  source: {
    file: DB_PATH,
    extracted_at: new Date().toISOString(),
    note: "Extracted from BeadTool4 v4 SQLite catalog. The actual color data per palette is in the encrypted `data` BLOB (btf64e + base64 AES-grade ciphertext) and is NOT included here. See README.md for legitimate sources for bead color data.",
  },
  counts: {
    palettes: buckets.palette.length,
    patterns: buckets.pattern.length,
    layouts:  buckets.layout.length,
    stamps:   buckets.stamp.length,
    folders:  buckets.folder.length,
    options:  options.length,
    tags:     tags.length,
    tips:     tips.length,
  },
  palettes: buckets.palette,
  patterns: buckets.pattern,
  layouts:  buckets.layout,
  stamps:   buckets.stamp,
  folders:  buckets.folder,
  options,
  tags,
  tips,
};

fs.mkdirSync(OUT_DIR, { recursive: true });

// Full dump.
fs.writeFileSync(path.join(OUT_DIR, "beadtool4_catalog.json"), JSON.stringify(out, null, 2));

// A focused, Supabase-ready palette catalog — just the rows you'd seed a `bead_palettes` table with.
const palettesTable = buckets.palette.map(p => ({
  source:               "beadtool4",
  source_uuid:          p.meta?.uuid || null,
  name:                 p.meta?.name || p.name,
  description:          p.meta?.description || null,
  bead_width_mm:        p.meta?.bead_size_mm?.width  ?? null,
  bead_height_mm:       p.meta?.bead_size_mm?.height ?? null,
  source_revision:      p.meta?.revision ? parseInt(p.meta.revision, 10) : null,
  source_created_at:    p.meta?.created || null,
  source_modified_at:   p.meta?.modified || null,
  source_author_company: p.meta?.author?.company || null,
}));
fs.writeFileSync(path.join(OUT_DIR, "bead_palettes.seed.json"), JSON.stringify(palettesTable, null, 2));

// And the pattern catalog (names + folder path + meta), useful as starter content if you want to ship sample designs.
const patternsTable = buckets.pattern.map(p => ({
  source:           "beadtool4",
  source_uuid:      p.meta?.uuid || null,
  name:             p.meta?.name || p.name,
  description:      p.meta?.description || null,
  folder_path:      p.folder_path,
  source_created_at:  p.meta?.created || null,
  source_modified_at: p.meta?.modified || null,
}));
fs.writeFileSync(path.join(OUT_DIR, "bead_patterns.seed.json"), JSON.stringify(patternsTable, null, 2));

console.log("Wrote:");
console.log("  out/beadtool4_catalog.json      (full extraction, all tables)");
console.log("  out/bead_palettes.seed.json     (Supabase-ready palette rows)");
console.log("  out/bead_patterns.seed.json     (Supabase-ready pattern rows)");
console.log("");
console.log("Counts:", out.counts);
