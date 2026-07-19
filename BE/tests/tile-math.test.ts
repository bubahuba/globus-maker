import {
  buildTileManifest,
  squareBounds,
  stripeHeightPx,
  stripeWidthPx,
  pickZoom,
  resolveZoom,
  tileCountForBounds,
  maxFeasibleZoom,
  areaCapZoom,
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

const stripeH = stripeHeightPx(diameterCm);
assert(stripeH === 4000, `25cm globe should produce 4000px stripes, got ${stripeH}`);

const stripeW = stripeWidthPx(stripeH, 12);
assert(stripeW === 720, `12 stripes at 4000px height should be 720px wide, got ${stripeW}`);

const resolvedZoom = resolveZoom(kniniceCenter, 2500, diameterCm);
assert(resolvedZoom === pickZoom(squareBounds(kniniceCenter, 2500), stripeH, 2500), "resolveZoom should match pickZoom");

const largeAreaZoom = resolveZoom(kniniceCenter, 8000, diameterCm);
assert(largeAreaZoom < 14, `8000m selection should use zoom below 14, got ${largeAreaZoom}`);
assert(largeAreaZoom === areaCapZoom(8000), `8000m should cap at area zoom ${areaCapZoom(8000)}`);

const continentZoom = resolveZoom(kniniceCenter, 5_000_000, diameterCm);
assert(continentZoom <= 4, `continent-scale selection should use low zoom, got ${continentZoom}`);

const smallGlobeZoom = resolveZoom(kniniceCenter, 2500, 10);
const largeGlobeZoom = resolveZoom(kniniceCenter, 2500, 60);
assert(largeGlobeZoom >= smallGlobeZoom, "larger globes should prefer equal or higher tile zoom");

const bounds = squareBounds(kniniceCenter, 2500);
const tilesAt19 = tileCountForBounds(bounds, 19);
if (tilesAt19 > 400) {
  assert(pickZoom(bounds, stripeH) <= 14, "auto zoom should stay within vector tile max");
  assert(maxFeasibleZoom(bounds) <= 14, "max feasible zoom should stay within vector tile max");
}

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
