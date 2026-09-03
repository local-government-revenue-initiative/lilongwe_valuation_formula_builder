/*
 * mapping.js - Leaflet map: locate a property with a pin, trace rooftop(s) and
 * the parcel boundary, and measure their areas geodesically (m²).
 */
(function (root) {
  'use strict';

  var L = root.L;
  var map = null, layers = {}, drawControl = null, currentTool = null, handlers = {};
  var editableGroup = null, othersGroup = null, currentPropertyId = null;

  var STYLE = {
    roof: { color: '#d9480f', weight: 2, fillColor: '#ffa94d', fillOpacity: 0.35 },
    parcel: { color: '#1864ab', weight: 2, dashArray: '6 4', fillColor: '#74c0fc', fillOpacity: 0.15 }
  };

  function init(containerId, opts) {
    handlers = opts || {};
    map = L.map(containerId, { center: [-13.9626, 33.7741], zoom: 13, zoomControl: true });
    var esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community'
    });
    var osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
    esri.addTo(map);
    L.control.layers({ 'Satellite (Esri)': esri, 'Streets (OpenStreetMap)': osm }, null, { position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);

    editableGroup = new L.FeatureGroup().addTo(map);
    othersGroup = new L.FeatureGroup().addTo(map);

    drawControl = new L.Control.Draw({
      position: 'topleft',
      draw: false,
      edit: { featureGroup: editableGroup, remove: true }
    });
    map.addControl(drawControl);

    map.on(L.Draw.Event.CREATED, function (e) {
      var tool = currentTool;
      currentTool = null;
      if (tool === 'pin') {
        var ll = e.layer.getLatLng();
        if (handlers.onPin) handlers.onPin(ll.lat, ll.lng);
      } else if (tool === 'roof' || tool === 'parcel') {
        var gj = e.layer.toGeoJSON();
        var area = polygonArea(e.layer);
        if (handlers.onPolygon) handlers.onPolygon(tool, gj.geometry, area);
      }
    });
    map.on(L.Draw.Event.EDITED, function (e) {
      var changes = [];
      e.layers.eachLayer(function (layer) {
        if (layer._vtype === 'roof' || layer._vtype === 'parcel') changes.push({ type: layer._vtype, index: layer._vindex, geometry: layer.toGeoJSON().geometry, area: polygonArea(layer) });
        else if (layer._vtype === 'pin') { var ll = layer.getLatLng(); changes.push({ type: 'pin', lat: ll.lat, lng: ll.lng }); }
      });
      if (handlers.onEdited) handlers.onEdited(changes);
    });
    map.on(L.Draw.Event.DELETED, function (e) {
      var removed = [];
      e.layers.eachLayer(function (layer) { removed.push({ type: layer._vtype, index: layer._vindex }); });
      if (handlers.onDeleted) handlers.onDeleted(removed);
    });
    map.on('click', function (e) {
      if (currentTool === 'pinclick') { currentTool = null; if (handlers.onPin) handlers.onPin(e.latlng.lat, e.latlng.lng); }
    });
    return map;
  }

  function polygonArea(layer) {
    var latlngs = layer.getLatLngs();
    if (Array.isArray(latlngs[0])) latlngs = latlngs[0];
    return Math.abs(L.GeometryUtil.geodesicArea(latlngs));
  }

  function geometryArea(geometry) {
    if (!geometry || geometry.type !== 'Polygon') return null;
    var latlngs = geometry.coordinates[0].map(function (c) { return L.latLng(c[1], c[0]); });
    return Math.abs(L.GeometryUtil.geodesicArea(latlngs));
  }

  function startTool(tool) {
    if (!map) return;
    cancelTool();
    currentTool = tool;
    var handler;
    if (tool === 'pin') handler = new L.Draw.Marker(map, {});
    else handler = new L.Draw.Polygon(map, { allowIntersection: false, showArea: true, metric: true, shapeOptions: STYLE[tool] });
    handler.enable();
    map._activeDrawHandler = handler;
  }

  function cancelTool() {
    if (map && map._activeDrawHandler) { try { map._activeDrawHandler.disable(); } catch (e) { /* ignore */ } map._activeDrawHandler = null; }
    currentTool = null;
  }

  /* Render one property's own geometry (editable) and other pins (clickable) */
  function render(properties, current) {
    if (!map) return;
    editableGroup.clearLayers();
    othersGroup.clearLayers();
    currentPropertyId = current ? current.id : null;
    properties.forEach(function (p) {
      if (p.lat === null || p.lng === null || p.lat === undefined || p.lng === undefined) return;
      if (current && p.id === current.id) return;
      var m = L.circleMarker([p.lat, p.lng], { radius: 6, color: '#495057', fillColor: hasSample(p) ? '#2b8a3e' : '#ffffff', fillOpacity: 0.9, weight: 1.5 });
      m.bindTooltip((p.plotNo || '') + (p.description ? ' – ' + p.description : ''));
      m.on('click', function () { if (handlers.onSelect) handlers.onSelect(p.id); });
      othersGroup.addLayer(m);
    });
    if (current) {
      if (current.lat !== null && current.lng !== null && current.lat !== undefined && current.lng !== undefined) {
        var pin = L.marker([current.lat, current.lng], { draggable: false });
        pin._vtype = 'pin';
        pin.bindTooltip((current.plotNo || '') + ' (selected)');
        editableGroup.addLayer(pin);
      }
      (current.roofPolygons || []).forEach(function (rp, i) {
        if (!rp.geometry) return;
        var layer = L.geoJSON(rp.geometry, { style: STYLE.roof }).getLayers()[0];
        layer._vtype = 'roof'; layer._vindex = i;
        layer.bindTooltip('Rooftop ' + (i + 1) + ': ' + Math.round(rp.area_m2) + ' m² × ' + (rp.floors || 1) + ' floor(s)');
        editableGroup.addLayer(layer);
      });
      if (current.parcelPolygon && current.parcelPolygon.geometry) {
        var pl = L.geoJSON(current.parcelPolygon.geometry, { style: STYLE.parcel }).getLayers()[0];
        pl._vtype = 'parcel'; pl._vindex = 0;
        pl.bindTooltip('Parcel: ' + Math.round(current.parcelPolygon.area_m2) + ' m²');
        editableGroup.addLayer(pl);
      }
    }
  }

  function hasSample(p) { return (p.landValue !== null && p.landValue !== undefined) || (p.improvementValue !== null && p.improvementValue !== undefined); }

  function focus(p) {
    if (!map || !p) return;
    var b = editableGroup.getBounds();
    if (b.isValid() && (p.roofPolygons && p.roofPolygons.length || p.parcelPolygon)) map.fitBounds(b.pad(0.5), { maxZoom: 19 });
    else if (p.lat !== null && p.lng !== null && p.lat !== undefined && p.lng !== undefined) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 18));
  }

  function fitAll(properties) {
    if (!map) return;
    var pts = properties.filter(function (p) { return p.lat !== null && p.lng !== null && p.lat !== undefined && p.lng !== undefined; }).map(function (p) { return [p.lat, p.lng]; });
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 17 });
  }

  function invalidate() { if (map) setTimeout(function () { map.invalidateSize(); }, 50); }

  function locateDevice() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('Geolocation is not available in this browser.'));
      navigator.geolocation.getCurrentPosition(function (pos) { resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }); },
        function (err) { reject(new Error(err.message || 'Could not get device location.')); }, { enableHighAccuracy: true, timeout: 15000 });
    });
  }

  root.Mapping = { init: init, render: render, focus: focus, fitAll: fitAll, startTool: startTool, cancelTool: cancelTool, invalidate: invalidate, geometryArea: geometryArea, locateDevice: locateDevice, currentTool: function () { return currentTool; }, map: function () { return map; } };
}(typeof self !== 'undefined' ? self : this));
