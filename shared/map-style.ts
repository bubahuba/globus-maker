export type MapLayerKey = "water" | "streets" | "streetNames" | "buildings" | "landForest";

export interface MapLayerSettings {
  enabled: boolean;
  color: string;
}

export type MapLayerStyle = Record<MapLayerKey, MapLayerSettings>;

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

const LABEL_TEXT_FIELD = ["coalesce", ["get", "name"], ["get", "name:latin"], ["get", "name_en"], ""];

function labelLayer(
  id: string,
  sourceLayer: string,
  color: string,
  options?: {
    minzoom?: number;
    filter?: unknown;
    placement?: "point" | "line";
    size?: unknown;
  },
): Record<string, unknown> {
  return {
    id,
    type: "symbol",
    source: VECTOR_SOURCE,
    "source-layer": sourceLayer,
    minzoom: options?.minzoom ?? 4,
    ...(options?.filter ? { filter: options.filter } : {}),
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

export const DEFAULT_MAP_LAYERS: MapLayerStyle = {
  landForest: { enabled: true, color: "#e8eddb" },
  water: { enabled: true, color: "#9ebfff" },
  streets: { enabled: true, color: "#ffffff" },
  buildings: { enabled: true, color: "#d9d5d0" },
  streetNames: { enabled: true, color: "#555555" },
};

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

function normalizeMapLayers(input?: Partial<MapLayerStyle>): MapLayerStyle {
  const layers = { ...DEFAULT_MAP_LAYERS };
  if (!input) return layers;

  for (const key of MAP_LAYER_KEYS) {
    const value = input[key];
    if (!value) continue;
    layers[key] = {
      enabled: value.enabled ?? layers[key].enabled,
      color: value.color ?? layers[key].color,
    };
  }
  return layers;
}

export function buildRenderPalette(input?: Partial<MapLayerStyle>): RenderPalette {
  const layers = normalizeMapLayers(input);
  const land = layers.landForest.enabled ? layers.landForest.color : "#ffffff";

  return {
    background: land,
    land: land,
    landForest: darken(layers.landForest.color, 0.12),
    landPark: darken(layers.landForest.color, 0.08),
    water: layers.water.color,
    streets: layers.streets.color,
    streetCasing: darken(layers.streets.color, 0.2),
    buildings: layers.buildings.color,
    buildingOutline: darken(layers.buildings.color, 0.25),
    labels: layers.streetNames.color,
    opacity: {
      landGrass: 0.75,
      landForest: 0.85,
      landPark: 0.8,
    },
    enabled: {
      landForest: layers.landForest.enabled,
      water: layers.water.enabled,
      streets: layers.streets.enabled,
      buildings: layers.buildings.enabled,
      labels: layers.streetNames.enabled,
    },
  };
}

export interface RenderPalette {
  background: string;
  land: string;
  landForest: string;
  landPark: string;
  water: string;
  streets: string;
  streetCasing: string;
  buildings: string;
  buildingOutline: string;
  labels: string;
  opacity: {
    landGrass: number;
    landForest: number;
    landPark: number;
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
  const styleLayers: Record<string, unknown>[] = [
    {
      id: "background",
      type: "background",
      paint: {
        "background-color": layers.landForest.enabled ? layers.landForest.color : "#ffffff",
      },
    },
  ];

  if (layers.landForest.enabled) {
    styleLayers.push(
      {
        id: "landcover-wood",
        type: "fill",
        source: VECTOR_SOURCE,
        "source-layer": "landcover",
        filter: ["in", ["get", "class"], ["literal", ["wood", "forest"]]],
        paint: {
          "fill-color": darken(layers.landForest.color, 0.12),
          "fill-opacity": 0.85,
        },
      },
      {
        id: "landcover-grass",
        type: "fill",
        source: VECTOR_SOURCE,
        "source-layer": "landcover",
        filter: ["in", ["get", "class"], ["literal", ["grass", "meadow", "scrub"]]],
        paint: {
          "fill-color": layers.landForest.color,
          "fill-opacity": 0.75,
        },
      },
      {
        id: "park",
        type: "fill",
        source: VECTOR_SOURCE,
        "source-layer": "park",
        paint: {
          "fill-color": darken(layers.landForest.color, 0.08),
          "fill-opacity": 0.8,
        },
      },
    );
  }

  if (layers.water.enabled) {
    styleLayers.push(
      {
        id: "water",
        type: "fill",
        source: VECTOR_SOURCE,
        "source-layer": "water",
        paint: {
          "fill-color": layers.water.color,
        },
      },
      {
        id: "waterway",
        type: "line",
        source: VECTOR_SOURCE,
        "source-layer": "waterway",
        paint: {
          "line-color": layers.water.color,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 16, 3],
        },
      },
    );
  }

  if (layers.streets.enabled) {
    styleLayers.push(
      {
        id: "streets-casing",
        type: "line",
        source: VECTOR_SOURCE,
        "source-layer": "transportation",
        filter: [
          "all",
          ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
          [
            "match",
            ["get", "class"],
            ["path", "pedestrian", "rail", "transit", "aerialway", "ferry"],
            false,
            true,
          ],
        ],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": darken(layers.streets.color, 0.2),
          "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 10, 1, 16, 8],
        },
      },
      {
        id: "streets",
        type: "line",
        source: VECTOR_SOURCE,
        "source-layer": "transportation",
        filter: [
          "all",
          ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
          [
            "match",
            ["get", "class"],
            ["path", "pedestrian", "rail", "transit", "aerialway", "ferry"],
            false,
            true,
          ],
        ],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": layers.streets.color,
          "line-width": ["interpolate", ["exponential", 1.2], ["zoom"], 10, 0.5, 16, 6],
        },
      },
    );
  }

  // Country and state borders — always visible at every zoom level.
  styleLayers.push(
    {
      id: "boundaries-state",
      type: "line",
      source: VECTOR_SOURCE,
      "source-layer": "boundary",
      filter: [
        "all",
        ["==", ["get", "admin_level"], 4],
        ["!=", ["get", "maritime"], 1],
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#888888",
        "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.75, 6, 1, 14, 1.5],
      },
    },
    {
      id: "boundaries-country",
      type: "line",
      source: VECTOR_SOURCE,
      "source-layer": "boundary",
      filter: [
        "all",
        ["==", ["get", "admin_level"], 2],
        ["!=", ["get", "maritime"], 1],
        ["!=", ["get", "disputed"], 1],
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#555555",
        "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1, 6, 1.5, 14, 2.5],
      },
    },
    {
      id: "boundaries-country-disputed",
      type: "line",
      source: VECTOR_SOURCE,
      "source-layer": "boundary",
      filter: [
        "all",
        ["==", ["get", "admin_level"], 2],
        ["!=", ["get", "maritime"], 1],
        ["==", ["get", "disputed"], 1],
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#b05050",
        "line-dasharray": [2, 1.5],
        "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1, 6, 1.5, 14, 2.5],
      },
    },
  );

  if (layers.buildings.enabled) {
    styleLayers.push({
      id: "buildings",
      type: "fill",
      source: VECTOR_SOURCE,
      "source-layer": "building",
      minzoom: 13,
      paint: {
        "fill-color": layers.buildings.color,
        "fill-outline-color": darken(layers.buildings.color, 0.25),
      },
    });
  }

  if (layers.streetNames.enabled) {
    const labelColor = layers.streetNames.color;
    styleLayers.push(
      labelLayer("labels-places", "place", labelColor, {
        minzoom: 3,
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
      labelLayer("labels-water", "water_name", labelColor, {
        minzoom: 9,
        placement: "line",
        size: ["interpolate", ["linear"], ["zoom"], 9, 10, 14, 13],
      }),
      labelLayer("labels-waterway", "waterway", labelColor, {
        minzoom: 10,
        filter: ["has", "name"],
        placement: "line",
        size: ["interpolate", ["linear"], ["zoom"], 10, 9, 14, 12],
      }),
      labelLayer("labels-park", "park", labelColor, {
        minzoom: 11,
        filter: ["has", "name"],
        size: 10,
      }),
      labelLayer("labels-streets", "transportation_name", labelColor, {
        minzoom: 13,
        placement: "line",
        size: ["interpolate", ["linear"], ["zoom"], 13, 9, 18, 12],
      }),
    );
  }

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
    return { ...DEFAULT_MAP_LAYERS };
  }

  const record = input as Partial<Record<MapLayerKey, Partial<MapLayerSettings>>>;
  const result = { ...DEFAULT_MAP_LAYERS };

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

  return result;
}
