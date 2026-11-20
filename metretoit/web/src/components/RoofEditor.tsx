import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "./maplibreSetup";
import type { LonLat } from "../../../shared/geo";
import { type RoofModel, type RoofMetrics, EDGE_COLOR, ELEMENT_TYPES, vertexKey, computeMetrics } from "../../../shared/roof";
import { moveVertex, insertVertex, uniqueVertices, updateElement } from "../../../shared/edit";
import { baseStyle, FACE_COLORS } from "./mapStyle";
import { attachGoogleUnderlay, type GoogleUnderlay } from "./googleUnderlay";

export type Basemap = "ortho" | "plan" | "google";
export type Tool = "select" | "draw" | "insert" | "split" | "element";
export type Selection =
  | { kind: "face"; id: string }
  | { kind: "edge"; key: string }
  | { kind: "vertex"; ll: LonLat }
  | { kind: "element"; id: string }
  | null;

interface Props {
  model: RoofModel;
  metrics: RoofMetrics;
  selection: Selection;
  onSelect: (s: Selection) => void;
  tool: Tool;
  onModel: (m: RoofModel) => void;
  onAddFace: (ring: LonLat[]) => void;
  onSplit: (a: LonLat, b: LonLat) => void;
  onAddElement: (ll: LonLat) => void;
  /** façades à afficher (onglet Façades) */
  facades?: { key: string; index: number; segments: [LonLat, LonLat][]; excluded: boolean; mid: LonLat }[] | null;
  hlFacade?: string | null;
  showLabels: boolean;
  highlightType: string | null;
  basemap: Basemap;
  /** clé Google « navigateur » : photo satellite via Maps JavaScript (sinon tuiles relayées par le serveur) */
  googleJsKey?: string | null;
  fitKey: string;
}

const SNAP_PX = 12;
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export function RoofEditor(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const gHost = useRef<HTMLDivElement>(null);
  const [gActive, setGActive] = useState(false);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const props = useRef(p);
  props.current = p;
  const [ready, setReady] = useState(false);
  const draft = useRef<LonLat[]>([]);
  const splitA = useRef<LonLat | null>(null);
  const drag = useRef<{ from: LonLat; to: LonLat } | null>(null);
  const eltDrag = useRef<{ id: string; start: LonLat; center: LonLat; to: LonLat } | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const [hint, setHint] = useState("");

  // ---------- initialisation ----------
  useEffect(() => {
    const m = new maplibregl.Map({
      container: el.current!,
      style: baseStyle(),
      center: p.model.origin as [number, number],
      zoom: 19.5,
      maxZoom: 22.5,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    m.on("load", () => {
      const add = (id: string) => m.addSource(id, { type: "geojson", data: EMPTY });
      ["faces", "edges", "verts", "draft", "foot", "elts", "facs"].forEach(add);
      m.addLayer({ id: "foot", type: "line", source: "foot", paint: { "line-color": "#facc15", "line-width": 1.2, "line-dasharray": [3, 2] } });
      m.addLayer({
        id: "faces-fill",
        type: "fill",
        source: "faces",
        paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["get", "sel"], 0.45, 0.18] },
      });
      m.addLayer({
        id: "edges-casing",
        type: "line",
        source: "edges",
        layout: { "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": ["case", ["get", "sel"], 10, 6], "line-opacity": ["*", 0.85, ["get", "op"]] },
      });
      m.addLayer({
        id: "edges",
        type: "line",
        source: "edges",
        layout: { "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["case", ["get", "sel"], 7, 3.5],
          "line-opacity": ["get", "op"],
        },
      });
      m.addLayer({ id: "edges-hit", type: "line", source: "edges", paint: { "line-color": "#000", "line-width": 16, "line-opacity": 0.001 } });
      m.addLayer({
        id: "facs",
        type: "line",
        source: "facs",
        layout: { "line-cap": "round" },
        paint: {
          "line-color": ["case", ["get", "off"], "#9ca3af", "#ea580c"],
          "line-width": ["case", ["get", "hl"], 9, 5],
          "line-opacity": 0.95,
        },
      });
      m.addLayer({
        id: "elts-fill",
        type: "fill",
        source: "elts",
        paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["get", "sel"], 0.85, 0.6] },
      });
      m.addLayer({
        id: "elts-line",
        type: "line",
        source: "elts",
        paint: { "line-color": ["case", ["get", "auto"], "#fde047", "#ffffff"], "line-width": ["case", ["get", "sel"], 3, 1.8] },
      });
      m.addLayer({
        id: "verts",
        type: "circle",
        source: "verts",
        paint: {
          "circle-radius": ["case", ["get", "sel"], 7, 5],
          "circle-color": ["case", ["get", "sel"], "#f59e0b", "#ffffff"],
          "circle-stroke-color": "#1f2937",
          "circle-stroke-width": 1.5,
        },
      });
      m.addLayer({ id: "draft-line", type: "line", source: "draft", filter: ["==", "$type", "LineString"], paint: { "line-color": "#22d3ee", "line-width": 3, "line-dasharray": [2, 1] } });
      m.addLayer({ id: "draft-pts", type: "circle", source: "draft", filter: ["==", "$type", "Point"], paint: { "circle-radius": 5, "circle-color": "#22d3ee", "circle-stroke-color": "#083344", "circle-stroke-width": 1.5 } });
      setReady(true);
    });
    mapRef.current = m;
    return () => {
      markers.current.forEach((mk) => mk.remove());
      m.remove();
    };
  }, []);

  // ---------- recadrage ----------
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready) return;
    const pts = [...props.current.model.faces.flatMap((f) => f.ring), ...(props.current.model.footprint ?? [])];
    if (!pts.length) {
      m.jumpTo({ center: props.current.model.origin as [number, number], zoom: 19.5 });
      return;
    }
    const b = new maplibregl.LngLatBounds(pts[0] as [number, number], pts[0] as [number, number]);
    pts.forEach((q) => b.extend(q as [number, number]));
    m.fitBounds(b, { padding: 60, maxZoom: 21, duration: 0 });
  }, [ready, p.fitKey]);

  // ---------- fond de carte ----------
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready) return;
    m.setLayoutProperty("ortho", "visibility", p.basemap === "ortho" ? "visible" : "none");
    m.setLayoutProperty("plan", "visibility", p.basemap === "plan" ? "visible" : "none");
    const jsMode = p.basemap === "google" && !!p.googleJsKey;
    m.setLayoutProperty("gsat", "visibility", p.basemap === "google" && !jsMode ? "visible" : "none");
    if (!jsMode) {
      m.setMaxZoom(22.5);
      setGActive(false);
      return;
    }
    // photo satellite Google sous la carte (Maps JavaScript)
    let under: GoogleUnderlay | null = null;
    let cancelled = false;
    attachGoogleUnderlay(m, gHost.current!, p.googleJsKey!, (z) => !cancelled && m.setMaxZoom(z)).then((u) => {
      if (cancelled) return u?.destroy();
      under = u;
      if (u) setGActive(true);
      else {
        // Google indisponible : on revient sur la photo IGN
        m.setLayoutProperty("ortho", "visibility", "visible");
        m.setMaxZoom(22.5);
      }
    });
    return () => {
      cancelled = true;
      under?.destroy();
      setGActive(false);
    };
  }, [ready, p.basemap, p.googleJsKey]);

  // ---------- rendu ----------
  const render = (model: RoofModel, metrics: RoofMetrics | null) => {
    const m = mapRef.current;
    if (!m || !m.getSource("faces")) return;
    const { selection, highlightType, tool } = props.current;
    const met = metrics ?? props.current.metrics;
    const src = (id: string) => m.getSource(id) as maplibregl.GeoJSONSource;
    src("faces").setData({
      type: "FeatureCollection",
      features: model.faces.map((f, i) => ({
        type: "Feature",
        properties: { id: f.id, color: FACE_COLORS[i % FACE_COLORS.length], sel: selection?.kind === "face" && selection.id === f.id },
        geometry: { type: "Polygon", coordinates: [[...f.ring, f.ring[0]]] },
      })),
    });
    src("edges").setData({
      type: "FeatureCollection",
      features: met.edges.map((e) => ({
        type: "Feature",
        properties: {
          key: e.key,
          color: EDGE_COLOR[e.type],
          sel: selection?.kind === "edge" && selection.key === e.key,
          op: highlightType && highlightType !== e.type ? 0.25 : 1,
        },
        geometry: { type: "LineString", coordinates: [e.a, e.b] },
      })),
    });
    const showVerts = tool !== "draw" || true;
    src("verts").setData({
      type: "FeatureCollection",
      features: showVerts
        ? uniqueVertices(model).map((v) => ({
            type: "Feature",
            properties: {
              key: vertexKey(v),
              sel:
                (selection?.kind === "vertex" && vertexKey(selection.ll) === vertexKey(v)) ||
                (!!splitA.current && vertexKey(splitA.current) === vertexKey(v)),
            },
            geometry: { type: "Point", coordinates: v },
          }))
        : [],
    });
    const ecol = Object.fromEntries(ELEMENT_TYPES.map((e) => [e.type, e.color]));
    src("elts").setData({
      type: "FeatureCollection",
      features: (metrics ? met : computeMetrics(model)).elements.map((el) => ({
        type: "Feature",
        properties: {
          id: el.id,
          color: ecol[el.type],
          sel: selection?.kind === "element" && selection.id === el.id,
          auto: !!model.elements?.find((x) => x.id === el.id)?.auto,
        },
        geometry: { type: "Polygon", coordinates: [[...el.ring, el.ring[0]]] },
      })),
    });
    const fl = props.current.facades;
    src("facs").setData({
      type: "FeatureCollection",
      features: (fl ?? []).flatMap((f) =>
        f.segments.map((sg) => ({
          type: "Feature" as const,
          properties: { off: f.excluded, hl: props.current.hlFacade === f.key },
          geometry: { type: "LineString" as const, coordinates: sg },
        })),
      ),
    });
    src("foot").setData(
      model.footprint
        ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [...model.footprint, model.footprint[0]] } }
        : EMPTY,
    );
    renderDraft();
  };

  const renderDraft = (cursor?: LonLat) => {
    const m = mapRef.current;
    if (!m || !m.getSource("draft")) return;
    const d = draft.current;
    const line = cursor && d.length ? [...d, cursor] : d;
    (m.getSource("draft") as maplibregl.GeoJSONSource).setData({
      type: "FeatureCollection",
      features: [
        ...(line.length >= 2 ? [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: line } }] : []),
        ...d.map((q) => ({ type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: q } })),
      ],
    });
  };

  const renderLabels = () => {
    const m = mapRef.current;
    markers.current.forEach((mk) => mk.remove());
    markers.current = [];
    if (!m || !props.current.showLabels) return;
    const { metrics, model } = props.current;
    for (const e of props.current.facades ? [] : metrics.edges) {
      if (e.length < 0.5) continue;
      const div = document.createElement("div");
      div.className = "edge-label";
      div.style.borderColor = EDGE_COLOR[e.type];
      div.textContent = e.length.toLocaleString("fr-FR", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
      markers.current.push(new maplibregl.Marker({ element: div }).setLngLat([(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]).addTo(m));
    }
    for (const f of props.current.facades ?? []) {
      const div = document.createElement("div");
      div.className = `fac-label ${f.excluded ? "off" : ""}`;
      div.textContent = `F${f.index}`;
      markers.current.push(new maplibregl.Marker({ element: div }).setLngLat(f.mid as [number, number]).addTo(m));
    }
    if (props.current.facades) return; // en mode façades, on n'affiche pas les étiquettes des pans
    metrics.faces.forEach((f, i) => {
      const div = document.createElement("div");
      div.className = "face-label";
      div.style.background = FACE_COLORS[i % FACE_COLORS.length];
      div.innerHTML = `<b>${f.index}</b> ${f.area.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} m² · ${Math.round(f.pitchDeg)}°`;
      markers.current.push(new maplibregl.Marker({ element: div }).setLngLat(f.centroid as [number, number]).addTo(m));
    });
    void model;
  };

  useEffect(() => {
    if (!ready) return;
    render(p.model, p.metrics);
    renderLabels();
  }, [ready, p.model, p.metrics, p.selection, p.highlightType, p.showLabels, p.tool, p.facades, p.hlFacade]);

  // changement d'outil : on vide les tracés en cours
  useEffect(() => {
    draft.current = [];
    splitA.current = null;
    renderDraft();
    const m = mapRef.current;
    if (m) {
      if (p.tool === "draw") m.doubleClickZoom.disable();
      else m.doubleClickZoom.enable();
      m.getCanvas().style.cursor = p.tool === "select" ? "" : "crosshair";
    }
    setHint(
      p.tool === "draw"
        ? "Cliquez les angles du pan ; cliquez le 1er point ou double-cliquez pour terminer. Échap : annuler, Retour arrière : effacer le dernier point."
        : p.tool === "insert"
          ? "Cliquez sur une arête pour y ajouter un sommet."
          : p.tool === "split"
            ? "Cliquez deux sommets d'un même pan pour le découper."
            : p.tool === "element"
              ? "Cliquez sur le toit pour placer l'élément. Ses dimensions se règlent ensuite dans le panneau."
            : "Cliquez un pan, une arête ou un sommet. Glissez un sommet pour le déplacer.",
    );
  }, [p.tool]);

  // ---------- accrochage ----------
  const snap = (pt: maplibregl.Point, exclude?: string): { ll: LonLat; kind: "vertex" | "edge" | "free"; edge?: [LonLat, LonLat] } => {
    const m = mapRef.current!;
    const { model, metrics } = props.current;
    let best: LonLat | null = null;
    let bd = SNAP_PX;
    const cands = [...uniqueVertices(model), ...(model.footprint ?? []), ...draft.current];
    for (const v of cands) {
      if (exclude && vertexKey(v) === exclude) continue;
      const q = m.project(v as [number, number]);
      const d = Math.hypot(q.x - pt.x, q.y - pt.y);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    if (best) return { ll: best, kind: "vertex" };
    let be: { ll: LonLat; edge: [LonLat, LonLat] } | null = null;
    bd = SNAP_PX - 2;
    for (const e of metrics.edges) {
      if (exclude && (vertexKey(e.a) === exclude || vertexKey(e.b) === exclude)) continue;
      const a = m.project(e.a as [number, number]);
      const b = m.project(e.b as [number, number]);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      if (l2 < 1) continue;
      const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2));
      const d = Math.hypot(a.x + t * dx - pt.x, a.y + t * dy - pt.y);
      if (d < bd && t > 0.02 && t < 0.98) {
        bd = d;
        be = { ll: [e.a[0] + t * (e.b[0] - e.a[0]), e.a[1] + t * (e.b[1] - e.a[1])], edge: [e.a, e.b] };
      }
    }
    if (be) return { ll: be.ll, kind: "edge", edge: be.edge };
    const ll = m.unproject(pt);
    return { ll: [ll.lng, ll.lat], kind: "free" };
  };

  // ---------- interactions ----------
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready) return;

    const finishDraft = () => {
      const d = draft.current;
      if (d.length >= 3) props.current.onAddFace(d.slice());
      draft.current = [];
      renderDraft();
    };

    const onClick = (e: maplibregl.MapMouseEvent) => {
      const { tool, onSelect, onModel, model } = props.current;
      if (drag.current || eltDrag.current) return;
      if (tool === "draw") {
        const s = snap(e.point);
        const d = draft.current;
        if (d.length >= 3) {
          const first = m.project(d[0] as [number, number]);
          if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < SNAP_PX) return finishDraft();
        }
        if (d.length && vertexKey(d[d.length - 1]) === vertexKey(s.ll)) return;
        d.push(s.ll);
        renderDraft();
        return;
      }
      const vf = m.queryRenderedFeatures(
        [
          [e.point.x - 6, e.point.y - 6],
          [e.point.x + 6, e.point.y + 6],
        ],
        { layers: ["verts"] },
      )[0];
      if (tool === "split") {
        if (!vf) return;
        const ll = (vf.geometry as GeoJSON.Point).coordinates as LonLat;
        if (!splitA.current) {
          splitA.current = ll;
          render(model, null);
        } else {
          const a = splitA.current;
          splitA.current = null;
          props.current.onSplit(a, ll);
        }
        return;
      }
      if (tool === "element") {
        props.current.onAddElement([e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      if (tool === "insert") {
        const s = snap(e.point);
        if (s.kind === "edge" && s.edge) onModel(insertVertex(model, s.edge[0], s.edge[1], s.ll));
        return;
      }
      // sélection
      if (vf) return onSelect({ kind: "vertex", ll: (vf.geometry as GeoJSON.Point).coordinates as LonLat });
      const elf = m.queryRenderedFeatures(e.point, { layers: ["elts-fill"] })[0];
      if (elf) return onSelect({ kind: "element", id: elf.properties!.id });
      const ef = m.queryRenderedFeatures(e.point, { layers: ["edges-hit"] })[0];
      if (ef) return onSelect({ kind: "edge", key: ef.properties!.key });
      const ff = m.queryRenderedFeatures(e.point, { layers: ["faces-fill"] })[0];
      if (ff) return onSelect({ kind: "face", id: ff.properties!.id });
      onSelect(null);
    };

    const onDbl = (e: maplibregl.MapMouseEvent) => {
      if (props.current.tool === "draw") {
        e.preventDefault();
        finishDraft();
      }
    };

    const onMove = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      const { tool, model } = props.current;
      if (eltDrag.current) {
        const d = eltDrag.current;
        const ll: LonLat = [e.lngLat.lng, e.lngLat.lat];
        d.to = [d.center[0] + ll[0] - d.start[0], d.center[1] + ll[1] - d.start[1]];
        render(updateElement(model, d.id, { center: d.to }), null);
        return;
      }
      if (drag.current) {
        const s = snap(e.point, vertexKey(drag.current.from));
        drag.current.to = s.ll;
        render(moveVertex(model, drag.current.from, s.ll), null);
        return;
      }
      if (tool === "draw" && draft.current.length) renderDraft(snap(e.point).ll);
      if (tool === "select") {
        const over = m.queryRenderedFeatures(e.point, { layers: ["verts", "elts-fill"] }).length > 0;
        m.getCanvas().style.cursor = over ? "move" : "";
      }
    };

    const startDrag = (e: maplibregl.MapLayerMouseEvent | maplibregl.MapLayerTouchEvent) => {
      if (props.current.tool !== "select") return;
      const f = e.features?.[0];
      if (!f) return;
      if ("touches" in e.originalEvent && (e.originalEvent as TouchEvent).touches.length > 1) return;
      e.preventDefault();
      const ll = (f.geometry as GeoJSON.Point).coordinates as LonLat;
      drag.current = { from: ll, to: ll };
      m.dragPan.disable();
    };
    const startEltDrag = (e: maplibregl.MapLayerMouseEvent | maplibregl.MapLayerTouchEvent) => {
      if (props.current.tool !== "select" || drag.current) return;
      if (m.queryRenderedFeatures(e.point, { layers: ["verts"] }).length) return; // un sommet a la priorité
      const f = e.features?.[0];
      if (!f) return;
      if ("touches" in e.originalEvent && (e.originalEvent as TouchEvent).touches.length > 1) return;
      const el = props.current.model.elements?.find((x) => x.id === f.properties!.id);
      if (!el) return;
      e.preventDefault();
      const ll: LonLat = [e.lngLat.lng, e.lngLat.lat];
      eltDrag.current = { id: el.id, start: ll, center: el.center, to: el.center };
      m.dragPan.disable();
    };
    const endDrag = () => {
      const ed = eltDrag.current;
      if (ed) {
        m.dragPan.enable();
        setTimeout(() => (eltDrag.current = null), 0);
        if (ed.to[0] !== ed.center[0] || ed.to[1] !== ed.center[1]) props.current.onModel(updateElement(props.current.model, ed.id, { center: ed.to }));
        props.current.onSelect({ kind: "element", id: ed.id });
        return;
      }
      const d = drag.current;
      if (!d) return;
      m.dragPan.enable();
      const moved = vertexKey(d.from) !== vertexKey(d.to);
      // on laisse passer l'événement click qui suit avant de libérer
      setTimeout(() => (drag.current = null), 0);
      if (moved) {
        props.current.onModel(moveVertex(props.current.model, d.from, d.to));
        props.current.onSelect({ kind: "vertex", ll: d.to });
      } else {
        props.current.onSelect({ kind: "vertex", ll: d.from });
      }
    };

    const onKey = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.closest?.("input,textarea,select")) return;
      if (props.current.tool === "draw") {
        if (ev.key === "Escape") {
          draft.current = [];
          renderDraft();
        } else if (ev.key === "Backspace") {
          draft.current.pop();
          renderDraft();
          ev.preventDefault();
        } else if (ev.key === "Enter") finishDraft();
      }
      if (props.current.tool === "split" && ev.key === "Escape") {
        splitA.current = null;
        render(props.current.model, null);
      }
    };

    m.on("click", onClick);
    m.on("dblclick", onDbl);
    m.on("mousemove", onMove);
    m.on("touchmove", onMove);
    m.on("mousedown", "verts", startDrag);
    m.on("touchstart", "verts", startDrag);
    m.on("mousedown", "elts-fill", startEltDrag);
    m.on("touchstart", "elts-fill", startEltDrag);
    m.on("mouseup", endDrag);
    m.on("touchend", endDrag);
    window.addEventListener("keydown", onKey);
    return () => {
      m.off("click", onClick);
      m.off("dblclick", onDbl);
      m.off("mousemove", onMove);
      m.off("touchmove", onMove);
      m.off("mousedown", "verts", startDrag);
      m.off("touchstart", "verts", startDrag);
      m.off("mousedown", "elts-fill", startEltDrag);
      m.off("touchstart", "elts-fill", startEltDrag);
      m.off("mouseup", endDrag);
      m.off("touchend", endDrag);
      window.removeEventListener("keydown", onKey);
    };
  }, [ready]);

  return (
    <div className={`map-wrap ${gActive ? "is-google" : ""}`}>
      <div ref={gHost} className="map gmap-under" aria-hidden="true" />
      <div ref={el} className="map" data-testid="editor-map" />
      {hint && <div className="map-hint">{hint}</div>}
      {p.tool === "draw" && (
        <div className="map-actions">
          <button className="btn btn-sm" onClick={() => { draft.current.pop(); renderDraft(); }}>
            Effacer le dernier point
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              const d = draft.current;
              if (d.length >= 3) props.current.onAddFace(d.slice());
              draft.current = [];
              renderDraft();
            }}
          >
            Terminer le pan
          </button>
        </div>
      )}
    </div>
  );
}
