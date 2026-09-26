// Manual catalog refresh — run it when YOU want fresh supplier prices + stock
// (double-click refresh.bat, or `npm run refresh`). Replaces the retired
// weekly scheduled sync (weekly.js / weekly.bat), which is disabled.
//
//   1. Keep one previous copy of each supplier pull in out/.previous/
//   2. Pull Shipwreck (shipwreck.js + normalize.js) and Bead Tin (beadtin.js)
//      — each with a guard: a pull under half the previous size is treated as
//      a block / network failure and the previous data is restored
//   3. Write out/REPORT.md — what changed since the last refresh
//   4. Run import-to-supabase.js, which shows the Supabase changes and asks
//      "Apply these changes to Supabase? (y/N)" before writing anything
//
// No dated snapshot folders, no git commit / push (keeps storage small).
// A short log of each run goes to logs/refresh-YYYY-MM-DD.log.
//
// Prices are compared + recorded as the supplier's REGULAR price (MSRP, see
// msrp.js) — seasonal / random supplier sales are ignored.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { regularPrice, onSale } = require("./msrp");

const ROOT = __dirname;
const OUT = path.join(ROOT, "out");
const PREV = path.join(OUT, ".previous");
const LOGS = path.join(ROOT, "logs");
const FILES = {
  shipwreck: "shipwreck_seed_beads.normalized.json",
  beadtin: "beadtin_barrels.normalized.json",
};
// Local calendar date (not UTC) for the log + report names.
const date = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
fs.mkdirSync(PREV, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });
const LOG = path.join(LOGS, `refresh-${date}.log`);
const log = (s = "") => { console.log(s); fs.appendFileSync(LOG, s + "\n"); };

const load = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);

// Run a pull script, echoing + logging its output. Returns true on success.
function run(script) {
  log(`\n$ node ${script}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  process.stdout.write(out);
  fs.appendFileSync(LOG, out);
  return r.status === 0;
}

// Diff two pulls by Shopify product id.
function diff(prev, next, pick) {
  const P = new Map((prev || []).map(r => [r.shopify_product_id, r]));
  const N = new Map(next.map(r => [r.shopify_product_id, r]));
  const d = { added: [], removed: [], price: [], out: [], back: [] };
  for (const [id, n] of N) {
    const p = P.get(id);
    if (!p) { d.added.push(n); continue; }
    const a = pick(p), b = pick(n);
    if (a.price != null && b.price != null && a.price !== b.price) d.price.push({ n, was: a.price, now: b.price });
    if (a.available && !b.available) d.out.push(n);
    if (!a.available && b.available) d.back.push(n);
  }
  for (const [id, p] of P) if (!N.has(id)) d.removed.push(p);
  d.onSale = next.filter(r => pick(r).sale).length;
  return d;
}

function section(name, prev, next, d, label) {
  const L = [`## ${name}`, ""];
  if (!prev) { L.push(`First refresh — ${next.length} products captured as the baseline.`, ""); return L; }
  L.push(`${prev.length} → ${next.length} products · ${d.added.length} new · ${d.removed.length} removed · ` +
    `${d.price.length} MSRP price changes · ${d.out.length} went out of stock · ${d.back.length} back in stock`, "");
  if (d.onSale) L.push(`FYI: ${d.onSale} products are on sale at the supplier right now — sale ignored; ` +
    `prices here are regular (MSRP) prices.`, "");
  const list = (title, arr, fmt) => {
    if (!arr.length) return;
    L.push(`**${title}**`);
    for (const x of arr.slice(0, 15)) L.push(`- ${fmt(x)}`);
    if (arr.length > 15) L.push(`- …and ${arr.length - 15} more`);
    L.push("");
  };
  list("Regular (MSRP) price changes", d.price, x => `${label(x.n)}: $${x.was} → $${x.now}`);
  list("Went out of stock", d.out, label);
  list("Back in stock", d.back, label);
  list("New listings", d.added, label);
  return L;
}

(() => {
  log(`=== Catalog refresh — ${new Date().toLocaleString()} ===`);

  // 1. Keep the current pulls as "previous".
  const prev = {};
  for (const [k, f] of Object.entries(FILES)) {
    const cur = path.join(OUT, f);
    if (fs.existsSync(cur)) fs.copyFileSync(cur, path.join(PREV, f));
    prev[k] = load(path.join(PREV, f));
  }

  // 2. Pull. Shipwreck: guard here (shipwreck.js has none). Bead Tin guards itself.
  let swOk = run("shipwreck.js") && run("normalize.js");
  const sw = load(path.join(OUT, FILES.shipwreck));
  if (!swOk || !sw || (prev.shipwreck && sw.length < Math.max(100, prev.shipwreck.length * 0.5))) {
    log(`\n⚠ Shipwreck pull looks broken (${sw ? sw.length : 0} products) — restoring the previous data.`);
    if (prev.shipwreck) fs.copyFileSync(path.join(PREV, FILES.shipwreck), path.join(OUT, FILES.shipwreck));
    swOk = false;
  }
  const btOk = run("beadtin.js");
  const bt = load(path.join(OUT, FILES.beadtin));

  // 3. Report.
  const R = [`# Catalog refresh — ${date}`, ""];
  if (swOk && sw) R.push(...section("Shipwreck", prev.shipwreck, sw,
    diff(prev.shipwreck, sw, r => ({ price: regularPrice(r.variant?.price_usd, r.variant?.compare_at_price_usd), sale: onSale(r.variant?.price_usd, r.variant?.compare_at_price_usd), available: !!r.variant?.available })),
    r => `${r.title} (${r.shipwreck_sku || r.handle})`));
  else R.push("## Shipwreck", "", "Pull failed — previous data kept.", "");
  if (btOk && bt) R.push(...section("Bead Tin (pony)", prev.beadtin, bt,
    diff(prev.beadtin, bt, r => ({ price: regularPrice(r.price_usd, r.compare_at_price_usd), sale: onSale(r.price_usd, r.compare_at_price_usd), available: r.available })),
    r => `${r.title} (${r.sku})`));
  else R.push("## Bead Tin (pony)", "", "Pull failed — previous data kept.", "");
  const report = R.join("\n");
  fs.writeFileSync(path.join(OUT, "REPORT.md"), report);
  log("\n" + "=".repeat(70) + "\n" + report + "=".repeat(70));
  log("Report saved to out/REPORT.md");

  // 4. Import — interactive (it asks before writing anything).
  log("\n$ node import-to-supabase.js   (shows changes, then asks before writing)");
  const imp = spawnSync(process.execPath, [path.join(ROOT, "import-to-supabase.js")], { cwd: ROOT, stdio: "inherit" });
  log(`\nImport step exit code: ${imp.status}`);
  log(`Refresh finished — log: logs/refresh-${date}.log`);
})();
