// src/components/TspMapbox.js
import React, { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import axios from "axios";

// 环境变量 Token
const MAPBOX_TOKEN = process.env.REACT_APP_MAPBOX_TOKEN;
const AMAP_TOKEN = process.env.REACT_APP_AMAP_KEY;
if (!MAPBOX_TOKEN) console.error("缺少 Mapbox 令牌: 设置 REACT_APP_MAPBOX_TOKEN");
if (!AMAP_TOKEN) console.error("缺少高德 API 密钥: 设置 REACT_APP_AMAP_KEY");

// 防抖 Hook
function useDebounce(fn, delay) {
  const timeoutRef = useRef(null);
  return useCallback((...args) => {
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => fn(...args), delay);
  }, [fn, delay]);
}

// 自定义搜索控件
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
        <input id="search-input" type="text" placeholder="搜索地点" class="w-full p-2 rounded bg-gray-700 text-white border focus:outline-none" autocomplete="off" />
        <ul id="results" class="absolute z-20 w-full bg-gray-700 border rounded max-h-60 overflow-auto hidden"></ul>
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
  const [path, setPath] = useState([]);
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");

  // 用 Ref 保持最新 nodes
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  // 优化路径函数
  const optimizePath = useCallback(async (pts) => {
    const { data } = await axios.post(
      "http://10.12.58.42:8000/optimize_path",
      { xy: pts, temperature: 1.0, sample: false },
      { timeout: 10000 }
    );
    return data.tour;
  }, []);

  // 搜索函数
  const doSearch = useCallback(async (q) => {
    if (!q) return setResults([]);
    try {
      const { data } = await axios.get("https://restapi.amap.com/v3/geocode/geo", {
        params: { key: AMAP_TOKEN, address: q, city: "杭州", output: "JSON" }
      });
      if (data.status !== "1") throw new Error(data.info);
      const list = data.geocodes.map(g => {
        const [lng, lat] = g.location.split(",").map(Number);
        return { place_name: g.formatted_address, center: [lng, lat] };
      });
      setResults(list);
      setError("");
    } catch (e) {
      console.error(e);
      setError("搜索失败: " + e.message);
    }
  }, []);
  const debouncedSearch = useDebounce(doSearch, 300);

  // 选择地点回调
  const onSelect = useCallback((p) => {
    setNodes(prev => [...prev, [p.center[1], p.center[0]]]);
    setResults([]);
    controlRef.current.clearInput();
    mapRef.current.flyTo({ center: p.center, zoom: 12 });
  }, []);

  // 更新控制器
  useEffect(() => {
    if (controlRef.current && loaded) controlRef.current.update(results);
  }, [results, loaded]);

  // 更新地图数据
  useEffect(() => {
    if (!loaded) return;
    const map = mapRef.current;
    // 更新节点数据
    const nodesData = { type: "FeatureCollection", features: nodes.map((n,i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [n[1],n[0]] }, properties: { id:i } })) };
    if (map.getSource("nodes")) map.getSource("nodes").setData(nodesData);
    else {
      map.addSource("nodes", { type: "geojson", data: nodesData });
      map.addLayer({ id: "nodes", type: "circle", source: "nodes", paint: { "circle-radius": 8, "circle-color": "#00E5FF" } });
      map.addLayer({ id: "labels", type: "symbol", source: "nodes", layout: { "text-field": ["get","id"], "text-offset": [0,1.5], "text-size": 12 }, paint: { "text-color": "#fff" } });
    }
    // 更新路径数据
    if (path.length > 1) {
      const coords = path.map(i => [nodesRef.current[i][1], nodesRef.current[i][0]]);
      coords.push(coords[0]);
      const pData = { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
      if (map.getSource("path")) map.getSource("path").setData(pData);
      else {
        map.addSource("path", { type: "geojson", data: pData });
        map.addLayer({ id: "path", type: "line", source: "path", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#00e676", "line-width": 3 } });
      }
    } else if (map.getSource("path")) {
      map.removeLayer("path"); map.removeSource("path");
    }
  }, [path, loaded, nodes]);

  // 初始化地图
  useEffect(() => {
    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({ container: mapRoot.current, style: "mapbox://styles/yejiangtao/cmaw786m0000h01sw7ugicjkv", center: [120.1551,30.2741], zoom: 10 });
    mapRef.current = map;
    map.on("load", () => {
      setLoaded(true);
      map.addControl(new mapboxgl.NavigationControl());
      // control callbacks reading from refs/state
      const ctrl = new SearchControl(
        debouncedSearch,
        onSelect,
        async () => {
          const pts = nodesRef.current.map(([lat,lng]) => [lng, lat]);
          if (pts.length < 2) return setError("至少需要2个节点");
          setError("");
          const tour = await optimizePath(pts);
          setPath(tour);
        },
        () => { setNodes([]); setPath([]); setResults([]); setError(""); }
      );
      map.addControl(ctrl, "top-left");
      controlRef.current = ctrl;
    });
    map.on("click", e => setNodes(prev => [...prev, [e.lngLat.lat, e.lngLat.lng]]));
    map.on("contextmenu", () => setNodes(prev => prev.slice(0,-1)));
    map.on("error", e => setError(e.error?.message || "地图错误"));
    return () => map.remove();
  }, [debouncedSearch, onSelect, optimizePath]);

  return (
    <>
      {/* 错误提示 */}
      {error && (
        <div className="absolute top-2 left-2 bg-red-600 text-white p-2 rounded z-30">
          {error}
        </div>
      )}
  
      {/* 加载动画（地图未加载时显示） */}
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center z-40 bg-black bg-opacity-30 pointer-events-none">
          <div className="flex flex-col items-center">
            {/* 旋转的圆圈动画 */}
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
  
      {/* 地图容器 */}
      <div ref={mapRoot} className="absolute inset-0" />
    </>
  );
}

/*
index.css:
html,body,#root,.map-container { margin:0; padding:0; width:100%; height:100%; }
.search-control { z-index:1000; pointer-events:auto; }
*/
