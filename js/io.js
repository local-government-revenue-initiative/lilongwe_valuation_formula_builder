/*
 * io.js - reading CSV/XLSX property lists (via SheetJS) with column mapping,
 * and writing CSV/XLSX exports.
 */
(function (root) {
  'use strict';

  var FIELDS = [
    { key: 'plotNo', label: 'Plot / property number', patterns: [/^plot/i, /^id$/i, /property ?(no|id|number)/i, /^ref/i] },
    { key: 'description', label: 'Description', patterns: [/descr/i, /^name$/i, /property name/i] },
    { key: 'zone', label: 'Zone', patterns: [/^zone/i, /ward/i, /area name/i, /location/i] },
    { key: 'lat', label: 'Latitude', patterns: [/^lat/i, /latitude/i, /^y$/i] },
    { key: 'lng', label: 'Longitude', patterns: [/^lon/i, /^lng/i, /longitude/i, /^x$/i] },
    { key: 'builtArea_m2', label: 'Built area (m²)', patterns: [/built.?area/i, /floor.?area/i, /building.?area/i, /gfa/i, /^area/i, /surface/i] },
    { key: 'landArea_m2', label: 'Land / parcel area (m²)', patterns: [/land.?area/i, /plot.?area/i, /parcel/i, /site.?area/i, /land.?size/i] },
    { key: 'floors', label: 'Number of floors', patterns: [/floor(s)?$/i, /storey/i, /stories/i, /levels/i] },
    { key: 'areaId', label: 'LCC Area number', patterns: [/^lcc.?area/i, /^area.?(id|no|number)/i, /^area$/i] },
    { key: 'sectorKey', label: 'LCC Sector (e.g. 46/1)', patterns: [/^sector/i] },
    { key: 'totalValue', label: 'Total value (valuer sample)', patterns: [/total.?val/i, /rateable/i, /^value/i, /estimated.?val/i, /market.?val/i, /rental.?val/i, /valuer/i] },
    { key: 'notes', label: 'Notes', patterns: [/note/i, /comment/i, /remark/i] }
  ];

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        try {
          // raw: true keeps CSV cells as typed text, so plot numbers such as 7/001 are not read as dates
          var wb = root.XLSX.read(r.result, { type: 'array', raw: true, cellDates: false });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var aoa = root.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
          // drop fully empty rows
          aoa = aoa.filter(function (row) { return row.some(function (v) { return String(v).trim() !== ''; }); });
          if (!aoa.length) return reject(new Error('The file is empty.'));
          var headers = aoa[0].map(function (h, i) { var s = String(h).trim(); return s || ('Column ' + (i + 1)); });
          var rows = aoa.slice(1).map(function (row) {
            var o = {};
            headers.forEach(function (h, i) { o[h] = row[i] === undefined ? '' : String(row[i]).trim(); });
            return o;
          });
          resolve({ headers: headers, rows: rows, sheet: wb.SheetNames[0] });
        } catch (e) { reject(e); }
      };
      r.onerror = function () { reject(new Error('Could not read the file.')); };
      r.readAsArrayBuffer(file);
    });
  }

  /* Suggest a mapping from file headers to property fields */
  function guessMapping(headers) {
    var mapping = {};
    var used = {};
    FIELDS.forEach(function (f) {
      for (var i = 0; i < headers.length; i++) {
        var h = headers[i];
        if (used[h]) continue;
        if (f.patterns.some(function (re) { return re.test(h); })) { mapping[f.key] = h; used[h] = true; break; }
      }
    });
    return mapping;
  }

  function detectType(values) {
    var nonEmpty = values.filter(function (v) { return v !== '' && v !== null && v !== undefined; });
    if (!nonEmpty.length) return 'categorical';
    var allNum = nonEmpty.every(function (v) { return root.Engine.toNumber(v) !== null; });
    var allBool = nonEmpty.every(function (v) { return root.Engine.parseBoolean(v) !== null; });
    var distinct = {};
    nonEmpty.forEach(function (v) { distinct[String(v)] = true; });
    var nd = Object.keys(distinct).length;
    if (allBool && nd <= 2 && !nonEmpty.every(function (v) { return /^\d+$/.test(String(v)) && Number(v) > 1; })) return 'boolean';
    if (allNum && nd > 2) return 'numeric';
    return 'categorical';
  }

  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'feature'; }

  /*
   * Build properties from parsed rows.
   *   mapping: { fieldKey: header }
   *   extraColumns: [{ header, type, appliesTo }] to import as characteristics
   *   existingFeatures: current feature list (matched by name, case-insensitive)
   * Returns { properties, features (new ones only), warnings }
   */
  function applyMapping(parsed, mapping, extraColumns, existingFeatures) {
    var E = root.Engine;
    var newFeatures = [];
    var featureByHeader = {};
    var warnings = [];
    (extraColumns || []).forEach(function (col) {
      var existing = (existingFeatures || []).find(function (f) { return f.name.toLowerCase() === col.header.toLowerCase(); });
      if (existing) { featureByHeader[col.header] = existing; return; }
      var id = slug(col.header);
      var n = 1;
      while ((existingFeatures || []).concat(newFeatures).some(function (f) { return f.id === id; })) id = slug(col.header) + '_' + (++n);
      var f = { id: id, name: col.header, type: col.type, appliesTo: 'improvement', categories: [], baseCategory: null, isCondition: /condition|state of repair|quality/i.test(col.header) };
      if (col.type === 'categorical') {
        var cats = {};
        parsed.rows.forEach(function (r) { var v = r[col.header]; if (v !== '') cats[v] = true; });
        f.categories = Object.keys(cats).sort();
      }
      newFeatures.push(f);
      featureByHeader[col.header] = f;
    });
    var properties = parsed.rows.map(function (r, i) {
      var p = {
        id: 'p_' + Date.now().toString(36) + '_' + i.toString(36) + Math.random().toString(36).slice(2, 6),
        plotNo: '', description: '', zone: '', lat: null, lng: null,
        roofPolygons: [], builtArea_m2: null, builtAreaSource: null, floors: null,
        parcelPolygon: null, landArea_m2: null, landAreaSource: null,
        areaId: null, sectorKey: null, locationSource: null, landRateOverride: null,
        totalValue: null,
        characteristics: {}, photoIds: [], notes: ''
      };
      function get(key) { var h = mapping[key]; return h ? r[h] : ''; }
      p.plotNo = get('plotNo') || ('Row ' + (i + 2));
      p.description = get('description');
      p.zone = get('zone');
      p.notes = get('notes');
      p.lat = E.toNumber(get('lat')); p.lng = E.toNumber(get('lng'));
      if (p.lat !== null && (p.lat < -90 || p.lat > 90)) { p.lat = null; warnings.push(p.plotNo + ': latitude out of range, ignored'); }
      if (p.lng !== null && (p.lng < -180 || p.lng > 180)) { p.lng = null; warnings.push(p.plotNo + ': longitude out of range, ignored'); }
      p.builtArea_m2 = E.toNumber(get('builtArea_m2')); if (p.builtArea_m2 !== null) p.builtAreaSource = 'imported';
      p.landArea_m2 = E.toNumber(get('landArea_m2')); if (p.landArea_m2 !== null) p.landAreaSource = 'imported';
      p.floors = E.toNumber(get('floors'));
      p.totalValue = E.toNumber(get('totalValue'));
      var aid = get('areaId'); var aidNum = E.toNumber(String(aid).replace(/^area\s*/i, ''));
      if (aidNum !== null) { p.areaId = Math.round(aidNum); p.locationSource = 'imported'; }
      var sk = String(get('sectorKey') || '').trim();
      if (sk) { p.sectorKey = sk; if (p.areaId === null) { var m = sk.match(/^(\d+)/); if (m) p.areaId = parseInt(m[1], 10); } p.locationSource = 'imported'; }
      Object.keys(featureByHeader).forEach(function (h) {
        var f = featureByHeader[h];
        var v = r[h];
        if (v === '' || v === undefined) return;
        if (f.type === 'boolean') { var b = E.parseBoolean(v); if (b !== null) p.characteristics[f.id] = b ? 'Yes' : 'No'; }
        else if (f.type === 'numeric') { var num = E.toNumber(v); if (num !== null) p.characteristics[f.id] = num; }
        else { p.characteristics[f.id] = String(v); if (f.categories.indexOf(String(v)) < 0) f.categories.push(String(v)); }
      });
      return p;
    });
    return { properties: properties, features: newFeatures, warnings: warnings };
  }

  function toSheet(rows, headers) {
    var aoa = [headers].concat(rows.map(function (r) { return headers.map(function (h) { return r[h] === undefined || r[h] === null ? '' : r[h]; }); }));
    return root.XLSX.utils.aoa_to_sheet(aoa);
  }

  function downloadTable(filename, rows, headers, format) {
    var ws = toSheet(rows, headers);
    var wb = root.XLSX.utils.book_new();
    root.XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    root.XLSX.writeFile(wb, filename, { bookType: format === 'xlsx' ? 'xlsx' : 'csv' });
  }

  function downloadWorkbook(filename, sheets) {
    var wb = root.XLSX.utils.book_new();
    sheets.forEach(function (s) { root.XLSX.utils.book_append_sheet(wb, toSheet(s.rows, s.headers), s.name.slice(0, 31)); });
    root.XLSX.writeFile(wb, filename, { bookType: 'xlsx' });
  }

  /*
   * Parse a land-rate schedule file: columns Area (or Sector), Rate, Source, Note.
   * Returns { level, entries: { key: { rate, source, note } }, skipped }
   */
  function parseRates(parsed) {
    var E = root.Engine;
    var h = parsed.headers;
    function find(res) { for (var i = 0; i < h.length; i++) if (res.some(function (re) { return re.test(h[i]); })) return h[i]; return null; }
    var keyCol = find([/^sector/i]) ? find([/^sector/i]) : find([/^area/i, /^key/i, /^zone/i]);
    var level = /^sector/i.test(keyCol || '') ? 'sector' : 'area';
    var rateCol = find([/rate/i, /per.?m/i, /value/i]);
    var srcCol = find([/source/i]);
    var noteCol = find([/note/i, /comment/i]);
    if (!keyCol || !rateCol) throw new Error('The file needs an Area (or Sector) column and a Rate column.');
    var entries = {}, skipped = 0;
    parsed.rows.forEach(function (r) {
      var key = String(r[keyCol] || '').trim().replace(/^area\s*/i, '').replace(/^sector\s*/i, '');
      var rate = E.toNumber(r[rateCol]);
      if (!key || rate === null) { skipped++; return; }
      entries[key] = { rate: rate, source: srcCol ? String(r[srcCol] || '') : 'imported', note: noteCol ? String(r[noteCol] || '') : '' };
    });
    return { level: level, entries: entries, skipped: skipped };
  }

  root.IO = { FIELDS: FIELDS, readFile: readFile, guessMapping: guessMapping, detectType: detectType, applyMapping: applyMapping, parseRates: parseRates, downloadTable: downloadTable, downloadWorkbook: downloadWorkbook };
}(typeof self !== 'undefined' ? self : this));
