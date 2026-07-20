import {
  OSM_STYLE_LAYERS,
  OSM_ZOOM,
  buildMapStyle,
  buildRenderPalette,
  getBaseFillColor,
  getBaseFillLayer,
  getLandFillColor,
  getLandFillLayer,
  getMapCanvasColor,
  getMapPreviewBackgroundColor,
  getWaterPaintColor,
  layerZoomHint,
  MAP_LAYER_GROUPS,
  MAP_LAYER_KEYS,
  validateMapLayers,
  withBaseFillLayer,
  withLandFillLayer,
} from "../../shared/map-style";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const byId = Object.fromEntries(OSM_STYLE_LAYERS.map((def) => [def.id, def]));

assert(byId["built-up"]?.minzoom === OSM_ZOOM.builtUpMin, "built-up minzoom");
assert(byId["built-up"]?.maxzoom == null, "built-up has no maxzoom (always on while buildings enabled)");
assert(byId["built-up"]?.group === "buildings", "built-up tied to buildings toggle");
assert(byId.buildings?.minzoom === OSM_ZOOM.buildingsMin, "buildings minzoom");
assert(byId["labels-places"]?.minzoom === OSM_ZOOM.labelsPlacesMin, "places minzoom");
assert(byId["labels-water"]?.minzoom === OSM_ZOOM.labelsWaterMin, "water labels minzoom");
assert(byId["labels-waterway"]?.minzoom === OSM_ZOOM.labelsWaterwayMin, "waterway labels minzoom");
assert(byId["labels-park"]?.minzoom === OSM_ZOOM.labelsParkMin, "park labels minzoom");
assert(byId["labels-streets"]?.minzoom === OSM_ZOOM.labelsStreetsMin, "street labels minzoom");

const groupedKeys = MAP_LAYER_GROUPS.flatMap((g) => g.keys);
assert(
  MAP_LAYER_KEYS.every((key) => groupedKeys.includes(key)),
  "every MAP_LAYER_KEY appears in MAP_LAYER_GROUPS",
);

assert(layerZoomHint("buildings")?.includes("z12") === true, "buildings zoom hint");
assert(layerZoomHint("buildings")?.includes("z10") === true, "built-up zoom hint");
assert(layerZoomHint("streetNames")?.includes("z12") === true, "street labels zoom hint");
assert(layerZoomHint("water")?.includes("z9") === true, "water zoom hint");
assert(layerZoomHint("landForest") == null, "land has no special base-fill hint");

const style = buildMapStyle();
const layers = style.layers as Array<Record<string, unknown>>;
const builtUp = layers.find((l) => l.id === "built-up");
const buildings = layers.find((l) => l.id === "buildings");
const streets = layers.find((l) => l.id === "labels-streets");
const styleIds = new Set(layers.map((l) => l.id as string));

assert(builtUp?.minzoom === 10 && builtUp?.maxzoom == null, "buildMapStyle emits built-up from z10");
assert(buildings?.minzoom === 12, "buildMapStyle emits buildings from z12");
assert(streets?.minzoom === 12, "buildMapStyle emits street labels from z12");
assert(styleIds.has("water"), "water in default style");
assert(styleIds.has("landcover-grass"), "land in default style");

const bg = layers.find((l) => l.id === "background");
const bgPaint = bg?.paint as { "background-color"?: string } | undefined;
assert(bgPaint?.["background-color"] === "#e8eddb", "default map background is land fill");

const sandLandStyle = buildMapStyle(withLandFillLayer(validateMapLayers(undefined), "sand"));
const sandLandBg = (
  (sandLandStyle.layers as Array<Record<string, unknown>>).find((l) => l.id === "background")
    ?.paint as { "background-color"?: string }
)?.["background-color"];
assert(sandLandBg === "#e6d5a8", "map background follows sand base land fill");
assert(
  getMapPreviewBackgroundColor(withLandFillLayer(validateMapLayers(undefined), "sand")) ===
    "#e6d5a8",
  "preview background helper follows land fill",
);

const sandEmptyStyle = buildMapStyle(withBaseFillLayer(validateMapLayers(undefined), "sand"));
const sandEmptyBg = (
  (sandEmptyStyle.layers as Array<Record<string, unknown>>).find((l) => l.id === "background")
    ?.paint as { "background-color"?: string }
)?.["background-color"];
assert(sandEmptyBg === "#e8eddb", "empty fill alone does not change land-on map background");

const waterBaseStyle = buildMapStyle(withBaseFillLayer(validateMapLayers(undefined), "water"));
const waterBg = (waterBaseStyle.layers as Array<Record<string, unknown>>).find(
  (l) => l.id === "background",
);
const waterBgPaint = waterBg?.paint as { "background-color"?: string } | undefined;
assert(
  waterBgPaint?.["background-color"] === "#e8eddb",
  "map background stays land fill when empty fill is water",
);

const landDisabledCanvas = validateMapLayers({
  baseFill: "landForest",
  landForest: { enabled: false, color: "#e8eddb" },
});
assert(
  getMapCanvasColor(landDisabledCanvas) === "#ffffff",
  "land off + land empty fill → white canvas",
);
const landDisabledWaterBase = withBaseFillLayer(landDisabledCanvas, "water");
assert(
  getMapCanvasColor(landDisabledWaterBase) === "#9ebfff",
  "land off + water empty fill → water canvas",
);
assert(
  getMapPreviewBackgroundColor(landDisabledWaterBase) === "#9ebfff",
  "land-off preview uses empty fill",
);
const landDisabledStyle = buildMapStyle(landDisabledCanvas);
const landDisabledBg = (
  (landDisabledStyle.layers as Array<Record<string, unknown>>).find((l) => l.id === "background")
    ?.paint as { "background-color"?: string }
)?.["background-color"];
assert(landDisabledBg === "#ffffff", "style background clears land green when land off");
assert(
  (waterBaseStyle.layers as Array<Record<string, unknown>>).some((l) => l.id === "landcover-grass"),
  "land still drawn when water is empty fill",
);
assert(
  (waterBaseStyle.layers as Array<Record<string, unknown>>).some((l) => l.id === "water"),
  "water still drawn when water is empty fill",
);

function layerVisibility(style: Record<string, unknown>, id: string): string {
  const layer = (style.layers as Array<Record<string, unknown>>).find((l) => l.id === id);
  const layout = layer?.layout as { visibility?: string } | undefined;
  return layout?.visibility ?? "visible";
}

const disabledLand = buildMapStyle({
  landForest: { enabled: false, color: "#e8eddb" },
});
assert(layerVisibility(disabledLand, "landcover-grass") === "none", "landcover hidden when landForest disabled");
assert(layerVisibility(disabledLand, "park") === "none", "park hidden when landForest disabled");
assert(layerVisibility(disabledLand, "water") === "visible", "water still visible when landForest disabled");

const seasAsEmpty = validateMapLayers({
  baseFill: "sand",
  landFill: "landForest",
  sand: { enabled: true, color: "#ff0000" },
  landForest: { enabled: true, color: "#ffff00" },
  water: { enabled: false, color: "#9ebfff" },
});
assert(getMapCanvasColor(seasAsEmpty) === "#ffff00", "water off → canvas is base land fill");
assert(getWaterPaintColor(seasAsEmpty) === "#ff0000", "water off → seas use empty fill color");
const disabledWater = buildMapStyle(seasAsEmpty);
assert(layerVisibility(disabledWater, "water") === "visible", "water geom stays visible when off (recolored)");
assert(layerVisibility(disabledWater, "waterway") === "visible", "waterway stays visible when water off");
assert(layerVisibility(disabledWater, "labels-water") === "none", "water labels hidden when water disabled");
assert(layerVisibility(disabledWater, "labels-waterway") === "none", "waterway labels hidden when water disabled");
const waterOffPaint = (
  (disabledWater.layers as Array<Record<string, unknown>>).find((l) => l.id === "water")
    ?.paint as { "fill-color"?: string }
)?.["fill-color"];
assert(waterOffPaint === "#ff0000", "style water fill uses empty fill when water off");
const waterOffBg = (
  (disabledWater.layers as Array<Record<string, unknown>>).find((l) => l.id === "background")
    ?.paint as { "background-color"?: string }
)?.["background-color"];
assert(waterOffBg === "#ffff00", "style background is land fill with water off");

const waterOnAgain = validateMapLayers({
  ...seasAsEmpty,
  water: { enabled: true, color: "#9ebfff" },
});
assert(getWaterPaintColor(waterOnAgain) === "#9ebfff", "water on → seas use water.color");
assert(getBaseFillColor(waterOnAgain) === "#ff0000", "water on → empty fill still for stripes only");

const waterBackOn = buildMapStyle({
  baseFill: "landForest",
  water: { enabled: true, color: "#9ebfff" },
});
assert(layerVisibility(waterBackOn, "water") === "visible", "water visible when re-enabled");
assert(layerVisibility(waterBackOn, "waterway") === "visible", "waterway visible when water re-enabled");
// Explicit "visible" (not omitted) so MapLibre style diffs can undo visibility:none.
const waterLayout = (
  (waterBackOn.layers as Array<Record<string, unknown>>).find((l) => l.id === "water")
    ?.layout as { visibility?: string }
)?.visibility;
assert(waterLayout === "visible", "enabled layers emit explicit visibility:visible");

const disabledBuildings = buildMapStyle({
  buildings: { enabled: false, color: "#d9d5d0" },
});
assert(layerVisibility(disabledBuildings, "built-up") === "none", "built-up hidden when buildings disabled");
assert(layerVisibility(disabledBuildings, "buildings") === "none", "buildings hidden when buildings disabled");

const disabledRail = buildMapStyle({
  rail: { enabled: false, color: "#6a6a6a" },
});
assert(layerVisibility(disabledRail, "rail") === "none", "rail hidden when disabled");

const defaultIds = new Set(layers.map((l) => l.id as string));
for (const id of ["landcover-snow", "landcover-sand", "landcover-rock", "landcover-wetland", "rail"]) {
  assert(defaultIds.has(id), `default style includes ${id}`);
}

const palette = buildRenderPalette();
assert(typeof palette.builtUp === "string", "palette includes builtUp");
assert(palette.snow === "#f0f4f8", "palette snow color");
assert(palette.rail === "#6a6a6a", "palette rail color");
assert(palette.enabled.snow === true && palette.enabled.rail === true, "new layers enabled by default");
assert(palette.opacity.builtUp === 0.55, "palette builtUp opacity");
assert(palette.background === "#e8eddb", "default stripe base fill is land");
assert(palette.land === "#e8eddb", "default land color");
assert(palette.enabled.landForest === true && palette.enabled.water === true, "land+water on by default");
assert(getBaseFillLayer(validateMapLayers(undefined)) === "landForest", "default empty fill is land");
assert(getLandFillLayer(validateMapLayers(undefined)) === "landForest", "default land fill is land");

const waterPalette = buildRenderPalette(withBaseFillLayer(validateMapLayers(undefined), "water"));
assert(waterPalette.background === "#9ebfff", "water empty fill → stripe fill color");
assert(waterPalette.baseFill === "#9ebfff", "water empty → baseFill field");
assert(waterPalette.baseFillLayer === "water", "water empty → baseFillLayer");
assert(waterPalette.land === "#e8eddb", "land fill kept when empty fill is water");
assert(waterPalette.landFillLayer === "landForest", "default landFillLayer");
assert(waterPalette.enabled.landForest === true, "land still enabled for painting");
assert(waterPalette.enabled.water === true, "water still enabled for painting");
assert(
  getBaseFillColor(withBaseFillLayer(validateMapLayers(undefined), "water")) === "#9ebfff",
  "getBaseFillColor for water empty fill",
);

const sandLand = buildRenderPalette(
  withLandFillLayer(validateMapLayers(undefined), "sand"),
);
assert(sandLand.landFillLayer === "sand", "sand can be base land fill");
assert(sandLand.land === "#e6d5a8", "sand land fill color");
assert(sandLand.baseFill === "#e8eddb", "empty fill unchanged when land fill changes");
assert(
  getLandFillColor(withLandFillLayer(validateMapLayers(undefined), "sand")) === "#e6d5a8",
  "getLandFillColor for sand",
);

const snowBase = buildRenderPalette(withBaseFillLayer(validateMapLayers(undefined), "snow"));
assert(snowBase.baseFillLayer === "snow", "snow can be empty fill");
assert(snowBase.baseFill === "#f0f4f8", "snow empty fill color");

const legacy = validateMapLayers({
  landForest: { enabled: false, color: "#e8eddb" },
  water: { enabled: true, color: "#9ebfff" },
});
assert(legacy.baseFill === "water", "legacy XOR migrates to water empty fill");
assert(legacy.landFill === "landForest", "legacy gets default land fill");
assert(legacy.landForest.enabled === true, "legacy migration keeps land drawn");
assert(legacy.water.enabled === true, "legacy migration keeps water drawn");

const waterOffNoLegacy = validateMapLayers({
  baseFill: "landForest",
  landFill: "sand",
  landForest: { enabled: true, color: "#e8eddb" },
  water: { enabled: false, color: "#9ebfff" },
});
assert(waterOffNoLegacy.water.enabled === false, "water off is respected with baseFill");
assert(waterOffNoLegacy.baseFill === "landForest", "empty fill stays land when water off");
assert(waterOffNoLegacy.landFill === "sand", "land fill persisted");

// Old land-as-base XOR (water checkbox off) must NOT force water back on.
const oldLandBase = validateMapLayers({
  landForest: { enabled: true, color: "#e8eddb" },
  water: { enabled: false, color: "#9ebfff" },
});
assert(oldLandBase.water.enabled === false, "water off without baseFill is not forced on");
assert(oldLandBase.baseFill === "landForest", "default empty fill when missing");
assert(oldLandBase.landFill === "landForest", "default land fill when missing");

const bothOn = validateMapLayers({
  baseFill: "landForest",
  landFill: "rock",
  landForest: { enabled: true, color: "#e8eddb" },
  water: { enabled: true, color: "#9ebfff" },
});
assert(getBaseFillLayer(bothOn) === "landForest", "explicit baseFill wins");
assert(getLandFillLayer(bothOn) === "rock", "explicit landFill wins");

const landOff = validateMapLayers({
  baseFill: "water",
  landFill: "sand",
  landForest: { enabled: false, color: "#e8eddb" },
  water: { enabled: true, color: "#9ebfff" },
});
assert(landOff.landForest.enabled === false, "land can be switched off");
assert(landOff.baseFill === "water", "empty fill independent of land toggle");
assert(landOff.landFill === "sand", "land fill independent of land toggle");

console.log("map-style.test.ts: all assertions passed");
