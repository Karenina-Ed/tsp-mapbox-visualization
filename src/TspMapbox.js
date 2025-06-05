import React, { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import axios from "axios";
import { gcj02ToWgs84, wgs84ToGcj02 } from './utils/coordTransform';
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";// 导入拖拽库

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
    this.container.className = "search-control m-4 flex flex-row items-center space-x-4 p-0 bg-transparent";
  }

  onAdd(map) {
    this.map = map;
    this.container.innerHTML = `
      <div class="flex flex-row items-center space-x-4">
        <div class="relative w-80">
          <input id="search-input" type="text" placeholder="搜索地点" class="w-full h-12 pl-3 pr-10 rounded-lg bg-white text-gray-800 border border-gray-300 shadow font-bold placeholder:font-bold focus:outline-none focus:border-indigo-600 focus:ring-2 focus:ring-indigo-200 transition ease-in-out duration-200" autocomplete="off" />
          <button id="search-button" class="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-500 hover:text-indigo-600 transition duration-200">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
          <ul id="results" class="absolute z-20 w-full bg-white text-gray-800 rounded-lg max-h-60 overflow-auto hidden shadow-md top-full mt-1 border border-gray-200"></ul>
        </div>
        <div class="flex gap-2">
          <button id="optimize" class="flex items-center justify-center px-4 py-2 h-12 text-base bg-gradient-to-r from-indigo-500 to-indigo-700 text-white rounded-lg shadow hover:bg-indigo-800 transition duration-200">
            优化路径
          </button>
          <button id="clear" class="flex items-center justify-center px-4 py-2 h-12 text-base bg-gradient-to-r from-red-500 to-red-700 text-white rounded-lg shadow hover:bg-red-800 transition duration-200">
            清除节点
          </button>
        </div>
      </div>
    `;
    this.container.addEventListener("click", (e) => {
      const t = e.target;
      if (t.id === "optimize") return this.onOptimize();
      if (t.id === "clear") return this.onClear();
      if (t.id === "search-button" || t.closest("#search-button")) {
        const input = this.container.querySelector("#search-input");
        this.onSearch(input.value);
      }
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
        <li class="p-3 text-gray-700 hover:bg-indigo-50 hover:text-indigo-800 cursor-pointer transition duration-150 ease-in-out" data-place='${JSON.stringify(r)}'>${r.place_name}</li>
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

function splitLoopsIntoSegments(fullLoopPts, maxPoints = 16) {
  const segments = [];
  let i = 0;
  while (i < fullLoopPts.length - 1) {
    if (fullLoopPts.length - i <= maxPoints) {
      segments.push(fullLoopPts.slice(i));
      break;
    }
    const sliceEnd = i + maxPoints - 1;
    segments.push(fullLoopPts.slice(i, sliceEnd + 1));
    i = sliceEnd;
  }
  return segments;
}

async function fetchSegmentRoute(segmentPts) {
  if (!segmentPts || segmentPts.length < 2) return [];
  const origin = segmentPts[0].join(",");
  const destination = segmentPts[segmentPts.length - 1].join(",");
  const waypoints = segmentPts.length > 2 ? segmentPts.slice(1, -1).map((p) => p.join(",")).join(";") : "";
  try {
    const res = await axios.get("https://restapi.amap.com/v3/direction/driving", {
      params: { key: AMAP_TOKEN, origin, destination, waypoints, extensions: "all" },
    });
    if (res.data.status !== "1") throw new Error(res.data.info || "未知错误");
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

async function fetchFullRouteByChunks(segments) {
  const fullCoords = [];
  for (let idx = 0; idx < segments.length; idx++) {
    const segment = segments[idx];
    try {
      const segCoords = await fetchSegmentRoute(segment);
      if (segCoords.length === 0) continue;
      if (idx === 0) fullCoords.push(...segCoords);
      else fullCoords.push(...segCoords.slice(1));
    } catch (err) {
      console.error(`第 ${idx + 1} 段驾车规划失败`, err);
      throw err;
    }
  }
  return fullCoords;
}

async function reverseGeocode(lat, lng) {
  try {
    const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat);
    const res = await axios.get("https://restapi.amap.com/v3/geocode/regeo", {
      params: {
        key: AMAP_TOKEN,
        location: `${gcjLng},${gcjLat}`,
        extensions: "all",
      },
    });
    if (res.data.status !== "1") throw new Error(res.data.info || "逆地理编码失败");
    const address = res.data.regeocode.formatted_address || "未知地点";
    return address;
  } catch (err) {
    console.error("逆地理编码出错：", err);
    return "未知地点";
  }
}

export default function TspMapbox() {
  const mapRoot = useRef(null);
  const mapRef = useRef(null);
  const controlRef = useRef(null);

  const [loaded, setLoaded] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [nodeNames, setNodeNames] = useState([]); // 存储节点对应的地点名称
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const [planning, setPlanning] = useState(false);

  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  // 逆地理编码：将 nodes 的经纬度转换为地点名称
  useEffect(() => {
    const fetchNodeNames = async () => {
      const names = await Promise.all(
        nodes.map(async ([lat, lng]) => {
          const name = await reverseGeocode(lat, lng);
          return name;
        })
      );
      setNodeNames(names);
    };
    fetchNodeNames();
  }, [nodes]);

  // 拖拽结束后的处理
  const handleDragEnd = (result) => {
    if (!result.destination) return; // 如果没有放置位置，不执行
    const reorderedNodes = Array.from(nodes);
    const [movedNode] = reorderedNodes.splice(result.source.index, 1);
    reorderedNodes.splice(result.destination.index, 0, movedNode);
    setNodes(reorderedNodes);
  };

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
    setNodes(prev => [...prev, [p.center[1], p.center[0]]]);
    setResults([]);
    controlRef.current.clearInput();
    mapRef.current.flyTo({ center: p.center, zoom: 12 });
  }, []);

  const onOptimize = useCallback(async () => {
    setError("");
    setPlanning(true);
    try {
      const map = mapRef.current;
      if (!map || !map.isStyleLoaded()) {
        setError("地图未加载完成，请稍后重试");
        return;
      }
      const ptsGCJ = nodesRef.current.map(([lat, lng]) => {
        const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat);
        return [gcjLng, gcjLat];
      });
      if (ptsGCJ.length < 2) {
        setError("至少需要 2 个节点");
        return;
      }
      const tour = await optimizePath(ptsGCJ);
      const orderedPointsGCJ = tour.map((i) => ptsGCJ[i]);
      const loopPointsGCJ = [...orderedPointsGCJ, orderedPointsGCJ[0]];
      const segments = splitLoopsIntoSegments(loopPointsGCJ, 16);
      const fullRouteCoords = await fetchFullRouteByChunks(segments);
      if (fullRouteCoords.length === 0) {
        setError("无法获取驾车路线");
        return;
      }
      const routeGeoJSON = {
        type: "Feature",
        geometry: { type: "LineString", coordinates: fullRouteCoords },
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
        paint: { "line-color": "#87CEEB", "line-width": 5 }
      });
      map.addLayer({
        id: "line-dashed",
        type: "line",
        source: "driving-route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#1D3B57", "line-dasharray": [0, 4, 3], "line-width": 4 }
      });
      const dashArraySequence = [
        [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5],
        [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5],
        [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5],
        [0, 3, 3, 1], [0, 3.5, 3, 0.5]
      ];
      let step = 0;
      function animateDashArray(timestamp) {
        if (!map.getLayer("line-dashed")) return;
        const newStep = parseInt((timestamp / 100) % dashArraySequence.length);
        if (newStep !== step) {
          map.setPaintProperty("line-dashed", "line-dasharray", dashArraySequence[step]);
          step = newStep;
        }
        requestAnimationFrame(animateDashArray);
      }
      animateDashArray(0);
    } catch (err) {
      setError("路径规划失败: " + err.message);
    } finally {
      setPlanning(false);
    }
  }, [optimizePath]);

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
        paint: { "circle-radius": 8, "circle-color": "#00FFFF" }
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
    if (mapRef.current) return;
    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: mapRoot.current,
      style: "mapbox://styles/yejiangtao/cmbj4f8mm00en01sn9y7zhuak",
      center: [120.1551, 30.2741],
      zoom: 10,
      projection: "globe",
    });
    mapRef.current = map;
    map.on("load", () => {
      setLoaded(true);
      map.addControl(new mapboxgl.NavigationControl());
      const ctrl = new SearchControl(
        debouncedSearch,
        onSelect,
        onOptimize,
        () => {
          setNodes([]);
          setResults([]);
          setError("");
          if (mapRef.current) {
            if (mapRef.current.getLayer("line-background")) mapRef.current.removeLayer("line-background");
            if (mapRef.current.getLayer("line-dashed")) mapRef.current.removeLayer("line-dashed");
            if (mapRef.current.getSource("driving-route")) mapRef.current.removeSource("driving-route");
          }
        }
      );
      map.addControl(ctrl, "top-left");
      controlRef.current = ctrl;

      const geolocate = new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: false,
        showUserLocation: true,
      });
      map.addControl(geolocate, "top-right");
      geolocate.on("geolocate", (position) => {
        const { latitude, longitude } = position.coords;
        map.flyTo({ center: [longitude, latitude], zoom: 14 });
      });
      geolocate.on("error", (error) => {
        setError("无法获取当前位置: " + error.message);
      });
    });
    map.on("click", e => setNodes(prev => [...prev, [e.lngLat.lat, e.lngLat.lng]]));
    map.on("contextmenu", e => {
      const features = map.queryRenderedFeatures(e.point, { layers: ["nodes"] });
      if (features.length === 0) return;
      const idToRemove = features[0].properties.id;
      setNodes(prev => prev.filter((_, idx) => idx !== idToRemove));
    });
    map.on("error", e => setError(e.error?.message || "地图错误"));
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [debouncedSearch, onSelect, onOptimize]);

  const handleDeleteNode = (index) => {
    setNodes(prev => prev.filter((_, idx) => idx !== index));
  };

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
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            <span className="text-white text-lg">地图加载中...</span>
          </div>
        </div>
      )}
      {planning && (
        <div className="absolute inset-0 flex items-center justify-center z-40 bg-black bg-opacity-30 pointer-events-none">
          <div className="flex flex-col items-center">
            <svg className="animate-spin h-12 w-12 text-blue-400 mb-3" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            <span className="text-white text-lg">正在规划路径...</span>
          </div>
        </div>
      )}
      <div ref={mapRoot} className="absolute inset-0" />
      {/* 右侧节点列表组件 */}
      <div className="absolute top-4 right-16 w-80 bg-white rounded-lg shadow-md p-4 z-50 max-h-[80vh] overflow-y-auto">
        <h3 className="text-lg font-bold text-gray-800 mb-3">已选节点</h3>
        {nodes.length === 0 ? (
          <p className="text-gray-500 italic">暂无节点，请点击地图或搜索添加</p>
        ) : (
          <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable droppableId="nodes">
              {(provided) => (
                <ul {...provided.droppableProps} ref={provided.innerRef}>
                  {nodes.map((node, index) => (
                    <Draggable key={index} draggableId={`node-${index}`} index={index}>
                      {(provided) => (
                        <li
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          {...provided.dragHandleProps}
                          className="flex items-center justify-between p-2 bg-gray-50 hover:bg-gray-100 rounded-lg mb-2 transition duration-150 ease-in-out"
                        >
                          <div className="flex items-center">
                            <svg className="h-5 w-5 text-gray-400 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16m-7 6h7" />
                            </svg>
                            <span className="text-gray-700">{nodeNames[index] || "加载中..."}</span>
                          </div>
                          <button
                            onClick={() => handleDeleteNode(index)}
                            className="text-red-500 hover:text-red-700 transition duration-150"
                          >
                            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </li>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </ul>
              )}
            </Droppable>
          </DragDropContext>
        )}
        {nodes.length > 0 && (
          <button
            onClick={onOptimize}
            className="w-full mt-3 flex items-center justify-center px-4 py-2 text-base bg-gradient-to-r from-indigo-500 to-indigo-700 text-white rounded-lg shadow hover:bg-indigo-800 transition duration-200"
          >
            规划路径
          </button>
        )}
      </div>
    </>
  );
}