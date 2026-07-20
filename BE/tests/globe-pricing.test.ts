import assert from "node:assert/strict";
import {
  GLOBE_PRICE_MAX_CM,
  GLOBE_PRICE_MAX_EUR,
  GLOBE_PRICE_MIN_CM,
  GLOBE_PRICE_MIN_EUR,
  globeDownloadPriceEuro,
} from "../../shared/globe-pricing";

assert.equal(globeDownloadPriceEuro(GLOBE_PRICE_MIN_CM), GLOBE_PRICE_MIN_EUR.toFixed(2));
assert.equal(globeDownloadPriceEuro(GLOBE_PRICE_MAX_CM), GLOBE_PRICE_MAX_EUR.toFixed(2));
assert.equal(globeDownloadPriceEuro(10), "2.00", "below min clamps to €2");
assert.equal(globeDownloadPriceEuro(80), "6.00", "above max clamps to €6");
assert.equal(globeDownloadPriceEuro(40), "4.00", "midpoint €4");
assert.equal(globeDownloadPriceEuro(25), "2.50", "25 cm → €2.50");
assert.equal(globeDownloadPriceEuro(Number.NaN), "2.00");

console.log("globe-pricing.test.ts: all assertions passed");
