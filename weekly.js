// Weekly orchestrator for the remote routine.
// Flow:
//   1. Load previous snapshot (out/shipwreck_seed_beads.normalized.json) if it exists.
//   2. Run shipwreck.js (network pull) + normalize.js (parse).
//   3. Diff prev vs new by shopify_product_id: new, removed, price changes, stock flips.
//   4. Write a markdown report to snapshots/{YYYY-MM-DD}/REPORT.md and copy the new
//      normalized.json into the same dated folder for permanent history.
//   5. Print the report to stdout so the routine's run log shows the summary.
//
// Designed to be idempotent: re-running on the same day overwrites that day's snapshot
// folder. Designed to be commit-friendly: the agent does `git add . && git commit && push`
// after this script finishes, so next week's run has a previous snapshot to diff against.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, "out");
const NORM_PATH = path.join(OUT_DIR, "shipwreck_seed_beads.normalized.json");
const SNAPSHOTS_DIR = path.join(ROOT, "snapshots");

function ymd(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function loadJsonOrNull(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { console.error(`Failed to parse ${p}: ${e.message}`); return null; }
}

function indexById(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.shopify_product_id, r);
  return m;
}

function fmtUsd(n) {
  if (n == null) return "—";
  return `$${Number(n).toFixed(2)}`;
}

function diff(prev, next) {
  const prevIdx = indexById(prev);
  const nextIdx = indexById(next);

  const newProducts = [];
  const removedProducts = [];
  const priceChanges = [];     // { id, title, prev, next, delta, pct }
  const wentOutOfStock = [];
  const backInStock = [];

  for (const [id, n] of nextIdx) {
    const p = prevIdx.get(id);
    if (!p) { newProducts.push(n); continue; }

    const prevPrice = p.variant?.price_usd ?? null;
    const nextPrice = n.variant?.price_usd ?? null;
    if (prevPrice != null && nextPrice != null && prevPrice !== nextPrice) {
      const delta = nextPrice - prevPrice;
      const pct = prevPrice > 0 ? (delta / prevPrice) * 100 : 0;
      priceChanges.push({ id, title: n.title, prev: prevPrice, next: nextPrice, delta, pct });
    }

    const wasAvail = !!p.variant?.available;
    const isAvail  = !!n.variant?.available;
    if (wasAvail && !isAvail) wentOutOfStock.push(n);
    if (!wasAvail && isAvail) backInStock.push(n);
  }

  for (const [id, p] of prevIdx) {
    if (!nextIdx.has(id)) removedProducts.push(p);
  }

  return { newProducts, removedProducts, priceChanges, wentOutOfStock, backInStock };
}

function summarize(prev, next, d) {
  const lines = [];
  const date = ymd();
  const prevCount = prev?.length || 0;
  const nextCount = next.length;
  const inStockNext = next.filter(r => r.variant?.available).length;
  const inStockPrev = prev ? prev.filter(r => r.variant?.available).length : 0;

  lines.push(`# Shipwreck catalog diff — ${date}`);
  lines.push(``);
  if (!prev) {
    lines.push(`First run — no previous snapshot to diff against. Captured baseline of **${nextCount}** products (**${inStockNext}** in stock).`);
    return lines.join("\n");
  }

  lines.push(`| Metric | Previous | Current | Δ |`);
  lines.push(`|---|---:|---:|---:|`);
  lines.push(`| Total products | ${prevCount} | ${nextCount} | ${(nextCount - prevCount >= 0 ? "+" : "")}${nextCount - prevCount} |`);
  lines.push(`| In stock | ${inStockPrev} | ${inStockNext} | ${(inStockNext - inStockPrev >= 0 ? "+" : "")}${inStockNext - inStockPrev} |`);
  lines.push(`| New listings | — | ${d.newProducts.length} | |`);
  lines.push(`| Removed listings | — | ${d.removedProducts.length} | |`);
  lines.push(`| Price changes | — | ${d.priceChanges.length} | |`);
  lines.push(`| Went out of stock | — | ${d.wentOutOfStock.length} | |`);
  lines.push(`| Back in stock | — | ${d.backInStock.length} | |`);
  lines.push(``);

  const sample = (arr, n = 10) => arr.slice(0, n);

  if (d.newProducts.length) {
    lines.push(`## New listings (${d.newProducts.length})`);
    lines.push(``);
    for (const r of sample(d.newProducts)) {
      lines.push(`- **${r.title}** — ${fmtUsd(r.variant?.price_usd)} ${r.variant?.available ? "✓ in stock" : "✗ out"} — [${r.shipwreck_sku || r.handle}](${r.product_url})`);
    }
    if (d.newProducts.length > 10) lines.push(`- _…and ${d.newProducts.length - 10} more_`);
    lines.push(``);
  }

  if (d.removedProducts.length) {
    lines.push(`## Removed listings (${d.removedProducts.length})`);
    lines.push(``);
    for (const r of sample(d.removedProducts)) {
      lines.push(`- ~~${r.title}~~ — was ${fmtUsd(r.variant?.price_usd)} — ${r.shipwreck_sku || r.handle}`);
    }
    if (d.removedProducts.length > 10) lines.push(`- _…and ${d.removedProducts.length - 10} more_`);
    lines.push(``);
  }

  if (d.priceChanges.length) {
    lines.push(`## Price changes (${d.priceChanges.length}) — biggest movers`);
    lines.push(``);
    const movers = [...d.priceChanges].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 15);
    lines.push(`| Title | Was | Now | Δ | Δ% |`);
    lines.push(`|---|---:|---:|---:|---:|`);
    for (const m of movers) {
      const arrow = m.delta > 0 ? "▲" : "▼";
      lines.push(`| ${m.title} | ${fmtUsd(m.prev)} | ${fmtUsd(m.next)} | ${arrow} ${fmtUsd(Math.abs(m.delta))} | ${m.pct.toFixed(1)}% |`);
    }
    lines.push(``);
  }

  if (d.wentOutOfStock.length) {
    lines.push(`## Went out of stock (${d.wentOutOfStock.length})`);
    lines.push(``);
    for (const r of sample(d.wentOutOfStock)) {
      lines.push(`- ${r.title} — ${fmtUsd(r.variant?.price_usd)} — ${r.shipwreck_sku || r.handle}`);
    }
    if (d.wentOutOfStock.length > 10) lines.push(`- _…and ${d.wentOutOfStock.length - 10} more_`);
    lines.push(``);
  }

  if (d.backInStock.length) {
    lines.push(`## Back in stock (${d.backInStock.length})`);
    lines.push(``);
    for (const r of sample(d.backInStock)) {
      lines.push(`- ${r.title} — ${fmtUsd(r.variant?.price_usd)} — ${r.shipwreck_sku || r.handle}`);
    }
    if (d.backInStock.length > 10) lines.push(`- _…and ${d.backInStock.length - 10} more_`);
    lines.push(``);
  }

  return lines.join("\n");
}

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

(async () => {
  const date = ymd();
  console.log(`Weekly catalog sync — ${date}`);

  const prev = loadJsonOrNull(NORM_PATH);
  console.log(`Previous snapshot: ${prev ? `${prev.length} products` : "(none — first run)"}`);

  // Pull + normalize. shipwreck.js writes to out/shipwreck_raw and out/shipwreck_seed_beads.normalized.json.
  run(`node "${path.join(ROOT, "shipwreck.js")}"`);
  run(`node "${path.join(ROOT, "normalize.js")}"`);

  const next = loadJsonOrNull(NORM_PATH);
  if (!next) { console.error("No new snapshot was produced — aborting."); process.exit(1); }
  console.log(`New snapshot: ${next.length} products`);

  const d = prev ? diff(prev, next) : { newProducts: [], removedProducts: [], priceChanges: [], wentOutOfStock: [], backInStock: [] };
  const report = summarize(prev, next, d);

  // Persist the dated snapshot folder for permanent history.
  const dayDir = path.join(SNAPSHOTS_DIR, date);
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, "REPORT.md"), report);
  fs.copyFileSync(NORM_PATH, path.join(dayDir, "shipwreck_seed_beads.normalized.json"));
  if (prev) {
    fs.writeFileSync(path.join(dayDir, "diff.json"), JSON.stringify({
      counts: {
        new: d.newProducts.length,
        removed: d.removedProducts.length,
        price_changes: d.priceChanges.length,
        went_out_of_stock: d.wentOutOfStock.length,
        back_in_stock: d.backInStock.length,
      },
      new_products_ids: d.newProducts.map(r => r.shopify_product_id),
      removed_product_ids: d.removedProducts.map(r => r.shopify_product_id),
      price_changes: d.priceChanges,
      went_out_of_stock_ids: d.wentOutOfStock.map(r => r.shopify_product_id),
      back_in_stock_ids: d.backInStock.map(r => r.shopify_product_id),
    }, null, 2));
  }

  // Echo report to stdout so the routine's run log surfaces the summary.
  console.log("\n" + "=".repeat(72));
  console.log(report);
  console.log("=".repeat(72));
  console.log(`\nSnapshot persisted at snapshots/${date}/`);
})();
