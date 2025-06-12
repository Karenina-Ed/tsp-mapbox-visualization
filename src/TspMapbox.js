import React, { useRef, useState, useCallback, useEffect } from "react";
import mapboxgl from "mapbox-gl";
import axios from "axios";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { gcj02ToWgs84, wgs84ToGcj02 } from './utils/coordTransform';

// --- 配置 ---
const MAPBOX_TOKEN = process.env.REACT_APP_MAPBOX_TOKEN;
const AMAP_TOKEN = process.env.REACT_APP_AMAP_KEY;
const OPTIMIZE_API = "http://10.12.58.42:8000/optimize_path";

// --- 工具函数 ---
async function reverseGeocode(lat, lng) {
  try {
    const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat);
    const res = await axios.get("https://restapi.amap.com/v3/geocode/regeo", {
      params: { key: AMAP_TOKEN, location: `${gcjLng},${gcjLat}`, extensions: "all" },
    });
    if (res.data.status !== "1") throw new Error(res.data.info || "逆地理编码失败");
    return res.data.regeocode.formatted_address || "未知地点";
  } catch {
    return "未知地点";
  }
}

async function searchAmap(keyword) {
  if (!keyword) return [];
  try {
    const res = await axios.get("https://restapi.amap.com/v3/assistant/inputtips", {
      params: { key: AMAP_TOKEN, keywords: keyword, datatype: "all" }
    });
    if (res.data.status !== "1") return [];
    return res.data.tips.filter(t => t.location).map(t => {
      const [lng, lat] = t.location.split(",").map(Number);
      return { place_name: t.name + (t.district ? ` (${t.district})` : ""), center: [lng, lat] };
    });
  } catch {
    return [];
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
}

async function fetchFullRouteByChunks(segments) {
  const fullCoords = [];
  for (let idx = 0; idx < segments.length; idx++) {
    const segment = segments[idx];
    const segCoords = await fetchSegmentRoute(segment);
    if (segCoords.length === 0) continue;
    if (idx === 0) fullCoords.push(...segCoords);
    else fullCoords.push(...segCoords.slice(1));
  }
  return fullCoords;
}

export default function TspMapbox() {
  const mapRoot = useRef(null);
  const mapRef = useRef(null);

  const [loaded, setLoaded] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [nodeNames, setNodeNames] = useState([]);
  const [error, setError] = useState("");
  const [planning, setPlanning] = useState(false);
  const [searchVal, setSearchVal] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(null);


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
      map.addControl(new mapboxgl.NavigationControl(), "top-right");
      map.addControl(new mapboxgl.FullscreenControl(), "top-right");
      map.addControl(new mapboxgl.ScaleControl({maxWidth: 80, unit: "metric"}), "bottom-left");
      map.addControl(new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showUserLocation: true
      }), "top-right");
    });
    map.on("error", (e) => setError(e.error?.message || "地图错误"));
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  const renderMapNodes = useCallback((nodes) => {
    if (!mapRef.current) return;
    const map = mapRef.current;
    const layerId = "nodes";
    const nodesData = {
      type: "FeatureCollection",
      features: nodes.map((n, i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [n[1], n[0]] },
        properties: { id: i + 1 }
      }))
    };
    if (map.getSource("nodes")) {
      map.getSource("nodes").setData(nodesData);
    } else {
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
  
    // 防止重复绑定
    if (map.__popupEventBound) return;
    map.__popupEventBound = true;
  
    let popup = null;
    map.on("mouseenter", layerId, (e) => {
      map.getCanvas().style.cursor = "pointer";
      const feature = e.features[0];
      const idx = feature.properties.id - 1;
      const coord = feature.geometry.coordinates;
      const popupHtml = `
        <div class="relative min-w-[180px] px-4 py-3 rounded-2xl bg-white shadow-xl border border-indigo-100 text-xs text-gray-700 pointer-events-none transition-all backdrop-blur-sm" style="box-shadow: 0 4px 16px 0 rgba(60,72,89,.09);line-height:1.7;">
          <div class="flex items-center mb-1">
            <span class="flex items-center justify-center w-6 h-6 mr-2 text-xs font-bold text-white bg-indigo-400 rounded-full">
              ${feature.properties.id}
            </span>
            <span class="font-semibold text-gray-800 break-all">${nodeNames[idx] || "加载中..."}</span>
          </div>
          <div>
            <span class="text-gray-400">纬度：</span>
            <span>${coord[1].toFixed(6)}</span>
          </div>
          <div>
            <span class="text-gray-400">经度：</span>
            <span>${coord[0].toFixed(6)}</span>
          </div>
          <div class="absolute left-1/2 -bottom-3 -translate-x-1/2 w-0 h-0 border-x-8 border-x-transparent border-t-8 border-t-white/80"></div>
        </div>
      `;
      popup = new mapboxgl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 24
      })
        .setLngLat(coord)
        .setHTML(popupHtml)
        .addTo(map);
    });
  
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
      if (popup) {
        popup.remove();
        popup = null;
      }
    });
  }, [nodeNames]);
  

  const renderRouteLine = useCallback((coords) => {
    if (!mapRef.current) return;
    const map = mapRef.current;
    const routeGeoJSON = {
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
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
  }, []);

  const updateNodeNames = useCallback(async (nextNodes) => {
    const names = await Promise.all(
      nextNodes.map(([lat, lng]) => reverseGeocode(lat, lng))
    );
    setNodeNames(names);
  }, []);

  const handleAddNode = useCallback(async ([lat, lng]) => {
    const nextNodes = [...nodes, [lat, lng]];
    setNodes(nextNodes);
    await updateNodeNames(nextNodes);
    renderMapNodes(nextNodes);
  }, [nodes, updateNodeNames, renderMapNodes]);

  const handleDeleteNode = useCallback(async (idx) => {
    const nextNodes = nodes.filter((_, i) => i !== idx);
    setNodes(nextNodes);
    await updateNodeNames(nextNodes);
    renderMapNodes(nextNodes);
    if (mapRef.current) {
      if (mapRef.current.getLayer("line-background")) mapRef.current.removeLayer("line-background");
      if (mapRef.current.getLayer("line-dashed")) mapRef.current.removeLayer("line-dashed");
      if (mapRef.current.getSource("driving-route")) mapRef.current.removeSource("driving-route");
    }
  }, [nodes, updateNodeNames, renderMapNodes]);

  // 封装：按指定顺序自动规划路线
  const planRouteByNodes = useCallback(async (currentNodes) => {
    if (currentNodes.length < 2) {
      setError("至少需要2个节点");
      return;
    }
    setPlanning(true);
    setError("");
    try {
      const ptsGCJ = currentNodes.map(([lat, lng]) => wgs84ToGcj02(lng, lat));
      const loopPts = [...ptsGCJ, ptsGCJ[0]];
      const segments = splitLoopsIntoSegments(loopPts, 16);
      const fullRouteCoords = await fetchFullRouteByChunks(segments);
      if (fullRouteCoords.length === 0) throw new Error("无法获取驾车路线");
      renderRouteLine(fullRouteCoords);
    } catch (err) {
      setError("路径规划失败: " + (err.message || err.toString()));
    }
    setPlanning(false);
  }, [renderRouteLine]);

  // 优化+规划
  const handleOptimizeAndPlanRoute = useCallback(async () => {
    if (nodes.length < 2) {
      setError("至少需要2个节点");
      return;
    }
    setPlanning(true);
    setError("");
    try {
      // 1. 优化顺序
      const ptsGCJ = nodes.map(([lat, lng]) => wgs84ToGcj02(lng, lat));
      const { data } = await axios.post(
        OPTIMIZE_API,
        { xy: ptsGCJ, temperature: 1.0, sample: false },
        { timeout: 15000 }
      );
      const tour = data.tour;
      const orderedNodes = tour.map(i => nodes[i]);
      setNodes(orderedNodes);
      await updateNodeNames(orderedNodes);
      renderMapNodes(orderedNodes);

      // 2. 按新顺序画路径
      await planRouteByNodes(orderedNodes);
    } catch (err) {
      setError("路径优化失败: " + (err.message || err.toString()));
    }
    setPlanning(false);
  }, [nodes, updateNodeNames, renderMapNodes, planRouteByNodes]);

  // 拖拽后自动重画
  const handleDragEnd = useCallback((result) => {
    if (!result.destination) return;
    const reordered = Array.from(nodes);
    const [moved] = reordered.splice(result.source.index, 1);
    reordered.splice(result.destination.index, 0, moved);
    setNodes(reordered);
    updateNodeNames(reordered);
    renderMapNodes(reordered);
    planRouteByNodes(reordered);
  }, [nodes, updateNodeNames, renderMapNodes, planRouteByNodes]);

  useEffect(() => {
    if (!loaded || !mapRef.current) return;
    const map = mapRef.current;
    const onMapClick = (e) => handleAddNode([e.lngLat.lat, e.lngLat.lng]);
    map.on("click", onMapClick);
    const onMapContextMenu = (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ["nodes"] });
      if (features.length === 0) return;
      const idToRemove = features[0].properties.id - 1;
      handleDeleteNode(idToRemove);
    };
    map.on("contextmenu", onMapContextMenu);
    return () => {
      map.off("click", onMapClick);
      map.off("contextmenu", onMapContextMenu);
    };
  }, [loaded, handleAddNode, handleDeleteNode]);

  const handleClearNodes = async () => {
    setNodes([]);
    setNodeNames([]);
    if (mapRef.current && mapRef.current.getSource("nodes")) {
      mapRef.current.getSource("nodes").setData({
        type: "FeatureCollection",
        features: [],
      });
    }
    if (mapRef.current) {
      if (mapRef.current.getLayer("line-background")) mapRef.current.removeLayer("line-background");
      if (mapRef.current.getLayer("line-dashed")) mapRef.current.removeLayer("line-dashed");
      if (mapRef.current.getSource("driving-route")) mapRef.current.removeSource("driving-route");
    }
  };

  const handleSearchInput = useCallback(async (e) => {
    const value = e.target.value;
    setSearchVal(value);
    setSearchLoading(true);
    setSearchResults([]);
    if (value) {
      const list = await searchAmap(value);
      setSearchResults(list);
    }
    setSearchLoading(false);
  }, []);

  const handleSelectSearchResult = async (item) => {
    setSearchVal("");
    setSearchResults([]);
    await handleAddNode([item.center[1], item.center[0]]);
    if (mapRef.current) mapRef.current.flyTo({ center: item.center, zoom: 12 });
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
            <span className="text-white text-lg">正在处理...</span>
          </div>
        </div>
      )}

      <div ref={mapRoot} className="absolute inset-0" />

      {/* 左上角搜索框 */}
      <div className="absolute left-4 top-4 w-96 z-50">
        <div className="relative">
          <input
            className="w-full h-11 pl-3 pr-4 rounded-lg bg-white text-gray-800 border border-gray-300 shadow placeholder:font-bold focus:outline-none focus:border-indigo-600 focus:ring-2 focus:ring-indigo-200 transition"
            value={searchVal}
            onChange={handleSearchInput}
            placeholder="输入地点名称或地标"
            autoComplete="off"
          />
          {searchLoading && <div className="text-sm text-gray-400 pl-2 mt-1">搜索中...</div>}
          {searchResults.length > 0 && (
            <ul className="absolute z-30 w-full bg-white text-gray-800 rounded-lg max-h-120 overflow-auto shadow-md top-full mt-1 border border-gray-200">
              {searchResults.map((r, i) => (
                <li
                  key={i}
                  className="p-3 text-gray-700 hover:bg-indigo-50 hover:text-indigo-800 cursor-pointer"
                  onClick={() => handleSelectSearchResult(r)}
                >{r.place_name}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* 右侧节点列表 */}
      <div className="absolute top-4 right-16 w-96 bg-white rounded-lg shadow-md p-4 z-50 max-h-[80vh] overflow-y-auto">
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
                          className={`flex items-center justify-between p-2 rounded-lg mb-2 transition duration-150 ease-in-out relative cursor-pointer 
                            ${selectedIndex === index ? 'bg-indigo-100 border-2 border-indigo-400' : 'bg-gray-50 hover:bg-gray-100'}`}
                            onClick={() => {
                              setSelectedIndex(index);
                              if (mapRef.current) {
                                mapRef.current.flyTo({ center: [node[1], node[0]], zoom: 10});
                              }
                            }}
                        >
                          <span className="text-gray-700">{`${index + 1}. ${nodeNames[index] || "加载中..."}`}</span>
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

        {/* 按钮区，只保留一个“优化路径”按钮 */}
        <div className="flex gap-2 mt-4">
          <button
            onClick={handleOptimizeAndPlanRoute}
            disabled={nodes.length < 2 || planning}
            className="flex-1 flex items-center justify-center px-4 py-2 text-base bg-gradient-to-r from-indigo-500 to-indigo-700 text-white rounded-lg shadow hover:bg-indigo-800 transition duration-200 disabled:opacity-50"
          >
            优化路径
          </button>
          <button
            onClick={handleClearNodes}
            disabled={nodes.length === 0}
            className="flex-1 flex items-center justify-center px-4 py-2 text-base bg-gradient-to-r from-red-500 to-red-700 text-white rounded-lg shadow hover:bg-red-800 transition duration-200 disabled:opacity-50"
          >
            清除节点
          </button>
        </div>
      </div>
    </>
  );
}
