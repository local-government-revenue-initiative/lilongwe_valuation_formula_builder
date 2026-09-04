/*
 * geo.js - which Lilongwe Area and Sector a point falls in, and parsing of
 * plot numbers. Uses the GeoJSON globals produced by data/gpkg_to_geojson.py
 * (window.LILONGWE_AREAS, window.LILONGWE_SECTORS) when present.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Geo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var layers = { areas: null, sectors: null };

  function bbox(coords) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    (function walk(c) {
      if (typeof c[0] === 'number') {
        if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1];
        if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1];
      } else c.forEach(walk);
    }(coords));
    return b;
  }

  /* Prepare a FeatureCollection: cache bounding boxes for fast lookup */
  function prepare(fc) {
    if (!fc || !fc.features) return null;
    return fc.features.map(function (f) {
      var polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      return { properties: f.properties, polys: polys, bbox: bbox(polys) };
    });
  }

  function setLayers(areasFc, sectorsFc) {
    layers.areas = prepare(areasFc);
    layers.sectors = prepare(sectorsFc);
  }

  /* Ray casting: is [lng, lat] inside a linear ring? */
  function inRing(pt, ring) {
    var x = pt[0], y = pt[1], inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      var intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function inPolygon(pt, rings) {
    if (!inRing(pt, rings[0])) return false;
    for (var h = 1; h < rings.length; h++) if (inRing(pt, rings[h])) return false;
    return true;
  }

  function inFeature(pt, feat) {
    var b = feat.bbox;
    if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) return false;
    for (var i = 0; i < feat.polys.length; i++) if (inPolygon(pt, feat.polys[i])) return true;
    return false;
  }

  function findIn(list, lat, lng) {
    if (!list) return null;
    var pt = [lng, lat];
    for (var i = 0; i < list.length; i++) if (inFeature(pt, list[i])) return list[i].properties;
    return null;
  }

  /*
   * Locate a point. Returns { areaId, areaLabel, areaLandUse, sectorKey,
   * sectorLandUse, ownership } with nulls where nothing matches.
   */
  function locate(lat, lng) {
    var out = { areaId: null, areaLabel: null, areaLandUse: null, sectorKey: null, sectorLandUse: null, ownership: null };
    if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) return out;
    var a = findIn(layers.areas, lat, lng);
    if (a) { out.areaId = a.Area_ID; out.areaLabel = a.Label_Area || ('Area ' + a.Area_ID); out.areaLandUse = a.Land_Use || null; }
    var s = findIn(layers.sectors, lat, lng);
    if (s) {
      out.sectorKey = String(s.Area_Secto); out.sectorLandUse = s.Land_Use || null; out.ownership = s.Ownership || null;
      if (out.areaId === null && s.Area_ID) { out.areaId = s.Area_ID; out.areaLabel = 'Area ' + s.Area_ID; }
    }
    return out;
  }

  /*
   * Parse a Lilongwe plot number. "46/1/232" -> area 46, sector "46/1";
   * "1/12A" -> area 1, sector "1"; anything else -> nulls.
   */
  function fromPlotNo(plotNo) {
    var out = { areaId: null, sectorKey: null };
    if (plotNo === null || plotNo === undefined) return out;
    var parts = String(plotNo).split('/').map(function (s) { return s.trim(); });
    if (parts.length < 2 || !/^\d+$/.test(parts[0])) return out;
    out.areaId = parseInt(parts[0], 10);
    out.sectorKey = (parts.length >= 3 && /^\d+$/.test(parts[1])) ? out.areaId + '/' + parts[1] : String(out.areaId);
    return out;
  }

  function sectorKeys() { return layers.sectors ? layers.sectors.map(function (f) { return String(f.properties.Area_Secto); }) : []; }
  function areaIds() { return layers.areas ? layers.areas.map(function (f) { return f.properties.Area_ID; }) : []; }
  function sectorInfo(key) {
    if (!layers.sectors) return null;
    var f = layers.sectors.find(function (x) { return String(x.properties.Area_Secto) === String(key); });
    return f ? f.properties : null;
  }
  function areaInfo(id) {
    if (!layers.areas) return null;
    var f = layers.areas.find(function (x) { return String(x.properties.Area_ID) === String(id); });
    return f ? f.properties : null;
  }

  // auto-load globals in the browser
  if (typeof self !== 'undefined' && (self.LILONGWE_AREAS || self.LILONGWE_SECTORS)) setLayers(self.LILONGWE_AREAS, self.LILONGWE_SECTORS);

  return { setLayers: setLayers, locate: locate, fromPlotNo: fromPlotNo, sectorKeys: sectorKeys, areaIds: areaIds, sectorInfo: sectorInfo, areaInfo: areaInfo, inRing: inRing };
}));
