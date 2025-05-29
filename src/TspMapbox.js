import React, { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import axios from "axios";

// Mapbox 访问令牌，从环境变量获取
const MAPBOX_TOKEN = process.env.REACT_APP_MAPBOX_TOKEN;

// 高德 API 密钥
const AMAP_TOKEN = "19283f3a70f51fabbee21e4acf8863bb";

// 自定义搜索控件类
class SearchControl {
  constructor(onSearch, onSelectPlace) {
    this._container = document.createElement("div");
    this._container.className = "search-control";
    this._onSearch = onSearch;
    this._onSelectPlace = onSelectPlace;
  }

  onAdd(map) {
    this._map = map;
    this._container.innerHTML = `
      <div class="relative w-80">
        <input
          type="text"
          id="search-input"
          placeholder="搜索地点"
          class="w-full p-2 rounded-md bg-gray-800 text-white border border-gray-600 focus:outline-none focus:border-blue-500"
          autocomplete="off"
        />
        <div id="search-results" class="absolute z-10 w-full bg-gray-800 border border-gray-600 rounded-md max-h-60 overflow-y-auto hidden"></div>
      </div>
    `;
    const searchInput = this._container.querySelector("#search-input");
    searchInput.addEventListener("input", (e) => {
      this._onSearch(e.target.value);
    });
    return this._container;
  }

  onRemove() {
    this._container.parentNode.removeChild(this._container);
    this._map = undefined;
  }

  updateResults(results) {
    const resultsDiv = this._container.querySelector("#search-results");
    if (resultsDiv) {
      if (results.length > 0) {
        resultsDiv.innerHTML = results
          .map(
            (place) => `
              <div
                class="p-2 hover:bg-gray-700 cursor-pointer text-gray-200"
                data-place='${JSON.stringify(place)}'
              >
                ${place.place_name}
              </div>
            `
          )
          .join("");
        resultsDiv.classList.remove("hidden");
        const resultElements = resultsDiv.querySelectorAll("div[data-place]");
        resultElements.forEach((element) => {
          element.addEventListener("click", () => {
            const place = JSON.parse(element.getAttribute("data-place"));
            this._onSelectPlace(place);
          });
        });
      } else {
        resultsDiv.classList.add("hidden");
      }
    }
  }

  clearInput() {
    const searchInput = this._container.querySelector("#search-input");
    if (searchInput) searchInput.value = "";
  }
}

// 主组件：TspMapbox
const TspMapbox = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const searchControlRef = useRef(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [path, setPath] = useState([]);
  const [error, setError] = useState(null);
  const [searchResults, setSearchResults] = useState([]);

  // 覆盖控制台方法
  useEffect(() => {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    // 检查令牌
    if (!MAPBOX_TOKEN) {
      console.error("Mapbox 令牌缺失，请设置 REACT_APP_MAPBOX_TOKEN 环境变量");
    }
    if (!AMAP_TOKEN) {
      console.error("高德 API 密钥缺失，请设置 AMAP_TOKEN");
    }

    // 清理：恢复原始控制台方法
    return () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    };
  }, []);

  const fetchOptimizedPath = useCallback(async (apiInput) => {
    try {
      const res = await axios.post(
        "http://10.12.58.42:8000/optimize_path",
        {
          xy: apiInput,
          temperature: 1.0,
          sample: false,
        },
        { timeout: 10000 }
      );
      return res.data.tour;
    } catch (e) {
      throw new Error(`获取优化路径失败: ${e.message}`);
    }
  }, []);

  const searchPlaces = useCallback(async (query) => {
    if (!query) {
      setSearchResults([]);
      return;
    }
    try {
      const response = await axios.get("https://restapi.amap.com/v3/geocode/geo", {
        params: {
          address: query,
          key: AMAP_TOKEN,
          city: "杭州",
          output: "JSON",
        },
      });

      if (response.data.status !== "1") {
        throw new Error(`高德 API 请求失败: ${response.data.info}`);
      }

      const features = response.data.geocodes.map((geocode) => {
        const [lng, lat] = geocode.location.split(",").map(Number);
        return {
          place_name: geocode.formatted_address,
          center: [lng, lat],
        };
      });

      setSearchResults(features);
    } catch (e) {
      console.error("搜索失败:", e);
      setError(`搜索失败: ${e.message}`);
    }
  }, []);

  const handleSelectPlace = useCallback((place) => {
    const [lng, lat] = place.center;
    setNodes((prev) => [...prev, [lat, lng]]);
    setSearchResults([]);
    if (searchControlRef.current) {
      searchControlRef.current.clearInput();
    }
    if (map.current) {
      map.current.flyTo({ center: [lng, lat], zoom: 12 });
    }
  }, []);

  const cleanupMap = useCallback(() => {
    if (map.current) {
      try {
        map.current.remove();
        console.log("地图清理成功");
        map.current = null;
      } catch (e) {
        console.error("地图清理失败:", e);
      }
    }
  }, []);

  useEffect(() => {
    if (!MAPBOX_TOKEN) {
      setError("Mapbox 令牌缺失，请检查环境变量");
      return;
    }

    if (map.current || !mapContainer.current) return;

    try {
      mapboxgl.accessToken = MAPBOX_TOKEN;
      map.current = new mapboxgl.Map({
        container: mapContainer.current,
        style: "mapbox://styles/yejiangtao/cmaw786m0000h01sw7ugicjkv",
        center: [120.1551, 30.2741],
        zoom: 10,
      });

      map.current.on("load", () => {
        console.log("地图加载成功");
        setMapLoaded(true);
        map.current.addControl(new mapboxgl.NavigationControl());
        const searchControl = new SearchControl(
          debounce((query) => searchPlaces(query), 500),
          handleSelectPlace
        );
        map.current.addControl(searchControl, "top-left");
        searchControlRef.current = searchControl;
        searchControl.updateResults([]);
      });

      map.current.on("click", (e) => {
        const { lng, lat } = e.lngLat;
        setNodes((prev) => [...prev, [lat, lng]]);
        setPath([]);
      });

      map.current.on("contextmenu", (e) => {
        const features = map.current.queryRenderedFeatures(e.point, {
          layers: ["nodes"],
        });
        if (features.length > 0) {
          const id = features[0].properties.id;
          setNodes((prev) => prev.filter((_, i) => i !== id));
          setPath([]);
        }
      });

      map.current.on("error", (e) => {
        console.error("Mapbox 错误:", e);
        setError(`Mapbox 错误: ${e.error.message}`);
      });

      return cleanupMap;
    } catch (e) {
      console.error("地图初始化失败:", e);
      setError(`地图初始化失败: ${e.message}`);
    }
  }, [cleanupMap, searchPlaces, handleSelectPlace]);

  useEffect(() => {
    if (!map.current || !mapLoaded) return;

    const updateNodes = () => {
      try {
        // 清理现有节点图层和数据源
        ["nodes", "node-labels"].forEach((layer) => {
          if (map.current.getLayer(layer)) {
            map.current.removeLayer(layer);
          }
        });
        if (map.current.getSource("nodes")) {
          map.current.removeSource("nodes");
        }

        // 如果没有节点，清理后退出
        if (nodes.length === 0) {
          console.log("无节点需要渲染，图层已清理");
          return;
        }

        // 添加节点数据源
        map.current.addSource("nodes", {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: nodes.map((node, idx) => ({
              type: "Feature",
              geometry: {
                type: "Point",
                coordinates: [node[1], node[0]],
              },
              properties: { id: idx },
            })),
          },
        });

        // 添加节点图层（圆点）
        map.current.addLayer({
          id: "nodes",
          type: "circle",
          source: "nodes",
          paint: {
            "circle-radius": 8,
            "circle-color": "#00E5FF",
          },
        });

        // 添加节点标签图层
        map.current.addLayer({
          id: "node-labels",
          type: "symbol",
          source: "nodes",
          layout: {
            "text-field": ["get", "id"],
            "text-offset": [0, 1.5],
            "text-size": 12,
          },
          paint: {
            "text-color": "#ffffff",
          },
        });
      } catch (e) {
        console.error("节点渲染失败:", e);
        setError("渲染节点失败");
      }
    };

    updateNodes();
  }, [nodes, mapLoaded]);

  useEffect(() => {
    if (!map.current || !mapLoaded || path.length <= 1) return;

    const updatePath = () => {
      try {
        if (map.current.getLayer("path")) {
          map.current.removeLayer("path");
        }
        if (map.current.getSource("path")) {
          map.current.removeSource("path");
        }

        const pathCoordinates = path.map((idx) => {
          if (idx < 0 || idx >= nodes.length || !nodes[idx]) {
            throw new Error(`无效路径索引: ${idx}`);
          }
          const [lat, lng] = nodes[idx];
          if (isNaN(lat) || isNaN(lng)) {
            throw new Error(`无效坐标在索引 ${idx}`);
          }
          return [lng, lat];
        });

        if (pathCoordinates.length > 1) {
          pathCoordinates.push(pathCoordinates[0]);
        }

        map.current.addSource("path", {
          type: "geojson",
          data: {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: pathCoordinates,
            },
          },
        });

        map.current.addLayer({
          id: "path",
          type: "line",
          source: "path",
          layout: {
            "line-join": "round",
            "line-cap": "round",
          },
          paint: {
            "line-color": "#00e676",
            "line-width": 3,
          },
        });
      } catch (e) {
        console.error("路径渲染失败:", e);
        setError(`渲染路径失败: ${e.message}`);
        setPath([]);
      }
    };

    updatePath();
  }, [path, mapLoaded, nodes]);

  const handleOptimizePath = useCallback(async () => {
    if (nodes.length < 2) {
      setError("至少需要2个节点进行路径优化");
      return;
    }

    setError(null);
    try {
      const apiInput = nodes.map(([lat, lng]) => [lng, lat]);
      const tour = await fetchOptimizedPath(apiInput);
      setPath(tour);
    } catch (e) {
      console.error("路径优化失败:", e);
      setError(e.message);
    }
  }, [nodes, fetchOptimizedPath]);

  const handleClearNodes = useCallback(() => {
    setNodes([]);
    setPath([]);
    setError(null);
    setSearchResults([]);
    if (searchControlRef.current) {
      searchControlRef.current.updateResults([]);
      searchControlRef.current.clearInput();
    }
    if (map.current && mapLoaded) {
      ["path", "nodes", "node-labels"].forEach((layer) => {
        if (map.current.getLayer(layer)) {
          map.current.removeLayer(layer);
        }
      });
      ["path", "nodes"].forEach((source) => {
        if (map.current.getSource(source)) {
          map.current.removeSource(source);
        }
      });
    }
  }, [mapLoaded]);

  useEffect(() => {
    if (searchControlRef.current && mapLoaded) {
      searchControlRef.current.updateResults(searchResults);
    }
  }, [searchResults, mapLoaded]);

  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  return (
    <div className="p-4 max-w-10xl mx-auto text-white" style={{ backgroundColor: "#1f2937" }}>
      <style>
        {`
          .spinner {
            border: 4px solid #4b5563;
            border-top: 4px solid #60a5fa;
            border-radius: 50%;
            width: 32px;
            height: 32px;
            animation: spin 1s linear infinite;
            margin: 0 auto;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          .search-control {
            pointer-events: auto;
            z-index: 10;
            padding: 10px;
          }
          #search-results {
            top: 100%;
            left: 0;
          }
        `}
      </style>
      <link
        href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css"
        rel="stylesheet"
      />
      {error && (
        <p className="text-red-400 font-semibold mb-4 bg-red-900/50 p-3 rounded-md text-center">
          错误: {error}
        </p>
      )}
      {!mapLoaded ? (
        <div className="flex justify-center mb-4">
          <div className="spinner"></div>
        </div>
      ) : (
        <p className="text-gray-300 font-medium mb-4 text-center">
          点击地图添加节点，右键节点删除。至少需要2个节点。
        </p>
      )}
      <div className="flex justify-center space-x-4 mb-4">
        <button
          className={`px-6 py-2 rounded-lg font-semibold text-white transition duration-200 ${
            mapLoaded
              ? "bg-green-600 hover:bg-green-700"
              : "bg-gray-600 cursor-not-allowed"
          }`}
          onClick={handleOptimizePath}
          disabled={!mapLoaded}
        >
          优化路径
        </button>
        <button
          className="px-6 py-2 rounded-lg font-semibold text-white bg-blue-600 hover:bg-blue-700 transition duration-200"
          onClick={handleClearNodes}
        >
          清除所有节点
        </button>
      </div>
      <div
        className="shadow-lg rounded-lg overflow-hidden bg-gray-800"
        style={{ height: "1150px", width: "100%" }}
        ref={mapContainer}
      />
    </div>
  );
};

export default TspMapbox;