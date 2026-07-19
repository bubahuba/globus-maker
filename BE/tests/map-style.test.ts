import {
  OSM_STYLE_LAYERS,
  OSM_ZOOM,
  buildMapStyle,
  buildRenderPalette,
  getBaseFillColor,
  getBaseFillLayer,
  layerZoomHint,
  MAP_LAYER_GROUPS,
  MAP_LAYER_KEYS,
  validateMapLayers,
  withBaseFillLayer,
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
assert(layerZoomHint("streetNames")?.includes("z13") === true, "street labels zoom hint");
assert(layerZoomHint("water")?.includes("base fill") === true, "water base-fill hint");
assert(layerZoomHint("landForest")?.includes("base fill") === true, "land base-fill hint");

const style = buildMapStyle();
const layers = style.layers as Array<Record<string, unknown>>;
const builtUp = layers.find((l) => l.id === "built-up");
const buildings = layers.find((l) => l.id === "buildings");
const streets = layers.find((l) => l.id === "labels-streets");
const styleIds = new Set(layers.map((l) => l.id as string));

assert(builtUp?.minzoom === 10 && builtUp?.maxzoom == null, "buildMapStyle emits built-up from z10");
assert(buildings?.minzoom === 12, "buildMapStyle emits buildings from z12");
assert(streets?.minzoom === 13, "buildMapStyle emits street labels from z13");
assert(styleIds.has("water"), "water always in style when land is base");
assert(styleIds.has("landcover-grass"), "land always in style when land is base");

const bg = layers.find((l) => l.id === "background");
const bgPaint = bg?.paint as { "background-color"?: string } | undefined;
assert(bgPaint?.["background-color"] === "#e8eddb", "default map background is land color");

const waterBaseStyle = buildMapStyle(
  withBaseFillLayer(validateMapLayers(undefined), "water"),
);
const waterBg = (waterBaseStyle.layers as Array<Record<string, unknown>>).find(
  (l) => l.id === "background",
);
const waterBgPaint = waterBg?.paint as { "background-color"?: string } | undefined;
assert(
  waterBgPaint?.["background-color"] === "#e8eddb",
  "map background stays land when water is stripe base fill",
);
assert(
  (waterBaseStyle.layers as Array<Record<string, unknown>>).some((l) => l.id === "landcover-grass"),
  "land still drawn when water is base",
);
assert(
  (waterBaseStyle.layers as Array<Record<string, unknown>>).some((l) => l.id === "water"),
  "water still drawn when water is base",
);

const disabledBuildings = buildMapStyle({
  buildings: { enabled: false, color: "#d9d5d0" },
});
const disabledIds = new Set(
  (disabledBuildings.layers as Array<Record<string, unknown>>).map((l) => l.id),
);
assert(!disabledIds.has("built-up"), "built-up omitted when buildings disabled");
assert(!disabledIds.has("buildings"), "buildings omitted when buildings disabled");

const palette = buildRenderPalette();
assert(typeof palette.builtUp === "string", "palette includes builtUp");
assert(palette.opacity.builtUp === 0.55, "palette builtUp opacity");
assert(palette.background === "#e8eddb", "default stripe base fill is land");
assert(palette.land === "#e8eddb", "default land color");
assert(palette.enabled.landForest === true && palette.enabled.water === true, "land+water always on");
assert(getBaseFillLayer(validateMapLayers(undefined)) === "landForest", "default base is land");

const waterPalette = buildRenderPalette(withBaseFillLayer(validateMapLayers(undefined), "water"));
assert(waterPalette.background === "#9ebfff", "water base → stripe fill color");
assert(waterPalette.baseFill === "#9ebfff", "water base → baseFill field");
assert(waterPalette.baseFillLayer === "water", "water base → baseFillLayer");
assert(waterPalette.land === "#e8eddb", "land map color kept when water is stripe base");
assert(waterPalette.enabled.landForest === true, "land still enabled for painting");
assert(waterPalette.enabled.water === true, "water still enabled for painting");
assert(
  getBaseFillColor(withBaseFillLayer(validateMapLayers(undefined), "water")) === "#9ebfff",
  "getBaseFillColor for water base",
);

const bothOn = validateMapLayers({
  landForest: { enabled: true, color: "#e8eddb" },
  water: { enabled: true, color: "#9ebfff" },
});
assert(getBaseFillLayer(bothOn) === "landForest", "ambiguous both-on normalizes to land");

console.log("map-style.test.ts: all assertions passed");
