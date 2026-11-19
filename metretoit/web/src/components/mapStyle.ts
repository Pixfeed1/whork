import type { StyleSpecification } from "maplibre-gl";

const IGN = "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}";

export function baseStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      // photos Google relayées par notre serveur (clé jamais exposée)
      gsat: {
        type: "raster",
        tiles: [`${typeof location !== "undefined" ? location.origin : ""}/api/tiles/google/{z}/{x}/{y}`],
        tileSize: 256,
        maxzoom: 21,
        attribution: "Imagerie © Google",
      },
      ortho: {
        type: "raster",
        tiles: [`${IGN}&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg`],
        tileSize: 256,
        maxzoom: 19,
        attribution: "© IGN Géoplateforme",
      },
      plan: {
        type: "raster",
        tiles: [`${IGN}&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png`],
        tileSize: 256,
        maxzoom: 19,
        attribution: "© IGN Géoplateforme",
      },
    },
    layers: [
      { id: "plan", type: "raster", source: "plan", layout: { visibility: "none" } },
      { id: "ortho", type: "raster", source: "ortho" },
      { id: "gsat", type: "raster", source: "gsat", layout: { visibility: "none" } },
    ],
  };
}

export const FACE_COLORS = ["#f59e0b", "#3b82f6", "#10b981", "#ef4444", "#8b5cf6", "#f97316", "#06b6d4", "#ec4899", "#84cc16", "#64748b"];
