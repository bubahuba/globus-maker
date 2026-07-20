export type MapLayerKey =
  | "water"
  | "streets"
  | "airports"
  | "streetNames"
  | "buildings"
  | "landForest"
  | "snow"
  | "sand"
  | "rock"
  | "wetland"
  | "rail";

export interface MapLayerSettings {
  enabled: boolean;
  color: string;
}

/**
 * Per-layer visibility + color.
 * - `baseFill` (Empty fill): empty stripe / projection space
 * - `landFill` (Base land fill): terrestrial shore / land mass color
 */
export type MapLayerStyle = {
  baseFill: MapLayerKey;
  landFill: MapLayerKey;
} & Record<MapLayerKey, MapLayerSettings>;

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
  labelsTownsMin: 6,
  labelsVillagesMin: 9,
  /**
   * Districts / boroughs in OMT `place` tiles (suburb, neighbourhood, quarter).
   * Data starts at z11. maplibre-gl-leaflet uses ML zoom = Leaflet−1, so Leaflet
   * z11 loads z10 tiles — FE fills that gap via `place-overzoom` GeoJSON.
   */
  labelsSuburbsMin: 11,
  labelsWaterMin: 9,
  labelsWaterwayMin: 10,
  labelsParkMin: 11,
  /** MapLibre zoom (Leaflet UI zoom − 1). 10 ≈ Leaflet UI zoom 11. */
  labelsStreetsMin: 10,
  /** Motorway / trunk / primary route shields (D1, R7, …). */
  labelsHighwayRefsMin: 8,
  /** Aeroway polygons/lines + aerodrome labels (OMT `aeroway` / `aerodrome_label`). */
  aerowaysMin: 10,
} as const;

export const MAP_LAYER_KEYS: MapLayerKey[] = [
  "landForest",
  "snow",
  "sand",
  "rock",
  "wetland",
  "water",
  "streets",
  "airports",
  "rail",
  "buildings",
  "streetNames",
];

export const MAP_LAYER_LABELS: Record<MapLayerKey, string> = {
  landForest: "Land / forest",
  snow: "Snow / ice",
  sand: "Sand",
  rock: "Rock",
  wetland: "Wetland",
  water: "Water",
  streets: "Streets",
  airports: "Airports",
  rail: "Rail",
  buildings: "Buildings",
  streetNames: "Labels",
};

export const MAP_LAYER_GROUPS: MapLayerGroup[] = [
  { id: "land", label: "Land", keys: ["landForest", "snow", "sand", "rock", "wetland"] },
  { id: "water", label: "Water", keys: ["water"] },
  { id: "transport", label: "Transport", keys: ["streets", "airports", "rail"] },
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
  /** Defaults to the OpenMapTiles vector source. */
  source?: string;
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

/** GeoJSON source filled by FE when ML zoom is 10 (Leaflet UI zoom 11). */
export const PLACE_OVERZOOM_SOURCE = "place-overzoom";

const LABEL_TEXT_FIELD = ["coalesce", ["get", "name"], ["get", "name:latin"], ["get", "name_en"]];

const PLACE_NAME_FIELD = [
  "coalesce",
  ["get", "name"],
  ["get", "name:latin"],
  ["get", "name_en"],
  ["get", "name_int"],
];

const RAIL_SUBCLASSES = [
  "rail",
  "narrow_gauge",
  "preserved",
  "funicular",
  "subway",
  "light_rail",
  "monorail",
  "tram",
] as const;

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
  ["!", ["in", ["get", "subclass"], ["literal", [...RAIL_SUBCLASSES]]]],
];

const RAIL_FILTER: unknown = [
  "all",
  ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
  [
    "any",
    ["in", ["get", "class"], ["literal", ["rail", "transit"]]],
    ["in", ["get", "subclass"], ["literal", [...RAIL_SUBCLASSES]]],
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
    placement?: "point" | "line" | unknown;
    size?: unknown;
    textField?: unknown;
    padding?: number;
    font?: string[];
    /** When true, label may overlap others (use for sparse place tiers). */
    allowOverlap?: boolean;
  },
): { layout: Record<string, unknown>; paint: Record<string, unknown> } {
  return {
    layout: {
      "symbol-placement": options?.placement ?? "point",
      "text-field": options?.textField ?? LABEL_TEXT_FIELD,
      "text-font": options?.font ?? ["Noto Sans Regular"],
      "text-size": options?.size ?? ["interpolate", ["linear"], ["zoom"], 8, 10, 14, 13],
      "text-max-width": 8,
      ...(options?.padding != null ? { "text-padding": options.padding } : {}),
      ...(options?.allowOverlap
        ? { "text-allow-overlap": true, "text-ignore-placement": true }
        : {}),
    },
    paint: {
      "text-color": color,
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
    },
  };
}

/** Empty fill (stripe / projection empty space). */
export const DEFAULT_BASE_FILL: MapLayerKey = "landForest";
/** Base land fill (shore / terrestrial mass). */
export const DEFAULT_LAND_FILL: MapLayerKey = "landForest";

/** Default toggles/colors (without fill selects — see createDefaultMapLayers). */
export const DEFAULT_MAP_LAYER_SETTINGS: Record<MapLayerKey, MapLayerSettings> = {
  landForest: { enabled: true, color: "#e8eddb" },
  snow: { enabled: true, color: "#f0f4f8" },
  sand: { enabled: true, color: "#e6d5a8" },
  rock: { enabled: true, color: "#c2bdb6" },
  wetland: { enabled: true, color: "#a8c4b0" },
  water: { enabled: true, color: "#9ebfff" },
  streets: { enabled: true, color: "#ffffff" },
  airports: { enabled: true, color: "#d4cfc6" },
  rail: { enabled: true, color: "#6a6a6a" },
  buildings: { enabled: true, color: "#d9d5d0" },
  streetNames: { enabled: true, color: "#555555" },
};

/** @deprecated Prefer DEFAULT_MAP_LAYER_SETTINGS + createDefaultMapLayers(). */
export const DEFAULT_MAP_LAYERS: MapLayerStyle = {
  baseFill: DEFAULT_BASE_FILL,
  landFill: DEFAULT_LAND_FILL,
  ...Object.fromEntries(
    MAP_LAYER_KEYS.map((key) => [key, { ...DEFAULT_MAP_LAYER_SETTINGS[key] }]),
  ),
} as MapLayerStyle;

/** @deprecated Empty/land fill are any MapLayerKey via style.baseFill / style.landFill. */
export type BaseFillLayer = MapLayerKey;

export function isMapLayerKey(value: unknown): value is MapLayerKey {
  return typeof value === "string" && (MAP_LAYER_KEYS as string[]).includes(value);
}

/** @deprecated All layers can supply fill colors; kept for call-site compatibility. */
export function isBaseFillLayer(key: MapLayerKey): boolean {
  return isMapLayerKey(key);
}

/** Which layer color fills empty stripe / projection space (Empty fill). */
export function getBaseFillLayer(layers: MapLayerStyle): MapLayerKey {
  return isMapLayerKey(layers.baseFill) ? layers.baseFill : DEFAULT_BASE_FILL;
}

export function getBaseFillColor(layers: MapLayerStyle): string {
  const base = getBaseFillLayer(layers);
  return layers[base].color;
}

/** Which layer color paints shore / terrestrial land (Base land fill). */
export function getLandFillLayer(layers: MapLayerStyle): MapLayerKey {
  return isMapLayerKey(layers.landFill) ? layers.landFill : DEFAULT_LAND_FILL;
}

export function getLandFillColor(layers: MapLayerStyle): string {
  return layers[getLandFillLayer(layers)].color;
}

/**
 * Map / SVG land canvas: Base land fill while land is on (continents / shore).
 * When land is off, Empty fill (or white if empty fill is still land).
 *
 * Oceans: water layer ON → water.color; water OFF → Empty fill color painted
 * on water geometry (so seas become empty-fill, not hidden). Empty fill on
 * stripes is unchanged (processor `baseFill`).
 */
export function getMapCanvasColor(layers: MapLayerStyle): string {
  if (layers.landForest.enabled) {
    return getLandFillColor(layers);
  }
  if (getBaseFillLayer(layers) === "landForest") {
    return "#ffffff";
  }
  return getBaseFillColor(layers);
}

/** @deprecated Use getMapCanvasColor — same land/empty wiring for the map preview. */
export function getMapPreviewBackgroundColor(layers: MapLayerStyle): string {
  return getMapCanvasColor(layers);
}

/** Fill/line color for water geometry: water.color, or Empty fill when water is off. */
export function getWaterPaintColor(layers: MapLayerStyle): string {
  if (layers.water.enabled) return layers.water.color;
  return getBaseFillColor(layers);
}

/** Set the empty-fill source layer (does not change visibility toggles). */
export function withBaseFillLayer(layers: MapLayerStyle, base: MapLayerKey): MapLayerStyle {
  const key = isMapLayerKey(base) ? base : DEFAULT_BASE_FILL;
  return { ...layers, baseFill: key };
}

/** Set the base land-fill source layer (does not change visibility toggles). */
export function withLandFillLayer(layers: MapLayerStyle, land: MapLayerKey): MapLayerStyle {
  const key = isMapLayerKey(land) ? land : DEFAULT_LAND_FILL;
  return { ...layers, landFill: key };
}

/** Ensure `baseFill` and `landFill` are valid layer keys. */
export function ensureBaseFill(layers: MapLayerStyle): MapLayerStyle {
  let next = layers;
  if (!isMapLayerKey(next.baseFill)) next = { ...next, baseFill: DEFAULT_BASE_FILL };
  if (!isMapLayerKey(next.landFill)) next = { ...next, landFill: DEFAULT_LAND_FILL };
  return next;
}

export function createDefaultMapLayers(): MapLayerStyle {
  return {
    baseFill: DEFAULT_BASE_FILL,
    landFill: DEFAULT_LAND_FILL,
    ...Object.fromEntries(
      MAP_LAYER_KEYS.map((key) => [key, { ...DEFAULT_MAP_LAYER_SETTINGS[key] }]),
    ),
  } as MapLayerStyle;
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

  if (isMapLayerKey(input.baseFill)) {
    layers.baseFill = input.baseFill;
  } else if (
    // Legacy XOR: water checkbox alone meant water empty fill (both layers drawn).
    input.water?.enabled === true &&
    input.landForest?.enabled === false
  ) {
    layers.baseFill = "water";
    layers.landForest = { ...layers.landForest, enabled: true };
    layers.water = { ...layers.water, enabled: true };
  }

  if (isMapLayerKey(input.landFill)) {
    layers.landFill = input.landFill;
  }

  for (const key of MAP_LAYER_KEYS) {
    const value = input[key];
    if (!value) continue;
    layers[key] = {
      enabled: value.enabled ?? layers[key].enabled,
      color: value.color ?? layers[key].color,
    };
  }

  // Re-apply legacy water-as-empty visibility after the per-key merge.
  if (
    !isMapLayerKey(input.baseFill) &&
    input.water?.enabled === true &&
    input.landForest?.enabled === false
  ) {
    layers.landForest = { ...layers.landForest, enabled: true };
    layers.water = { ...layers.water, enabled: true };
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
        "background-color": getMapPreviewBackgroundColor(layers),
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
        // Shore / open land uses Base land fill (not the forest layer color).
        "fill-color": getLandFillColor(layers),
        "fill-opacity": 0.75,
      },
    }),
  },
  {
    id: "landcover-snow",
    group: "snow",
    sourceLayer: "landcover",
    type: "fill",
    filter: ["==", ["get", "class"], "ice"],
    style: ({ layers }) => ({
      paint: {
        "fill-color": layers.snow.color,
        "fill-opacity": 0.95,
      },
    }),
  },
  {
    id: "landcover-sand",
    group: "sand",
    sourceLayer: "landcover",
    type: "fill",
    filter: ["==", ["get", "class"], "sand"],
    style: ({ layers }) => ({
      paint: {
        "fill-color": layers.sand.color,
        "fill-opacity": 0.9,
      },
    }),
  },
  {
    id: "landcover-rock",
    group: "rock",
    sourceLayer: "landcover",
    type: "fill",
    filter: ["==", ["get", "class"], "rock"],
    style: ({ layers }) => ({
      paint: {
        "fill-color": layers.rock.color,
        "fill-opacity": 0.9,
      },
    }),
  },
  {
    id: "landcover-wetland",
    group: "wetland",
    sourceLayer: "landcover",
    type: "fill",
    filter: ["==", ["get", "class"], "wetland"],
    style: ({ layers }) => ({
      paint: {
        "fill-color": layers.wetland.color,
        "fill-opacity": 0.85,
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
      // Always drawn: water.color when on, Empty fill when off (seas → empty color).
      paint: { "fill-color": getWaterPaintColor(layers) },
    }),
  },
  {
    id: "waterway",
    group: "water",
    sourceLayer: "waterway",
    type: "line",
    style: ({ layers }) => ({
      paint: {
        "line-color": getWaterPaintColor(layers),
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 16, 3],
      },
    }),
  },
  {
    id: "aeroway-fill",
    group: "airports",
    sourceLayer: "aeroway",
    type: "fill",
    minzoom: OSM_ZOOM.aerowaysMin,
    // Apron/terminal vs runway/taxiway footprints (match processor).
    filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
    style: ({ layers }) => {
      const apron = layers.airports.color;
      const runway = lighten(layers.airports.color, 0.12);
      const taxi = lighten(layers.airports.color, 0.08);
      return {
        paint: {
          "fill-color": [
            "match",
            ["get", "class"],
            "runway",
            runway,
            "taxiway",
            taxi,
            apron,
          ],
          "fill-opacity": [
            "match",
            ["get", "class"],
            "runway",
            0.9,
            "taxiway",
            0.85,
            "apron",
            0.75,
            "aerodrome",
            0.75,
            "heliport",
            0.75,
            "helipad",
            0.75,
            0.55,
          ],
        },
      };
    },
  },
  {
    id: "aeroway-runway",
    group: "airports",
    sourceLayer: "aeroway",
    type: "line",
    minzoom: OSM_ZOOM.aerowaysMin,
    filter: [
      "all",
      ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
      ["==", ["get", "class"], "runway"],
    ],
    style: ({ layers }) => ({
      layout: { "line-cap": "butt", "line-join": "miter" },
      paint: {
        "line-color": lighten(layers.airports.color, 0.12),
        "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 10, 2, 16, 12],
      },
    }),
  },
  {
    id: "aeroway-taxiway",
    group: "airports",
    sourceLayer: "aeroway",
    type: "line",
    minzoom: OSM_ZOOM.aerowaysMin,
    filter: [
      "all",
      ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
      ["==", ["get", "class"], "taxiway"],
    ],
    style: ({ layers }) => ({
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": lighten(layers.airports.color, 0.08),
        "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 10, 0.5, 16, 4],
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
        "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 10, 0.6, 16, 3.5],
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
        "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 10, 0.35, 16, 2.5],
      },
    }),
  },
  {
    id: "rail",
    group: "rail",
    sourceLayer: "transportation",
    type: "line",
    filter: RAIL_FILTER,
    style: ({ layers }) => ({
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": layers.rail.color,
        "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 10, 0.3, 16, 1.5],
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
    id: "labels-water",
    group: "water",
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
    group: "water",
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
    id: "labels-aerodrome",
    group: "airports",
    sourceLayer: "aerodrome_label",
    type: "symbol",
    minzoom: OSM_ZOOM.aerowaysMin,
    filter: ["any", ["has", "iata"], ["==", ["get", "class"], "international"]],
    style: ({ layers }) =>
      labelStyle(darken(layers.airports.color, 0.45), {
        textField: [
          "coalesce",
          ["get", "iata"],
          ["get", "name"],
          ["get", "name:latin"],
          ["get", "name_en"],
        ],
        padding: 2,
        size: ["interpolate", ["linear"], ["zoom"], 10, 10, 14, 13],
      }),
  },
  {
    id: "labels-highway-refs",
    group: "streetNames",
    sourceLayer: "transportation_name",
    type: "symbol",
    minzoom: OSM_ZOOM.labelsHighwayRefsMin,
    filter: [
      "all",
      ["has", "ref"],
      ["match", ["get", "class"], ["motorway", "trunk", "primary"], true, false],
      ["!=", ["get", "subclass"], "junction"],
    ],
    style: ({ layers }) =>
      labelStyle(layers.streetNames.color, {
        // Point at low zoom (short shield segments); along the road from z11.
        placement: ["step", ["zoom"], "point", 11, "line"],
        textField: ["to-string", ["get", "ref"]],
        padding: 2,
        size: ["interpolate", ["linear"], ["zoom"], 8, 9, 14, 11],
      }),
  },
  {
    id: "labels-streets",
    group: "streetNames",
    sourceLayer: "transportation_name",
    type: "symbol",
    minzoom: OSM_ZOOM.labelsStreetsMin,
    // Named road lines only — skip motorway exits (crowd labels) and bare refs
    // (shown via labels-highway-refs). Local street names densify from z12 in OMT.
    filter: [
      "all",
      ["!=", ["get", "subclass"], "junction"],
      ["has", "name"],
      ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
    ],
    style: ({ layers }) =>
      labelStyle(layers.streetNames.color, {
        placement: "line",
        size: ["interpolate", ["linear"], ["zoom"], 11, 9, 18, 12],
      }),
  },
  // Place labels last (above roads), matching OpenFreeMap Liberty — top symbol
  // layers win collision placement, so suburbs must not sit under highway labels.
  {
    id: "labels-place-village",
    group: "streetNames",
    sourceLayer: "place",
    type: "symbol",
    minzoom: OSM_ZOOM.labelsVillagesMin,
    filter: ["==", ["get", "class"], "village"],
    style: ({ layers }) =>
      labelStyle(layers.streetNames.color, {
        textField: PLACE_NAME_FIELD,
        padding: 1.5,
        size: ["interpolate", ["linear"], ["zoom"], 9, 10, 12, 12],
      }),
  },
  {
    id: "labels-place-suburb",
    group: "streetNames",
    sourceLayer: "place",
    type: "symbol",
    minzoom: OSM_ZOOM.labelsSuburbsMin,
    filter: [
      "match",
      ["get", "class"],
      "suburb",
      true,
      "neighbourhood",
      true,
      "quarter",
      true,
      false,
    ],
    style: ({ layers }) =>
      labelStyle(layers.streetNames.color, {
        textField: PLACE_NAME_FIELD,
        padding: 2,
        // Smaller than city/town; collision on so z11 districts don’t pile up.
        size: ["interpolate", ["linear"], ["zoom"], 11, 9, 14, 11],
      }),
  },
  {
    // Leaflet z11 → MapLibre z10 tiles omit suburbs; FE injects z11 place points.
    id: "labels-place-suburb-overzoom",
    group: "streetNames",
    source: PLACE_OVERZOOM_SOURCE,
    type: "symbol",
    minzoom: 10,
    maxzoom: 11,
    style: ({ layers }) =>
      labelStyle(layers.streetNames.color, {
        textField: ["get", "name"],
        padding: 2,
        size: 9,
      }),
  },
  {
    id: "labels-place-town",
    group: "streetNames",
    sourceLayer: "place",
    type: "symbol",
    minzoom: OSM_ZOOM.labelsTownsMin,
    filter: ["==", ["get", "class"], "town"],
    style: ({ layers }) =>
      labelStyle(layers.streetNames.color, {
        textField: PLACE_NAME_FIELD,
        padding: 2,
        size: ["interpolate", ["exponential", 1.2], ["zoom"], 7, 11, 11, 13],
      }),
  },
  {
    id: "labels-place-city",
    group: "streetNames",
    sourceLayer: "place",
    type: "symbol",
    minzoom: OSM_ZOOM.labelsPlacesMin,
    filter: ["==", ["get", "class"], "city"],
    style: ({ layers }) =>
      labelStyle(layers.streetNames.color, {
        textField: PLACE_NAME_FIELD,
        padding: 2,
        size: ["interpolate", ["exponential", 1.2], ["zoom"], 4, 11, 7, 13, 11, 16],
      }),
  },
];

export function layerZoomHint(key: MapLayerKey): string | null {
  switch (key) {
    case "buildings":
      return `Built-up areas from z${OSM_ZOOM.builtUpMin}; building footprints from z${OSM_ZOOM.buildingsMin}`;
    case "streetNames":
      return `Cities z${OSM_ZOOM.labelsPlacesMin}+; suburbs from z11; road names z${OSM_ZOOM.labelsStreetsMin}+ (local streets denser from z12)`;
    case "airports":
      return `Runways / taxiways / IATA labels from z${OSM_ZOOM.aerowaysMin}`;
    case "water":
      return `Bodies/labels from z${OSM_ZOOM.labelsWaterMin}; off → seas use Empty fill color`;
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
    layer.source = def.source ?? VECTOR_SOURCE;
    if (def.sourceLayer) layer["source-layer"] = def.sourceLayer;
  }
  if (def.minzoom != null) layer.minzoom = def.minzoom;
  if (def.maxzoom != null) layer.maxzoom = def.maxzoom;
  if (def.filter != null) layer.filter = def.filter;

  // Water fill/line stay visible when "off" (recolored to Empty fill in style()).
  // Water labels and all other groups toggle visibility normally.
  const isWaterGeom =
    def.group === "water" && (def.type === "fill" || def.type === "line");
  const visible =
    def.group == null || isWaterGeom || ctx.layers[def.group].enabled;

  // Always set visibility explicitly — MapLibre setStyle({diff:true}) does not
  // clear a previous visibility:none when the property is omitted.
  const nextLayout: Record<string, unknown> = {
    ...(layout ?? {}),
    visibility: visible ? "visible" : "none",
  };
  layer.layout = nextLayout;
  if (paint) layer.paint = paint;

  return layer;
}

export function buildRenderPalette(input?: Partial<MapLayerStyle>): RenderPalette {
  const layers = normalizeMapLayers(input);
  const baseFill = getBaseFillColor(layers);
  const landColor = getLandFillColor(layers);
  const forestColor = layers.landForest.color;

  return {
    /** @deprecated Prefer baseFill — kept as alias for stripe empty-space color. */
    background: baseFill,
    /** Empty stripe / projection fill (Empty fill select). */
    baseFill,
    /** Which layer color is used for empty fill. */
    baseFillLayer: getBaseFillLayer(layers),
    /** Shore / terrestrial land mass (Base land fill select). */
    land: landColor,
    /** Which layer color is used for land fill. */
    landFillLayer: getLandFillLayer(layers),
    landForest: darken(forestColor, 0.12),
    landPark: darken(forestColor, 0.08),
    snow: layers.snow.color,
    sand: layers.sand.color,
    rock: layers.rock.color,
    wetland: layers.wetland.color,
    water: layers.water.color,
    streets: layers.streets.color,
    streetCasing: darken(layers.streets.color, 0.2),
    airports: layers.airports.color,
    airportRunway: lighten(layers.airports.color, 0.12),
    rail: layers.rail.color,
    buildings: layers.buildings.color,
    buildingOutline: darken(layers.buildings.color, 0.25),
    builtUp: lighten(layers.buildings.color, 0.15),
    labels: layers.streetNames.color,
    opacity: {
      landGrass: 0.75,
      landForest: 0.85,
      landPark: 0.8,
      snow: 0.95,
      sand: 0.9,
      rock: 0.9,
      wetland: 0.85,
      builtUp: 0.55,
      airports: 0.75,
    },
    enabled: {
      landForest: layers.landForest.enabled,
      water: layers.water.enabled,
      snow: layers.snow.enabled,
      sand: layers.sand.enabled,
      rock: layers.rock.enabled,
      wetland: layers.wetland.enabled,
      streets: layers.streets.enabled,
      airports: layers.airports.enabled,
      rail: layers.rail.enabled,
      buildings: layers.buildings.enabled,
      labels: layers.streetNames.enabled,
    },
  };
}

export interface RenderPalette {
  background: string;
  baseFill: string;
  baseFillLayer: MapLayerKey;
  land: string;
  landFillLayer: MapLayerKey;
  landForest: string;
  landPark: string;
  snow: string;
  sand: string;
  rock: string;
  wetland: string;
  water: string;
  streets: string;
  streetCasing: string;
  airports: string;
  airportRunway: string;
  rail: string;
  buildings: string;
  buildingOutline: string;
  builtUp: string;
  labels: string;
  opacity: {
    landGrass: number;
    landForest: number;
    landPark: number;
    snow: number;
    sand: number;
    rock: number;
    wetland: number;
    builtUp: number;
    airports: number;
  };
  enabled: {
    landForest: boolean;
    water: boolean;
    snow: boolean;
    sand: boolean;
    rock: boolean;
    wetland: boolean;
    streets: boolean;
    airports: boolean;
    rail: boolean;
    buildings: boolean;
    labels: boolean;
  };
}

export function buildMapStyle(input?: Partial<MapLayerStyle>): Record<string, unknown> {
  const layers = normalizeMapLayers(input);
  const ctx: StyleBuildContext = { layers };

  const styleLayers = OSM_STYLE_LAYERS.map((def) => emitStyleLayer(def, ctx));

  return {
    version: 8,
    sources: {
      [VECTOR_SOURCE]: {
        type: "vector",
        url: VECTOR_TILES_URL,
      },
      [PLACE_OVERZOOM_SOURCE]: {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
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

  const record = input as Partial<MapLayerStyle> &
    Partial<Record<MapLayerKey, Partial<MapLayerSettings>>>;
  const result = createDefaultMapLayers();

  const legacyWaterBase =
    !isMapLayerKey(record.baseFill) &&
    record.water?.enabled === true &&
    record.landForest?.enabled === false;

  if (isMapLayerKey(record.baseFill)) {
    result.baseFill = record.baseFill;
  } else if (legacyWaterBase) {
    // Legacy XOR: water checkbox meant water empty fill (both layers drawn).
    result.baseFill = "water";
  }

  if (isMapLayerKey(record.landFill)) {
    result.landFill = record.landFill;
  }

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

  if (legacyWaterBase) {
    result.landForest = { ...result.landForest, enabled: true };
    result.water = { ...result.water, enabled: true };
  }

  return ensureBaseFill(result);
}
