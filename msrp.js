// Regular (MSRP) price for a supplier product. Shopify lists a sale as
// price < compare_at_price, where compare_at is the regular price. We record
// the regular price only, so supplier sales (seasonal or random) never move
// our kit costs. Higher of the two wins — also ignores a stale lower compare_at.
function regularPrice(price, compareAt) {
  const vals = [price, compareAt].filter(v => v != null && !Number.isNaN(Number(v))).map(Number);
  return vals.length ? Math.max(...vals) : null;
}

const onSale = (price, compareAt) =>
  price != null && compareAt != null && Number(compareAt) > Number(price);

module.exports = { regularPrice, onSale };
