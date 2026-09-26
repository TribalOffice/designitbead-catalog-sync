# designitbead — catalog sync

Pulls supplier catalogs into portable JSON for the designitbead.com customizer
and refreshes prices + stock in Supabase — **by hand, when you choose**:

- **Shipwreck Beads** — seed beads (Delica, Preciosa rocailles, silver-lined)
- **Bead Tin** (beadtin.com) — the 9mm barrel pony beads (opaque + matte)

Also contains the one-time BeadTool4 + BCP6 extraction work that established
the palette catalog skeleton (17 bead lines + physical bead dimensions in mm).

## Manual refresh — what happens

Double-click **`refresh.bat`** (or `npm run refresh`):

1. Copies the current pulls to `out/.previous/` (one previous copy only).
2. Pulls Shipwreck (`shipwreck.js` + `normalize.js`, ~7 min, polite pace) and
   Bead Tin (`beadtin.js`, ~10 s). A pull under half the previous size is
   treated as a block / network failure and the previous data is restored.
3. Writes `out/REPORT.md` — new listings, price changes, stock flips.
4. Runs `import-to-supabase.js`, which prints what would change in Supabase
   and asks **"Apply these changes to Supabase? (y/N)"**. Nothing is written
   unless you type `y`. `npm run import:dry` shows the changes without asking.

The import only updates supplier rows (prices, stock) and each bead color's
available / cheapest-price summary — computed from **all** its suppliers.
Colors with no supplier rows are left alone. It never adds bead colors.

**Prices are always the supplier's regular price (MSRP)** — the higher of
Shopify's `price` and `compare_at_price` (`msrp.js`). Supplier sales (seasonal
or random) are ignored, so they never move kit costs; the report just notes
how many products are on sale. `compare_at_price_usd` keeps the raw value.

Logs go to `logs/refresh-YYYY-MM-DD.log`. Nothing is committed or pushed.

> The old weekly Task Scheduler job ("Designitbead Weekly Catalog Sync",
> `weekly.bat` / `weekly.js`) was **disabled on 2026-09-25** — it wrote a dated
> full-catalog snapshot every week (storage) and had been failing silently.
> Older snapshots live in this repo's git history.

---

## One-time BeadTool4 / BCP6 extraction (Windows-only)

First-pass extraction of the bead/palette catalogs out of BeadTool4 and Bead Creator Pro 6
into portable JSON, ready for import into Supabase.

## TL;DR

**Recovered cleanly:**
- BeadTool4's full **palette catalog skeleton** — 17 palettes (all 4 Delica sizes, 7 Miyuki Round sizes, Toho Aiko/Treasures/Rounds, Preciosa, Pony) with names, descriptions, UUIDs, revision dates, and **physical bead dimensions in mm**.
- BeadTool4's **pattern catalog** (19 free patterns), **print layouts** (10 templates), **stamp library** (22 stamps), and **tips** (20 strings).

**NOT recovered (encrypted):**
- The actual per-palette color data (bead codes like DB001, hex values, names per color). Both products store this in encrypted blobs:
  - BeadTool4: `data` BLOB starts with `btf64e` magic, then base64-encoded AES-grade ciphertext (entropy 7.99/8.0).
  - BCP6: `.pal` files have a 64-byte ASCII header (`Palette File V.5,\nCopyright (C) 2008 ThoughtFishMedia, Inc.`) followed by AES-grade ciphertext (entropy 7.98/8.0).
- Decryption keys live inside the .exe binaries. Extracting them would be reverse-engineering and almost certainly violate both products' EULAs. **Don't go there.**

**Bonus parseable, not extracted yet:**
- BCP6 `.bc` sample patterns (`Sample BCP Patterns/`) are unencrypted — header `BeadCreatorPro Design: 26 Jul 2011` followed by little-endian doubles + record bytes. If we ever want to import legacy BCP user patterns, the format is reverse-engineerable from these samples.

## Output files

```
out/
  beadtool4_catalog.json     Full extraction: every object, all metadata, options/tags/tips.
  bead_palettes.seed.json    17 rows shaped for a Supabase `bead_palettes` table.
  bead_patterns.seed.json    19 rows shaped for a Supabase `bead_patterns` table.
```

## Re-running

```bash
cd C:/Users/lakot/bead_extract
node extract.js
```

Reads `C:/Program Files (x86)/BeadTool4/BeadTool.db` (read-only), writes to `out/`.

## Suggested Supabase schema

```sql
-- The bead-line catalog (what brand+size lines we support).
create table bead_palettes (
  id                     uuid primary key default gen_random_uuid(),
  source                 text not null,           -- 'beadtool4' | 'shipwreck' | 'manual'
  source_uuid            text,                    -- preserve BT4 uuid for round-tripping
  name                   text not null,           -- "Miyuki Delicas (Size 11)"
  brand                  text,                    -- 'Miyuki' | 'Toho' | 'Preciosa'  (derive from name on import)
  size_label             text,                    -- '11/0' | '15/0' | '8/0' | '9mm'
  bead_width_mm          numeric(4,2),
  bead_height_mm         numeric(4,2),
  description            text,
  display_order          int,
  tier                   text default 'free',     -- 'free' | 'pro' — for tier-gating which palettes are visible
  created_at             timestamptz default now()
);

-- The actual colors *within* each palette. Populate from a clean source (see below).
create table bead_colors (
  id                     uuid primary key default gen_random_uuid(),
  palette_id             uuid references bead_palettes(id) on delete cascade,
  code                   text not null,           -- 'DB001', 'TR-11-942', etc.
  name                   text,                    -- 'Silver Lined Crystal'
  hex                    text not null,           -- '#A0B5D6'
  finish                 text,                    -- 'opaque' | 'matte' | 'silver-lined' | 'ab' | ...
  in_stock               boolean default true,
  supplier_sku           text,                    -- maps to Shipwreck SKU when known
  created_at             timestamptz default now(),
  unique (palette_id, code)
);

-- For the "intelligent color reduction" feature — designate which colors a tier may use.
create table palette_tier_membership (
  palette_id             uuid references bead_palettes(id) on delete cascade,
  color_id               uuid references bead_colors(id) on delete cascade,
  tier                   text not null,           -- 'free' | 'standard' | 'pro'
  primary key (palette_id, color_id, tier)
);
```

Import the seed file with:

```sql
-- in Supabase SQL editor, after pasting bead_palettes.seed.json into a temp jsonb cell:
insert into bead_palettes (source, source_uuid, name, description, bead_width_mm, bead_height_mm)
select source, nullif(source_uuid, ''), name, description, bead_width_mm, bead_height_mm
from jsonb_to_recordset($json$ ... $json$::jsonb)
  as x(source text, source_uuid text, name text, description text,
       bead_width_mm numeric, bead_height_mm numeric);
```

## Where to get the actual color data (the part we can't extract)

1. **Miyuki & Toho official catalogs.** Both publish full color lists on their websites, with codes, names, and accurate hex/RGB values. This is the canonical source.
2. **Shipwreck Beads catalog scrape.** Since Shipwreck is your real supplier, your inventory should reflect what they actually carry. Pull from their product pages — match by Miyuki/Toho code, then store the Shipwreck SKU + stock state in `bead_colors.supplier_sku` / `in_stock`. This becomes the foundation for the inventory-management feature.
3. **Open community datasets.** GitHub has several open-source bead palette projects (search "delica palette JSON" and "miyuki bead colors"). Useful as a sanity-check against the official lists, and faster than scraping if you just want to seed.

The cleanest workflow: start with official Miyuki/Toho hex codes (they're authoritative on color), then layer Shipwreck SKUs on top to get real inventory.

## Shipwreck Beads catalog pull

Pulled 2026-04-26 via `shipwreck.js` → `normalize.js`. Used the public Shopify
`/collections/{handle}/products.json` endpoint (same data Shopify serves to its
own theme — not HTML scraping). Self-imposed 1.5s delay between requests,
identifying User-Agent.

**Sub-collections pulled:** miyuki-delica-seed-beads, miyuki-japanese-seed-beads,
rocaille-seed-beads, charlotte-and-true-cut-seed-beads, bugle-beads,
3-cut-seed-beads, vintage-seed-beads, seed-beads (parent).
**Excluded:** seed-bead-bundles (mixed packs, not single colors).

**5,777 unique products, deduped across collections:**

| Brand family | Count |
|---|---:|
| Preciosa Czech Seed Beads | 3,143 |
| Miyuki Delica (full mfr code parsed) | 993 |
| Vintage Venetian / Italian (Prairie Edge supplier) | 972 |
| Shipwreck House / Bundles | 558 |
| BeadSmith distribution | 69 |
| Other (Eclates, Bead Chest, Starman) | 38 |
| Truly unclassified | 4 |

**Bead sizes detected:** 6/0 (576), 8/0 (472), 10/0 (866), 11/0 (2,008),
12/0 (130), 13/0 (224), 14/0 (16), 15/0 (146).

**Live data points per product:** Shipwreck SKU, manufacturer code (where
present in title — DB001 etc.), color name, bead size, pack weight, price,
in-stock state, image URL, product URL, vendor.

### Output files

```
out/shipwreck_raw/*.json                   Raw per-collection dumps (re-runnable input).
out/shipwreck_seed_beads.normalized.json   Deduped, parsed, classified rows.
out/shipwreck_stats.json                   Counts by brand/size/stock state.
```

### Re-running

```bash
node shipwreck.js   # Re-pulls from the network (~7 min, polite pace).
node normalize.js   # Re-parses from the raw dumps on disk (no network).
```

The `normalize.js` script is iteration-safe — improve the brand/code regexes
and rerun without re-hitting Shipwreck's servers.

### Important: this is a snapshot, not a live feed

Prices and `available` (stock) state will drift as Shipwreck restocks/sells.
Two options for keeping the data fresh:

1. **Schedule** `shipwreck.js` to re-run nightly (cron / a cloud function).
   Diff against the previous run to detect new products and stock changes.
2. **Better — ask Shipwreck for an official wholesale product feed.** Since
   Designitbead is one of their customers, they may already offer this to
   business accounts (most Shopify wholesale plans do). A real-time feed beats
   any scrape and avoids the relationship awkwardness of an unsanctioned scrape
   becoming a meaningful source of traffic over time. Worth a 5-minute email.

## Files NOT used

- `BeadTool4 Libs/*.dll` — runtime DLLs, no useful catalog data.
- `Language/` — UI translation strings.
- BCP6 `.exe` files — compiled REALbasic/Xojo binaries.
- BCP6 `Stock images/`, `Training Videos/` — copyrighted media, don't redistribute.
- BCP6 `Palettes/*.pal` — encrypted, see TL;DR.
