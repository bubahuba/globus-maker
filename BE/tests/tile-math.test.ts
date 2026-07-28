import {
  buildTileManifest,
  squareBounds,
  stripeHeightPx,
  stripeWidthPx,
  pickZoom,
  resolveZoom,
  resolveTargetOutputPx,
  tileCountForBounds,
  maxFeasibleZoom,
  areaCapZoom,
  validateJobInput,
} from "../src/osm/tile-math";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

// Kninice reference area (~2.5km square)
const kniniceCenter = { lat: 49.5467, lng: 16.6963 };
const diameterCm = 25;

const manifest = buildTileManifest(kniniceCenter, 2500, { diameterCm });
assert(manifest.tiles.length > 0, "manifest should include tiles");
assert(manifest.zoom >= 1 && manifest.zoom <= 14, "zoom in range");
assert(manifest.outputSizePx >= 300, "native tile output should cover the selected area");
assert(manifest.targetOutputPx === stripeHeightPx(diameterCm), "target output should match globe size");

const mapManifest = buildTileManifest(kniniceCenter, 2500, { targetOutputPx: 3000 });
assert(mapManifest.targetOutputPx >= 3000, "map targetOutputPx should honor squareSidePx");

const stripeH = stripeHeightPx(diameterCm);
assert(stripeH === 6283, `25cm globe should produce 6283px stripes, got ${stripeH}`);

const stripeW = stripeWidthPx(stripeH, 12);
assert(stripeW === 1131, `12 stripes at 6283px height should be 1131px wide, got ${stripeW}`);

assert(
  resolveTargetOutputPx({ mode: "globe", diameterCm }) === stripeH,
  "globe target should be stripe height",
);
assert(
  resolveTargetOutputPx({ mode: "map", squareSidePx: 3200 }) === 3200,
  "map target should be squareSidePx",
);

const resolvedZoom = resolveZoom(kniniceCenter, 2500, stripeH);
assert(resolvedZoom === pickZoom(squareBounds(kniniceCenter, 2500), stripeH, 2500), "resolveZoom should match pickZoom");

const largeAreaZoom = resolveZoom(kniniceCenter, 8000, stripeH);
assert(largeAreaZoom < 14, `8000m selection should use zoom below 14, got ${largeAreaZoom}`);
assert(largeAreaZoom === areaCapZoom(8000), `8000m should cap at area zoom ${areaCapZoom(8000)}`);

const continentZoom = resolveZoom(kniniceCenter, 5_000_000, stripeH);
assert(continentZoom <= 4, `continent-scale selection should use low zoom, got ${continentZoom}`);

const smallGlobeZoom = resolveZoom(kniniceCenter, 2500, stripeHeightPx(10));
const largeGlobeZoom = resolveZoom(kniniceCenter, 2500, stripeHeightPx(60));
assert(largeGlobeZoom >= smallGlobeZoom, "larger globes should prefer equal or higher tile zoom");

const bounds = squareBounds(kniniceCenter, 2500);
const tilesAt19 = tileCountForBounds(bounds, 19);
if (tilesAt19 > 400) {
  assert(pickZoom(bounds, stripeH) <= 14, "auto zoom should stay within vector tile max");
  assert(maxFeasibleZoom(bounds) <= 14, "max feasible zoom should stay within vector tile max");
}

assert(
  validateJobInput({
    center: kniniceCenter,
    sideMeters: 2500,
    mode: "globe",
    stripes: 12,
    diameterCm: 25,
  }) === null,
  "valid globe request should pass",
);

assert(
  validateJobInput({
    center: kniniceCenter,
    sideMeters: 2500,
    mode: "map",
    squareSidePx: 4000,
    outputFormat: "svg",
  }) === null,
  "valid map request should pass",
);

assert(
  validateJobInput({
    center: kniniceCenter,
    sideMeters: 2500,
    mode: "globe",
    stripes: 12,
    diameterCm: 25,
    outputFormat: "svg",
  }) != null,
  "globe SVG output should be rejected",
);

assert(
  validateJobInput({
    center: kniniceCenter,
    sideMeters: 2500,
    mode: "map",
    squareSidePx: 100,
  }) != null,
  "map squareSidePx below min should fail",
);

assert(
  validateJobInput({
    center: kniniceCenter,
    sideMeters: 2500,
    mode: "map",
    squareSidePx: 10000,
  }) === null,
  "map squareSidePx of 10000 should pass",
);

assert(
  validateJobInput({
    center: kniniceCenter,
    sideMeters: 2500,
    mode: "map",
    squareSidePx: 10001,
  }) != null,
  "map squareSidePx above 10000 should fail",
);

assert(
  validateJobInput(
    {
      center: { lat: 0, lng: 0 },
      sideMeters: 1,
      mode: "globe",
      stripes: 12,
      diameterCm: 25,
    },
    { hasSourceMap: true },
  ) === null,
  "uploaded globe map should skip OSM selection checks",
);

assert(
  validateJobInput(
    {
      center: { lat: 0, lng: 0 },
      sideMeters: 1,
      mode: "map",
      squareSidePx: 4000,
    },
    { hasSourceMap: true },
  ) != null,
  "uploaded map must be globe mode",
);

console.log("tile-math tests passed");
console.log(
  JSON.stringify(
    {
      zoom: manifest.zoom,
      tileCount: manifest.tiles.length,
      outputSizePx: manifest.outputSizePx,
      targetOutputPx: manifest.targetOutputPx,
      stripeHeightPx: stripeH,
      stripeWidthPx: stripeW,
    },
    null,
    2,
  ),
);
