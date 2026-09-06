(() => {
  'use strict';
  if (!window.maplibregl || !window.maplibregl.Map) return;

  const OriginalMap = window.maplibregl.Map;
  const LOCAL_STYLE = {
    version: 8,
    sources: {
      cartoDark: {
        type: 'raster',
        tiles: [
          'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
          'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
          'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'
        ],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors © CARTO'
      }
    },
    layers: [
      {
        id: 'dashboard-background',
        type: 'background',
        paint: { 'background-color': '#0b2334' }
      },
      {
        id: 'dashboard-basemap',
        type: 'raster',
        source: 'cartoDark',
        minzoom: 0,
        maxzoom: 20,
        paint: {
          'raster-opacity': 0.76,
          'raster-saturation': -0.28,
          'raster-contrast': 0.08,
          'raster-brightness-min': 0.08,
          'raster-brightness-max': 0.72
        }
      }
    ]
  };

  function DashboardMap(options) {
    const opts = { ...(options || {}) };
    if (typeof opts.style === 'string') {
      opts.style = LOCAL_STYLE;
    }
    return new OriginalMap(opts);
  }
  DashboardMap.prototype = OriginalMap.prototype;
  Object.setPrototypeOf(DashboardMap, OriginalMap);
  window.maplibregl.Map = DashboardMap;
  window.DASHBOARD_LOCAL_MAP_STYLE = LOCAL_STYLE;
})();
