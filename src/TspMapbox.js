// src/components/TspMapbox.js
import React, { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import axios from "axios";
import { data } from "autoprefixer";
import { gcj02ToWgs84, wgs84ToGcj02 } from './utils/coordTransform'

const MAPBOX_TOKEN = process.env.REACT_APP_MAPBOX_TOKEN;
const AMAP_TOKEN = process.env.REACT_APP_AMAP_KEY;
if (!MAPBOX_TOKEN) console.error("缺少 Mapbox 令牌: 设置 REACT_APP_MAPBOX_TOKEN");
if (!AMAP_TOKEN) console.error("缺少高德 API 密钥: 设置 REACT_APP_AMAP_KEY");




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
/**
 * 将完整闭环路径拆分成多个子段，每段最多 maxPoints 个点（高德限 16）
 * @param {Array<[number, number]>} fullLoopPts GCJ 坐标闭环数组，例如 [[lng0,lat0], [lng1,lat1], …, [lng0,lat0]]
 * @param {number} maxPoints  最大点数（默认 16）
 * @returns {Array<Array<[number, number]>>}  拆分后的各段数组
 */
function splitLoopsIntoSegments(fullLoopPts, maxPoints = 16) {
  const segments = [];
  let i = 0;
  while (i < fullLoopPts.length - 1) {
    // 如果剩余的点小于等于 maxPoints，直接把剩下所有点当最后一段
    if (fullLoopPts.length - i <= maxPoints) {
      segments.push(fullLoopPts.slice(i));
      break;
    }
    // 否则截取 i 到 i + maxPoints - 1（共 maxPoints 个点）作为当前段
    const sliceEnd = i + maxPoints - 1;
    segments.push(fullLoopPts.slice(i, sliceEnd + 1));
    // 下一段从当前段的最后一个点开始（重叠一个点）
    i = sliceEnd;
  }
  return segments;
}

/**
 * 查询单段驾车路径，返回 WGS84 坐标折线
 * @param {Array<[number, number]>} segmentPts GCJ 坐标数组，长度 2~16
 * @returns {Promise<Array<[number, number]>>}  WGS84 坐标折线
 */
async function fetchSegmentRoute(segmentPts) {
  if (!segmentPts || segmentPts.length < 2) return [];

  const origin = segmentPts[0].join(",");
  const destination = segmentPts[segmentPts.length - 1].join(",");
  const waypoints =
    segmentPts.length > 2
      ? segmentPts.slice(1, -1).map((p) => p.join(",")).join(";")
      : "";

  try {
    const res = await axios.get("https://restapi.amap.com/v3/direction/driving", {
      params: {
        key: AMAP_TOKEN,
        origin,
        destination,
        waypoints,
        extensions: "all",
      },
    });
    if (res.data.status !== "1") {
      throw new Error(res.data.info || "未知错误");
    }
    // 解析 polyline，注意高德返回的是 GCJ-02，需要转成 WGS84
    const steps = res.data.route.paths[0].steps;
    let coords = [];
    for (const step of steps) {
      const pts = step.polyline.split(";").map((str) => {
        const [lng, lat] = str.split(",").map(Number);
        return gcj02ToWgs84(lng, lat);
      });
      coords = coords.concat(pts);
    }
    return coords;
  } catch (err) {
    console.error("fetchSegmentRoute 出错：", err);
    throw err;
  }
}

/**
 * 对所有子段依次调用驾车规划并拼接成一条完整折线
 * @param {Array<Array<[number, number]>>} segments 拆分后的多段 GCJ 数组
 * @returns {Promise<Array<[number, number]>>}  完整 WGS84 折线
 */
async function fetchFullRouteByChunks(segments) {
  const fullCoords = [];
  for (let idx = 0; idx < segments.length; idx++) {
    const segment = segments[idx];
    try {
      const segCoords = await fetchSegmentRoute(segment);
      if (segCoords.length === 0) continue;
      // 第一段直接所有坐标都 push
      if (idx === 0) {
        fullCoords.push(...segCoords);
      } else {
        // 后续段需要跳过第一个点，因为与上一段末尾重复
        fullCoords.push(...segCoords.slice(1));
      }
    } catch (err) {
      console.error(`第 ${idx + 1} 段驾车规划失败`, err);
      throw err;
    }
  }
  return fullCoords;
}

export default function TspMapbox() {
  const mapRoot = useRef(null);
  const mapRef = useRef(null);
  const controlRef = useRef(null);

  const [loaded, setLoaded] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const [planning, setPlanning] = useState(false);

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
      setError("搜索失败: " + e.message + "返回状态: " + data?.status);
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
          setError("");
          setPlanning(true);
          try {
            // 1. WGS84 转 GCJ02
            const ptsGCJ = nodesRef.current.map(([lat, lng]) => {
              const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat);
              return [gcjLng, gcjLat];
            });
            if (ptsGCJ.length < 2) {
              setError("至少需要 2 个节点");
              return;
            }

            // 2. TSP 优化，拿到最优访问顺序
            const tour = await optimizePath(ptsGCJ);

            // 3. 按 tour 顺序构造闭环，再加回起点
            const orderedPointsGCJ = tour.map((i) => ptsGCJ[i]);
            const loopPointsGCJ = [...orderedPointsGCJ, orderedPointsGCJ[0]];

            // 4. 拆分成多段，每段 ≤ 16 个点
            const segments = splitLoopsIntoSegments(loopPointsGCJ, 16);

            // 5. 异步依次请求各段驾车规划，并拼接成完整折线
            const fullRouteCoords = await fetchFullRouteByChunks(segments);
            if (fullRouteCoords.length === 0) {
              setError("无法获取驾车路线");
              return;
            }

            // 6. 在地图上渲染这条完整折线
            const routeGeoJSON = {
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: fullRouteCoords,
              },
            };

          if (map.getLayer("line-background")) map.removeLayer("line-background");
          if (map.getLayer("line-dashed")) map.removeLayer("line-dashed");
          if (map.getSource("driving-route")) map.removeSource("driving-route");

          map.addSource("driving-route", { type: "geojson", data: routeGeoJSON });
          map.addLayer({
            id: "line-background",
            type: "line",
            source: "driving-route",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: { "line-color": "#69b4ff", "line-width": 5 }
          });
          map.addLayer({
            id: "line-dashed",
            type: "line",
            source: "driving-route",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: { "line-color": "#1f2937", 'line-dasharray': [0, 4, 3], 'line-width': 4}
          });
          const dashArraySequence = [
            [0, 4, 3],
            [0.5, 4, 2.5],
            [1, 4, 2],
            [1.5, 4, 1.5],
            [2, 4, 1],
            [2.5, 4, 0.5],
            [3, 4, 0],
            [0, 0.5, 3, 3.5],
            [0, 1, 3, 3],
            [0, 1.5, 3, 2.5],
            [0, 2, 3, 2],
            [0, 2.5, 3, 1.5],
            [0, 3, 3, 1],
            [0, 3.5, 3, 0.5]
        ];
        let step = 0;

        function animateDashArray(timestamp) {
            // 更新线条的 dasharray 属性以创建动画效果
            // 使用 modulo 运算符来循环 dashArraySequence 数组
            
            if (!map.getLayer('line-dashed')) return;
            const newStep = parseInt(
                (timestamp / 100) % dashArraySequence.length
            );

            if (newStep !== step) {
                map.setPaintProperty(
                    'line-dashed',
                    'line-dasharray',
                    dashArraySequence[step]
                );
                step = newStep;
            }

            // 递归调用以继续动画
            requestAnimationFrame(animateDashArray);
        }

        // 开始动画
        animateDashArray(0);
        } finally {
          setPlanning(false);
        }
        },
        () => {
          setNodes([]);
          setResults([]);
          setError("");
          if (map.getLayer("line-background")) map.removeLayer("line-background");
          if (map.getLayer("line-dashed")) map.removeLayer("line-dashed");
          if (map.getSource("driving-route")) map.removeSource("driving-route");
        }
      );
      map.addControl(ctrl, "top-left");
      controlRef.current = ctrl;
    });
    map.on("click", e => setNodes(prev => [...prev, [e.lngLat.lat, e.lngLat.lng]]));
    map.on("contextmenu", e => {
      // 1. 在 "nodes" 图层里查询点击位置上的要素
      const features = map.queryRenderedFeatures(e.point, { layers: ["nodes"] });
      if (features.length === 0) {
        // 如果没有点击到任何节点，就不做操作
        return;
      }
      // 2. 取第一个被点击到的节点的 id（我们渲染时把 idx 写到了 feature.properties.id）
      const idToRemove = features[0].properties.id;
      // 3. 从 nodes 数组里把这个索引过滤掉
      setNodes(prev => prev.filter((_, idx) => idx !== idToRemove));
    });
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
      {planning && (
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
            <span className="text-white text-lg">正在规划路径...</span>
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
