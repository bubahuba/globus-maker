export type MapLayerKey = "water" | "streets" | "streetNames" | "buildings" | "landForest";

export interface MapLayerSettings {
  enabled: boolean;
  color: string;
}

export type MapLayerStyle = Record<MapLayerKey, MapLayerSettings>;

export type MapLayerGroupId = "land" | "water" | "transport" | "settlement" | "labels";

export interface MapLayerGroup {
  id: MapLayerGroupId;
  label: string;
  keys: MapLayerKey[];
}

/** Zoom bands for OSM style layers — keep in sync with container/tile_render.py */
export const OSM_ZOOM = {
  /** Built-up landuse from this zoom up (no upper bound; sits under building footprints). */
  builtUpMin: 10,
  buildingsMin: 12,
  labelsPlacesMin: 3,
  labelsWaterMin: 9,
  labelsWaterwayMin: 10,
  labelsParkMin: 11,
  labelsStreetsMin: 13,
} as const;

export const MAP_LAYER_KEYS: MapLayerKey[] = [
  "landForest",
  "water",
  "streets",
  "buildings",
  "streetNames",
];

export const MAP_LAYER_LABELS: Record<MapLayerKey, string> = {
  landForest: "Land / forest",
  water: "Water",
  streets: "Streets",
  buildings: "Buildings",
  streetNames: "Labels",
};

export const MAP_LAYER_GROUPS: MapLayerGroup[] = [
  { id: "land", label: "Land", keys: ["landForest"] },
  { id: "water", label: "Water", keys: ["water"] },
  { id: "transport", label: "Streets", keys: ["streets"] },
  { id: "settlement", label: "Buildings", keys: ["buildings"] },
  { id: "labels", label: "Labels", keys: ["streetNames"] },
];

export type OsmLayerType = "fill" | "line" | "symbol" | "background";

export interface StyleBuildContext {
  layers: MapLayerStyle;
}

export interface OsmStyleLayerDef {
  id: string;
  /** UI toggle that owns this layer; null = always on */
  group: MapLayerKey | null;
  sourceLayer?: string;
  type: OsmLayerType;
  minzoom?: number;
  maxzoom?: number;
  filter?: unknown;
  style: (ctx: StyleBuildContext) => {
    layout?: Record<string, unknown>;
    paint?: Record<string, unknown>;
  };
}

const LABEL_TEXT_FIELD = ["coalesce", ["get", "name"], ["get", "name:latin"], ["get", "name_en"], ""];

const STREET_FILTER: unknown = [
  "all",
  ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
  [
    "match",
    ["get", "class"],
    ["path", "pedestrian", "rail", "transit", "aerialway", "ferry"],
    false,
    true,
  ],
];

const BUILT_UP_FILTER: unknown = [
  "in",
  ["get", "class"],
  ["literal", ["residential", "commercial", "industrial", "retail"]],
];

function labelStyle(
  color: string,
  options?: {
    placement?: "point" | "line";
    size?: unknown;
  },
): { layout: Record<string, unknown>; paint: Record<string, unknown> } {
  return {
    layout: {
      "symbol-placement": options?.placement ?? "point",
      "text-field": LABEL_TEXT_FIELD,
      "text-font": ["Noto Sans Regular"],
      "text-size": options?.size ?? ["interpolate", ["linear"], ["zoom"], 8, 10, 14, 13],
      "text-max-width": 8,
    },
    paint: {
      "text-color": color,
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
    },
  };
}

/**
 * For landForest / water, `enabled` means “this color is the base fill”
 * (map background + empty stripe space), not visibility — both are always drawn.
 * Exactly one should be enabled; default is land.
 */
export const DEFAULT_MAP_LAYERS: MapLayerStyle = {
  landForest: { enabled: true, color: "#e8eddb" },
  water: { enabled: false, color: "#9ebfff" },
  streets: { enabled: true, color: "#ffffff" },
  buildings: { enabled: true, color: "#d9d5d0" },
  streetNames: { enabled: true, color: "#555555" },
};

export type BaseFillLayer = "landForest" | "water";

export function isBaseFillLayer(key: MapLayerKey): key is BaseFillLayer {
  return key === "landForest" || key === "water";
}

/** Which of land/water fills empty space (stripes, map background). Defaults to land. */
export function getBaseFillLayer(layers: MapLayerStyle): BaseFillLayer {
  if (layers.water.enabled && !layers.landForest.enabled) return "water";
  return "landForest";
}

export function getBaseFillColor(layers: MapLayerStyle): string {
  const base = getBaseFillLayer(layers);
  return layers[base].color;
}

/** Select land or water as the base fill (mutually exclusive). */
export function withBaseFillLayer(layers: MapLayerStyle, base: BaseFillLayer): MapLayerStyle {
  return {
    ...layers,
    landForest: { ...layers.landForest, enabled: base === "landForest" },
    water: { ...layers.water, enabled: base === "water" },
  };
}

/** Normalize so exactly one of land/water is the base fill (prefer land if ambiguous). */
export function ensureBaseFill(layers: MapLayerStyle): MapLayerStyle {
  return withBaseFillLayer(layers, getBaseFillLayer(layers));
}

export function createDefaultMapLayers(): MapLayerStyle {
  return Object.fromEntries(
    MAP_LAYER_KEYS.map((key) => [key, { ...DEFAULT_MAP_LAYERS[key] }]),
  ) as MapLayerStyle;
}

const VECTOR_SOURCE = "openmaptiles";
const VECTOR_TILES_URL = "https://tiles.openfreemap.org/planet";
const GLYPHS_URL = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((c) => c + c)
          .join("")
      : normalized;
  const int = Number.parseInt(value, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function darken(hex: string, amount = 0.15): string {
  const [r, g, b] = hexToRgb(hex);
  const scale = 1 - amount;
  const toHex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n * scale)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function lighten(hex: string, amount = 0.2): string {
  const [r, g, b] = hexToRgb(hex);
  const blend = (n: number) => Math.max(0, Math.min(255, Math.round(n + (255 - n) * amount)));
  const toHex = (n: number) => blend(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function normalizeMapLayers(input?: Partial<MapLayerStyle>): MapLayerStyle {
  const layers = createDefaultMapLayers();
  if (!input) return layers;

  for (const key of MAP_LAYER_KEYS) {
    const value = input[key];
    if (!value) continue;
    layers[key] = {
      enabled: value.enabled ?? layers[key].enabled,
      color: value.color ?? layers[key].color,
    };
  }
  return ensureBaseFill(layers);
}

/** Typed OSM → MapLibre layer registry (order = paint order). */
export const OSM_STYLE_LAYERS: OsmStyleLayerDef[] = [
  {
    id: "background",
    group: null,
    type: "background",
    style: ({ layers }) => ({
      paint: {
        // Map land is always the terrestrial background; base-fill choice only
        // affects empty stripe space (see buildRenderPalette.background).
        "background-color": layers.landForest.color,
      },
    }),
  },
  {
    id: "landcover-wood",
    group: "landForest",
    sourceLayer: "landcover",
    type: "fill",
    filter: ["in", ["get", "class"], ["literal", ["wood", "forest"]]],
    style: ({ layers }) => ({
      paint: {
        "fill-color": darken(layers.landForest.color, 0.12),
        "fill-opacity": 0.85,
      },
    }),
  },
  {
    id: "landcover-grass",
    group: "landForest",
    sourceLayer: "landcover",
    type: "fill",
    filter: ["in", ["get", "class"], ["literal", ["grass", "meadow", "scrub"]]],
    style: ({ layers }) => ({
      paint: {
        "fill-color": layers.landForest.color,
        "fill-opacity": 0.75,
      },
    }),
  },
  {
    id: "park",
    group: "landForest",
    sourceLayer: "park",
    type: "fill",
    style: ({ layers }) => ({
      paint: {
        "fill-color": darken(layers.landForest.color, 0.08),
        "fill-opacity": 0.8,
      },
    }),
  },
  {
    id: "water",
    group: "water",
    sourceLayer: "water",
    type: "fill",
    style: ({ layers }) => ({
      paint: { "fill-color": layers.water.color },
    }),
  },
  {
    id: "waterway",
    group: "water",
    sourceLayer: "waterway",
    type: "line",
    style: ({ layers }) => ({
      paint: {
        "line-color": layers.water.color,
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 16, 3],
      },
    }),
  },
  {
    id: "streets-casing",
    group: "streets",
    sourceLayer: "transportation",
    type: "line",
    filter: STREET_FILTER,
    style: ({ layers }) => ({
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": darken(layers.streets.color, 0.2),
        "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 10, 1, 16, 8],
      },
    }),
  },
  {
    id: "streets",
    group: "streets",
    sourceLayer: "transportation",
    type: "line",
    filter: STREET_FILTER,
    style: ({ layers }) => ({
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": layers.streets.color,
        "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 10, 0.5, 16, 6],
      },
    }),
  },
  {
    id: "boundaries-state",
    group: null,
    sourceLayer: "boundary",
    type: "line",
    filter: [
      "all",
      ["==", ["get", "admin_level"], 4],
      ["!=", ["get", "maritime"], 1],
    ],
    style: () => ({
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#888888",
        "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.75, 6, 1, 14, 1.5],
      },
    }),
  },
  {
    id: "boundaries-country",
    group: null,
    sourceLayer: "boundary",
    type: "line",
    filter: [
      "all",
      ["==", ["get", "admin_level"], 2],
      ["!=", ["get", "maritime"], 1],
      ["!=", ["get", "disputed"], 1],
    ],
    style: () => ({
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#555555",
        "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1, 6, 1.5, 14, 2.5],
      },
    }),
  },
  {
    id: "boundaries-country-disputed",
    group: null,
    sourceLayer: "boundary",
    type: "line",
    filter: [
      "all",
      ["==", ["get", "admin_level"], 2],
      ["!=", ["get", "maritime"], 1],
      ["==", ["get", "disputed"], 1],
    ],
    style: () => ({
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#b05050",
        "line-dasharray": [2, 1.5],
        "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1, 6, 1.5, 14, 2.5],
      },
    }),
  },
  {
    id: "built-up",
    // Tied to Buildings toggle/color; always drawn from builtUpMin (under footprints at z12+).
    group: "buildings",
    sourceLayer: "landuse",
    type: "fill",
    minzoom: OSM_ZOOM.builtUpMin,
    filter: BUILT_UP_FILTER,
    style: ({ layers }) => ({
      paint: {
        "fill-color": lighten(layers.buildings.color, 0.15),
        "fill-opacity": 0.55,
      },
    }),
  },
  {
    id: "buildings",
    group: "buildings",
    sourceLayer: "building",
    type: "fill",
    minzoom: OSM_ZOOM.buildingsMin,
    style: ({ layers }) => ({
      paint: {
        "fill-color": layers.buildings.color,
        "fill-outline-color": darken(layers.buildings.color, 0.25),
      },
    }),
  },
  {
    id: "labels-places",
    group: "streetNames",
    sourceLayer: "place",
    type: "symbol",
    minzoom: OSM_ZOOM.labelsPlacesMin,
    style: ({ layers }) =>
      labelStyle(layers.streetNames.color, {
        size: [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,
          ["match", ["get", "class"], "country", 13, "state", 11, "city", 10, 9],
          12,
          ["match", ["get", "class"], "country", 18, "state", 14, "city", 13, 11],
        ],
      }),
  },
  {
    id: "labels-water",
    group: "streetNames",
    sourceLayer: "water_name",
    type: "symbol",
    minzoom: OSM_ZOOM.labelsWaterMin,
    style: ({ layers }) =>
      labelStyle(layers.streetNames.color, {
        placement: "line",
        size: ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 13],
      }),
  },
  {
    id: "labels-waterway",
    group: "streetNames",
    sourceLayer: "waterway",
    type: "symbol",
    minzoom: OSM_ZOOM.labelsWaterwayMin,
    filter: ["has", "name"],
    style: ({ layers }) =>
      labelStyle(layers.streetNames.color, {
        placement: "line",
        size: ["interpolate", ["linear"], ["zoom"], 10, 9, 14, 12],
      }),
  },
  {
    id: "labels-park",
    group: "streetNames",
    sourceLayer: "park",
    type: "symbol",
    minzoom: OSM_ZOOM.labelsParkMin,
    filter: ["has", "name"],
    style: ({ layers }) => labelStyle(layers.streetNames.color, { size: 10 }),
  },
  {
    id: "labels-streets",
    group: "streetNames",
    sourceLayer: "transportation_name",
    type: "symbol",
    minzoom: OSM_ZOOM.labelsStreetsMin,
    style: ({ layers }) =>
      labelStyle(layers.streetNames.color, {
        placement: "line",
        size: ["interpolate", ["linear"], ["zoom"], 13, 9, 18, 12],
      }),
  },
];

export function layerZoomHint(key: MapLayerKey): string | null {
  switch (key) {
    case "landForest":
    case "water":
      return "Always drawn. Check to use this color as the base fill for empty stripe space.";
    case "buildings":
      return `Built-up areas from z${OSM_ZOOM.builtUpMin}; building footprints from z${OSM_ZOOM.buildingsMin}`;
    case "streetNames":
      return `Places from z${OSM_ZOOM.labelsPlacesMin}; water z${OSM_ZOOM.labelsWaterMin}; parks z${OSM_ZOOM.labelsParkMin}; streets from z${OSM_ZOOM.labelsStreetsMin}`;
    default:
      return null;
  }
}

function emitStyleLayer(def: OsmStyleLayerDef, ctx: StyleBuildContext): Record<string, unknown> {
  const { layout, paint } = def.style(ctx);
  const layer: Record<string, unknown> = {
    id: def.id,
    type: def.type,
  };

  if (def.type !== "background") {
    layer.source = VECTOR_SOURCE;
    if (def.sourceLayer) layer["source-layer"] = def.sourceLayer;
  }
  if (def.minzoom != null) layer.minzoom = def.minzoom;
  if (def.maxzoom != null) layer.maxzoom = def.maxzoom;
  if (def.filter != null) layer.filter = def.filter;
  if (layout) layer.layout = layout;
  if (paint) layer.paint = paint;

  return layer;
}

export function buildRenderPalette(input?: Partial<MapLayerStyle>): RenderPalette {
  const layers = normalizeMapLayers(input);
  const baseFill = getBaseFillColor(layers);
  const landColor = layers.landForest.color;

  return {
    /** @deprecated Prefer baseFill — kept as alias for stripe empty-space color. */
    background: baseFill,
    /** Empty stripe / projection fill from the land/water base-fill checkbox. */
    baseFill,
    /** Which layer color is used for baseFill. */
    baseFillLayer: getBaseFillLayer(layers),
    /** Map canvas / land features — always the land color, never toggled off. */
    land: landColor,
    landForest: darken(landColor, 0.12),
    landPark: darken(landColor, 0.08),
    water: layers.water.color,
    streets: layers.streets.color,
    streetCasing: darken(layers.streets.color, 0.2),
    buildings: layers.buildings.color,
    buildingOutline: darken(layers.buildings.color, 0.25),
    builtUp: lighten(layers.buildings.color, 0.15),
    labels: layers.streetNames.color,
    opacity: {
      landGrass: 0.75,
      landForest: 0.85,
      landPark: 0.8,
      builtUp: 0.55,
    },
    enabled: {
      // Land + water features are always painted; base fill is `baseFill`.
      landForest: true,
      water: true,
      streets: layers.streets.enabled,
      buildings: layers.buildings.enabled,
      labels: layers.streetNames.enabled,
    },
  };
}

export interface RenderPalette {
  background: string;
  baseFill: string;
  baseFillLayer: BaseFillLayer;
  land: string;
  landForest: string;
  landPark: string;
  water: string;
  streets: string;
  streetCasing: string;
  buildings: string;
  buildingOutline: string;
  builtUp: string;
  labels: string;
  opacity: {
    landGrass: number;
    landForest: number;
    landPark: number;
    builtUp: number;
  };
  enabled: {
    landForest: boolean;
    water: boolean;
    streets: boolean;
    buildings: boolean;
    labels: boolean;
  };
}

export function buildMapStyle(input?: Partial<MapLayerStyle>): Record<string, unknown> {
  const layers = normalizeMapLayers(input);
  const ctx: StyleBuildContext = { layers };

  const styleLayers = OSM_STYLE_LAYERS.filter((def) => {
    if (def.group == null) return true;
    // Land/water are always visible; their `enabled` flag only picks the base fill.
    if (isBaseFillLayer(def.group)) return true;
    return layers[def.group].enabled;
  }).map((def) => emitStyleLayer(def, ctx));

  return {
    version: 8,
    sources: {
      [VECTOR_SOURCE]: {
        type: "vector",
        url: VECTOR_TILES_URL,
      },
    },
    glyphs: GLYPHS_URL,
    layers: styleLayers,
  };
}

export function validateMapLayers(input: unknown): MapLayerStyle {
  if (!input || typeof input !== "object") {
    return createDefaultMapLayers();
  }

  const record = input as Partial<Record<MapLayerKey, Partial<MapLayerSettings>>>;
  const result = createDefaultMapLayers();

  for (const key of MAP_LAYER_KEYS) {
    const value = record[key];
    if (!value || typeof value !== "object") continue;
    if (typeof value.enabled === "boolean") {
      result[key].enabled = value.enabled;
    }
    if (typeof value.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value.color)) {
      result[key].color = value.color;
    }
  }

  return ensureBaseFill(result);
}
