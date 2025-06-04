// src/components/TspMapbox.js
import React, { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import axios from "axios";

const MAPBOX_TOKEN = process.env.REACT_APP_MAPBOX_TOKEN;
const AMAP_TOKEN = process.env.REACT_APP_AMAP_KEY;
if (!MAPBOX_TOKEN) console.error("缺少 Mapbox 令牌: 设置 REACT_APP_MAPBOX_TOKEN");
if (!AMAP_TOKEN) console.error("缺少高德 API 密钥: 设置 REACT_APP_AMAP_KEY");

// GCJ-02转WGS-84（高德坐标转mapbox坐标）
function gcj02ToWgs84(lng, lat) {
  const PI = 3.14159265358979324;
  const a = 6378245.0;
  const ee = 0.00669342162296594323;

  function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320.0 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
  }

  function outOfChina(lng, lat) {
    return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271);
  }

  if (outOfChina(lng, lat)) return [lng, lat];

  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * PI);
  const mgLat = lat + dLat;
  const mgLng = lng + dLng;
  return [lng * 2 - mgLng, lat * 2 - mgLat];
}

// WGS-84转GCJ-02（mapbox点转高德API点）
function wgs84ToGcj02(lng, lat) {
  const PI = 3.14159265358979324;
  const a = 6378245.0;
  const ee = 0.00669342162296594323;

  function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320.0 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
  }

  function outOfChina(lng, lat) {
    return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271);
  }

  if (outOfChina(lng, lat)) return [lng, lat];

  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

function useDebounce(fn, delay) {
  const timeoutRef = useRef(null);
  return useCallback((...args) => {
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => fn(...args), delay);
  }, [fn, delay]);
}

class SearchControl {
  constructor(onSearch, onSelect, onOptimize, onClear) {
    this.onSearch = onSearch;
    this.onSelect = onSelect;
    this.onOptimize = onOptimize;
    this.onClear = onClear;
    this.container = document.createElement("div");
    this.container.className = "search-control m-4 flex items-center space-x-2 p-2 bg-gray-800 bg-opacity-0 rounded-md";
  }

  onAdd(map) {
    this.map = map;
    this.container.innerHTML = `
      <div class="relative w-96">
        <input id="search-input" type="text" placeholder="搜索地点" class="w-full p-2 rounded bg-gray-800 text-white border focus:outline-none" autocomplete="off" />
        <ul id="results" class="absolute z-20 w-full bg-gray-800 border rounded max-h-100 overflow-auto hidden"></ul>
      </div>
      <button id="optimize" class="px-3 py-1 text-base bg-blue-600 hover:bg-blue-700 text-white rounded">优化路径</button>
      <button id="clear" class="px-3 py-1 text-base bg-red-600 hover:bg-red-700 text-white rounded">清除节点</button>
    `;
    this.container.addEventListener("click", (e) => {
      const t = e.target;
      if (t.id === "optimize") return this.onOptimize();
      if (t.id === "clear") return this.onClear();
      if (t.tagName === "LI" && t.dataset.place) {
        this.onSelect(JSON.parse(t.dataset.place));
      }
    });
    this.container.querySelector("#search-input").addEventListener("input", (e) => this.onSearch(e.target.value));
    return this.container;
  }

  update(results) {
    const ul = this.container.querySelector("#results");
    if (results.length) {
      ul.innerHTML = results.map(r => `
        <li class="p-2 hover:bg-gray-600 text-white cursor-pointer" data-place='${JSON.stringify(r)}'>${r.place_name}</li>
      `).join("");
      ul.classList.remove("hidden");
    } else {
      ul.classList.add("hidden");
    }
  }

  clearInput() {
    const inp = this.container.querySelector("#search-input");
    if (inp) inp.value = "";
  }

  onRemove() {
    this.container.remove();
    this.map = null;
  }
}

export default function TspMapbox() {
  const mapRoot = useRef(null);
  const mapRef = useRef(null);
  const controlRef = useRef(null);

  const [loaded, setLoaded] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");

  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  const optimizePath = useCallback(async (pts) => {
    const { data } = await axios.post(
      "http://10.12.58.42:8000/optimize_path",
      { xy: pts, temperature: 1.0, sample: false },
      { timeout: 10000 }
    );
    return data.tour;
  }, []);

  const doSearch = useCallback(async (q) => {
    if (!q) return setResults([]);
    try {
      const { data } = await axios.get("https://restapi.amap.com/v3/assistant/inputtips", {
        params: { key: AMAP_TOKEN, keywords: q, datatype: "all" }
      });
      if (data.status !== "1") throw new Error(data.info);
      const list = data.tips.filter(t => t.location).map(t => {
        const [lng, lat] = t.location.split(",").map(Number);
        return { place_name: t.name + (t.district ? `(${t.district})` : ''), center: [lng, lat] };
      });
      setResults(list);
      setError(list.length ? "" : "未找到匹配地点，请尝试更准确的名称或地标");
    } catch (e) {
      setError("搜索失败: " + e.message);
    }
  }, []);
  const debouncedSearch = useDebounce(doSearch, 300);

  const onSelect = useCallback((p) => {
    setNodes(prev => [...prev, [p.center[1], p.center[0]]]); // WGS84顺序 lat,lng
    setResults([]);
    controlRef.current.clearInput();
    mapRef.current.flyTo({ center: p.center, zoom: 12 });
  }, []);

  useEffect(() => {
    if (controlRef.current && loaded) controlRef.current.update(results);
  }, [results, loaded]);

  async function fetchDrivingRoute(points) {
    if (points.length < 2) return null;
    const origin = points[0].join(",");
    const destination = points[0].join(","); // 终点同起点
    const waypoints = points.length > 2 ? points.slice(1, -1).map(p => p.join(",")).join(";") : "";
    try {
      const res = await axios.get("https://restapi.amap.com/v3/direction/driving", {
        params: {
          key: AMAP_TOKEN,
          origin,
          destination,
          waypoints,
          extensions: "all"
        }
      });
      if (res.data.status !== "1") throw new Error(res.data.info);
      return res.data.route;
    } catch (error) {
      setError("路线规划失败: " + error.message);
      return null;
    }
  }

  function parseRoutePolyline(route) {
    if (!route.paths || route.paths.length === 0) return [];
    const steps = route.paths[0].steps;
    let coords = [];
    steps.forEach(step => {
      const pts = step.polyline.split(";").map(str => {
        const [lng, lat] = str.split(",").map(Number);
        return gcj02ToWgs84(lng, lat);
      });
      coords = coords.concat(pts);
    });
    return coords;
  }

  useEffect(() => {
    if (!loaded) return;
    const map = mapRef.current;
    const nodesData = {
      type: "FeatureCollection",
      features: nodes.map((n, i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [n[1], n[0]] },
        properties: { id: i }
      }))
    };
    if (map.getSource("nodes")) map.getSource("nodes").setData(nodesData);
    else {
      map.addSource("nodes", { type: "geojson", data: nodesData });
      map.addLayer({
        id: "nodes",
        type: "circle",
        source: "nodes",
        paint: { "circle-radius": 8, "circle-color": "#00E5FF" }
      });
      map.addLayer({
        id: "labels",
        type: "symbol",
        source: "nodes",
        layout: { "text-field": ["get", "id"], "text-offset": [0, 1.5], "text-size": 12 },
        paint: { "text-color": "#fff" }
      });
    }
  }, [nodes, loaded]);

  useEffect(() => {
    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: mapRoot.current,
      style: "mapbox://styles/yejiangtao/cmaw786m0000h01sw7ugicjkv",
      center: [120.1551, 30.2741],
      zoom: 10
    });
    mapRef.current = map;
    map.on("load", () => {
      setLoaded(true);
      map.addControl(new mapboxgl.NavigationControl());
      const ctrl = new SearchControl(
        debouncedSearch,
        onSelect,
        async () => {
          const ptsGCJ = nodesRef.current.map(([lat, lng]) => {
            const [lngGCJ, latGCJ] = wgs84ToGcj02(lng, lat);
            return [lngGCJ, latGCJ];
          });
          if (ptsGCJ.length < 2) return setError("至少需要2个节点");
          setError("");
          const tour = await optimizePath(ptsGCJ);
          // 按顺序排列的 GCJ02 点
          const orderedPointsGCJ = tour.map(i => ptsGCJ[i]);

          // 环路：把起点添加到末尾
          const loopPointsGCJ = [...orderedPointsGCJ, orderedPointsGCJ[0]];

          // 请求高德驾车路径规划
          const route = await fetchDrivingRoute(loopPointsGCJ);
          if (!route) return;

          const routeCoords = parseRoutePolyline(route);

          const routeGeoJSON = {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: routeCoords
            }
          };

          if (map.getLayer("driving-route")) map.removeLayer("driving-route");
          if (map.getSource("driving-route")) map.removeSource("driving-route");

          map.addSource("driving-route", { type: "geojson", data: routeGeoJSON });
          map.addLayer({
            id: "driving-route",
            type: "line",
            source: "driving-route",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: { "line-color": "#1E90FF", "line-width": 5 }
          });
        },
        () => {
          setNodes([]);
          setResults([]);
          setError("");
          if (map.getLayer("driving-route")) map.removeLayer("driving-route");
          if (map.getSource("driving-route")) map.removeSource("driving-route");
        }
      );
      map.addControl(ctrl, "top-left");
      controlRef.current = ctrl;
    });
    map.on("click", e => setNodes(prev => [...prev, [e.lngLat.lat, e.lngLat.lng]]));
    map.on("contextmenu", () => setNodes(prev => prev.slice(0, -1)));
    map.on("error", e => setError(e.error?.message || "地图错误"));
    return () => map.remove();
  }, [debouncedSearch, onSelect, optimizePath]);

  return (
    <>
      {error && (
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50">
          <div className="bg-red-600 text-white p-3 rounded shadow-xl min-w-60 text-center">
            {error}
          </div>
        </div>
      )}
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center z-40 bg-black bg-opacity-30 pointer-events-none">
          <div className="flex flex-col items-center">
            <svg className="animate-spin h-12 w-12 text-blue-400 mb-3" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
            <span className="text-white text-lg">地图加载中...</span>
          </div>
        </div>
      )}
      <div ref={mapRoot} className="absolute inset-0" />
    </>
  );
}

/*
index.css:
html,body,#root,.map-container { margin:0; padding:0; width:100%; height:100%; }
.search-control { z-index:1000; pointer-events:auto; }
*/
