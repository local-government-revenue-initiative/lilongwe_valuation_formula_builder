/*
 * app.js - user interface and application state for the Lilongwe Property
 * Valuation Tool. Plain DOM, no framework, no build step.
 *
 * Valuation method (see js/valuation.js): land = rate × parcel area from the
 * land-rate schedule; improvements from a regression fitted on the residual
 * (valuer's total value − land value) of the sample properties.
 */
(function () {
  'use strict';

  var PROJECT_VERSION = 2;
  var MAX_ROWS = 500;
  var AREA_LABEL = 'Built area (m²)';

  var state = { project: null, selectedId: null, filter: '', saveTimer: null, pendingImport: null, photoUrls: {}, currentTab: 'properties', chartLog: true };

  /* ------------------------------------------------------------------ */
  /* Project model                                                       */
  /* ------------------------------------------------------------------ */

  function newModelSpec() { return { form: 'loglinear', smearing: false, included: {}, locks: {}, bases: {}, fit: null, fittedAt: null }; }

  function newProject() {
    return {
      version: PROJECT_VERSION, name: 'Council estates pilot', currency: 'MWK', valueBasis: 'capital', mode: 'simple',
      valuer: { name: '', registration: '', valuationDate: '', validityMonths: 12 },
      features: [], properties: [], landRates: Valuation.defaultSchedule(window.LAND_RATES_DEFAULT || null), model: newModelSpec(), savedModels: [],
      createdAt: new Date().toISOString()
    };
  }

  function newProperty() {
    return {
      id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      plotNo: '', description: '', zone: '', lat: null, lng: null, areaId: null, sectorKey: null, locationSource: null,
      roofPolygons: [], builtArea_m2: null, builtAreaSource: null, floors: null,
      parcelPolygon: null, landArea_m2: null, landAreaSource: null,
      totalValue: null, landRateOverride: null, landRateOverrideNote: '',
      characteristics: {}, photoIds: [], notes: ''
    };
  }

  function upgradeProject(p) {
    p = Valuation.migrateProject(p, window.LAND_RATES_DEFAULT || null);
    p.model = Object.assign(newModelSpec(), p.model || {});
    p.features = p.features || [];
    p.properties = (p.properties || []).map(function (x) { return Object.assign(newProperty(), x); });
    p.currency = p.currency || 'MWK';
    p.valueBasis = p.valueBasis || 'capital';
    return p;
  }

  function findProperty(id) { return state.project.properties.find(function (p) { return p.id === id; }) || null; }
  function selected() { return state.selectedId ? findProperty(state.selectedId) : null; }

  var SUGGESTED_FEATURES = [
    { id: 'structure_type', name: 'Structure type', type: 'categorical', categories: ['Dwelling', 'Shop / office', 'Market / warehouse / industrial', 'Institutional', 'Other'], baseCategory: 'Dwelling' },
    { id: 'wall_material', name: 'Wall material', type: 'categorical', categories: ['Masonry / burnt brick / block', 'Mud / unburnt brick', 'Wood', 'Metal sheet / other'], baseCategory: 'Masonry / burnt brick / block' },
    { id: 'roof_material', name: 'Roof material', type: 'categorical', categories: ['Concrete / tile', 'Iron sheet', 'Asbestos', 'Thatch / other'], baseCategory: 'Iron sheet' },
    { id: 'windows', name: 'Windows (dominant type)', type: 'categorical', categories: ['Aluminium sliding / high value', 'Glazed casement / louvre', 'None / breeze block / wood'], baseCategory: 'Glazed casement / louvre' },
    { id: 'street_paved', name: 'Street paved', type: 'boolean' },
    { id: 'wall_condition', name: 'Wall condition', type: 'categorical', categories: ['Good', 'Average', 'Bad'], baseCategory: 'Average', isCondition: true },
    { id: 'fence', name: 'Permanent fence', type: 'boolean' },
    { id: 'security', name: 'Security features (guard post, wall, wire)', type: 'boolean' }
  ];

  /* ------------------------------------------------------------------ */
  /* Utilities                                                           */
  /* ------------------------------------------------------------------ */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (children || []).forEach(function (c) { if (c === null || c === undefined) return; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function numOrNull(v) { return Engine.toNumber(v); }
  function fmt(x, d) { return Formula.fmtNum(x, d); }
  function money(x) { return Formula.fmtMoney(x, state.project.currency); }
  function isAdvanced() { return state.project.mode === 'advanced'; }

  var toastTimer = null;
  function toast(msg, isError) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false; t.className = isError ? 'error' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 7000 : 3500);
  }

  function save() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () { Storage.saveProject(state.project); $('#footer-status').textContent = 'Saved in this browser at ' + new Date().toLocaleTimeString('en-GB'); }, 400);
  }

  /* Anything that changes land values or samples changes the fitted model */
  function markDirty(refit) {
    save();
    if (refit) fitModel(true);
  }

  /* ------------------------------------------------------------------ */
  /* Characteristics, location and model                                 */
  /* ------------------------------------------------------------------ */

  function charsFor(p) {
    var chars = p.characteristics || {};
    var derived = state.project.features.filter(function (f) { return f.source === 'zone' || f.source === 'landuse'; });
    if (!derived.length) return chars;
    chars = Object.assign({}, chars);
    derived.forEach(function (f) {
      var v = null;
      if (f.source === 'zone') v = p.zone ? String(p.zone).trim() : null;
      else if (f.source === 'landuse') { var s = p.sectorKey ? Geo.sectorInfo(p.sectorKey) : null; v = s && s.Land_Use ? s.Land_Use : null; if (!v && p.areaId !== null) { var a = Geo.areaInfo(p.areaId); v = a && a.Land_Use ? a.Land_Use : null; } }
      if (v) chars[f.id] = v; else delete chars[f.id];
    });
    return chars;
  }

  function landUseCategories() {
    var cats = {};
    Geo.sectorKeys().forEach(function (k) { var s = Geo.sectorInfo(k); if (s && s.Land_Use) cats[s.Land_Use] = true; });
    Geo.areaIds().forEach(function (k) { var a = Geo.areaInfo(k); if (a && a.Land_Use) cats[a.Land_Use] = true; });
    return Object.keys(cats).sort();
  }

  /* Assign Area/Sector from the map position, else from the plot number. */
  function locateProperty(p, force) {
    if (!force && p.locationSource === 'manual') return false;
    var before = p.areaId + '|' + p.sectorKey;
    if (numOrNull(p.lat) !== null && numOrNull(p.lng) !== null) {
      var loc = Geo.locate(p.lat, p.lng);
      if (loc.areaId !== null) { p.areaId = loc.areaId; p.sectorKey = loc.sectorKey; p.locationSource = 'map'; return before !== p.areaId + '|' + p.sectorKey; }
    }
    var pk = Geo.fromPlotNo(p.plotNo);
    if (pk.areaId !== null && Geo.areaInfo(pk.areaId)) {
      p.areaId = pk.areaId;
      p.sectorKey = Geo.sectorInfo(pk.sectorKey) ? pk.sectorKey : (Geo.sectorInfo(String(pk.areaId)) ? String(pk.areaId) : null);
      p.locationSource = 'plot';
      return before !== p.areaId + '|' + p.sectorKey;
    }
    return false;
  }

  function locateAll(force) {
    var n = 0;
    state.project.properties.forEach(function (p) { if (locateProperty(p, force)) n++; });
    return n;
  }

  function buildSpec(formOverride) {
    var spec = state.project.model;
    var form = formOverride || spec.form;
    var prep = Valuation.modelRows(state.project, charsFor);
    var rows = prep.rows.filter(function (r) { return r.value !== null; });
    var feats = Valuation.modelFeatures(state.project).map(function (f) { return Object.assign({}, f, { baseCategory: spec.bases[f.id] || f.baseCategory || null }); });
    var columns = Engine.buildColumns(form, feats, rows, AREA_LABEL);
    var locks = {};
    Object.keys(spec.locks).forEach(function (key) {
      var col = columns.find(function (c) { return c.key === key; });
      if (!col) return;
      if (formOverride && formOverride !== spec.form && (col.kind === 'area' || col.kind === 'intercept' || col.kind === 'numeric')) return;
      var coef = Engine.displayToCoef(form, col, spec.locks[key]);
      if (coef !== null) locks[key] = coef;
    });
    return { form: form, columns: columns, included: spec.included, locks: locks, smearing: spec.smearing && form !== 'linear', rows: rows, prep: prep };
  }

  function fitModel(silent) {
    var spec = state.project.model;
    var s = buildSpec();
    var fit = Engine.fit(s, s.rows);
    fit.residualIssues = s.prep.issues;
    fit.warnings = (s.prep.warnings || []).concat(fit.warnings || []);
    spec.fit = fit;
    spec.fittedAt = new Date().toISOString();
    if (!silent) toast(fit.ok ? 'Model fitted on ' + fit.n + ' sample properties.' : 'Nothing to fit yet: enter total values for sample properties.', !fit.ok);
    save();
    renderModel();
    renderResults();
    return fit;
  }

  function modelForPrediction() {
    var f = state.project.model.fit;
    if (!f || !f.ok) return null;
    return { form: f.form, columns: f.columns, coef: f.coef, smearing: f.smearing };
  }

  function valueOf(p) { return Valuation.valueProperty(state.project, p, modelForPrediction(), charsFor); }

  /* ---- charts: valuer's building value vs the formula ---- */

  function plotLabel(id) { var p = findProperty(id); return p ? (p.plotNo || id) : id; }

  function scaleToggle(onChange) {
    var t = el('div', { class: 'mode-toggle', id: 'chart-scale' }, [
      el('button', { type: 'button', 'data-scale': 'log', class: state.chartLog ? 'on' : '', text: 'Log axes' }),
      el('button', { type: 'button', 'data-scale': 'linear', class: state.chartLog ? '' : 'on', text: 'Linear axes' })
    ]);
    $all('button', t).forEach(function (b) { b.addEventListener('click', function () { state.chartLog = b.getAttribute('data-scale') === 'log'; onChange(); }); });
    return t;
  }

  function fitChart(fit, opts) {
    var pts = Charts.fitPoints(fit, plotLabel);
    var res = Charts.scatter(Object.assign({ points: pts, log: state.chartLog, xLabel: 'Valuer\'s building value (total − land)', yLabel: 'Formula building value' }, opts || {}));
    var box = el('div', { class: 'chart' + (opts && opts.compact ? ' small' : '') }, [res.svg]);
    if (res.skipped) box.appendChild(el('p', { class: 'help', text: res.skipped + ' point(s) not shown on log axes because a value is zero or negative.' }));
    return box;
  }

  function chartSubtitle(fit) { return fit && fit.ok ? 'n ' + fit.n + ' · RMSE ' + Charts.compact(fit.rmse) + ' · COD ' + fmt(fit.cod, 0) + ' %' : ''; }

  /* ------------------------------------------------------------------ */
  /* Properties tab                                                      */
  /* ------------------------------------------------------------------ */

  function isSample(p) { return numOrNull(p.totalValue) !== null; }
  function areaText(p) { return p.areaId !== null && p.areaId !== undefined ? 'Area ' + p.areaId + (p.sectorKey && p.sectorKey !== String(p.areaId) ? ' · ' + p.sectorKey : '') : ''; }

  function filteredProperties() {
    var q = state.filter.trim().toLowerCase();
    if (!q) return state.project.properties;
    return state.project.properties.filter(function (p) {
      return [p.plotNo, p.description, p.zone, p.notes, areaText(p)].some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
    });
  }

  function renderProperties() {
    var tbody = $('#property-table tbody');
    tbody.innerHTML = '';
    var list = filteredProperties();
    list.slice(0, MAX_ROWS).forEach(function (p) {
      tbody.appendChild(el('tr', { class: 'selectable' + (p.id === state.selectedId ? ' selected' : ''), 'data-id': p.id, onclick: function () { selectProperty(p.id); } }, [
        el('td', { text: p.plotNo || '' }),
        el('td', { text: p.description || '' }),
        el('td', { text: areaText(p) }),
        el('td', { class: 'num', text: fmt(p.builtArea_m2, 0) }),
        el('td', { class: 'num', text: fmt(p.landArea_m2, 0) }),
        el('td', { class: 'num', text: fmt(p.totalValue, 0) }),
        el('td', { text: (p.lat !== null && p.lng !== null) ? '●' : '' })
      ]));
    });
    var n = state.project.properties.length, s = state.project.properties.filter(isSample).length;
    $('#property-count').textContent = n + ' properties, ' + s + ' with a valuer total' + (list.length > MAX_ROWS ? ' (showing first ' + MAX_ROWS + ' of ' + list.length + ')' : '');
  }

  function selectProperty(id) {
    state.selectedId = id;
    Mapping.cancelTool();
    $all('#property-table tbody tr').forEach(function (tr) { tr.classList.toggle('selected', tr.getAttribute('data-id') === id); });
    renderDetail();
    var p = selected();
    Mapping.render(state.project.properties, p);
    if (p) Mapping.focus(p);
  }

  function tracedBuiltArea(p) {
    var t = 0, any = false;
    (p.roofPolygons || []).forEach(function (r) { if (numOrNull(r.area_m2) !== null) { t += r.area_m2 * (numOrNull(r.floors) || 1); any = true; } });
    return any ? t : null;
  }

  function syncAreas(p) {
    var traced = tracedBuiltArea(p);
    if (p.builtAreaSource === 'traced' || (p.builtAreaSource === null && traced !== null)) { p.builtArea_m2 = traced; p.builtAreaSource = traced === null ? null : 'traced'; }
    var land = p.parcelPolygon && numOrNull(p.parcelPolygon.area_m2) !== null ? p.parcelPolygon.area_m2 : null;
    if (p.landAreaSource === 'traced' || (p.landAreaSource === null && land !== null)) { p.landArea_m2 = land; p.landAreaSource = land === null ? null : 'traced'; }
  }

  function field(labelText, input, cls) { return el('label', { class: cls || null }, [labelText, input]); }

  function textInput(p, key, opts) {
    opts = opts || {};
    return el('input', {
      type: opts.type || 'text', value: p[key] === null || p[key] === undefined ? '' : p[key], step: opts.step, placeholder: opts.placeholder,
      onchange: function (e) { p[key] = opts.numeric ? numOrNull(e.target.value) : e.target.value; if (opts.after) opts.after(); markDirty(opts.refit); renderProperties(); }
    });
  }

  function renderDetail() {
    var box = $('#property-detail');
    var p = selected();
    box.innerHTML = '';
    if (!p) { box.appendChild(el('p', { class: 'help', text: 'Select a property in the list, add one, or import a file.' })); return; }
    var proj = state.project;

    // identity and location
    var areaSel = el('select', { onchange: function (e) {
      p.areaId = e.target.value === '' ? null : parseInt(e.target.value, 10); p.sectorKey = null; p.locationSource = 'manual'; markDirty(true); renderDetail(); renderProperties();
    } }, [el('option', { value: '', text: '– not set –' })].concat(Geo.areaIds().slice().sort(function (a, b) { return a - b; }).map(function (id) { return el('option', { value: id, text: 'Area ' + id }); })));
    areaSel.value = p.areaId === null || p.areaId === undefined ? '' : String(p.areaId);
    var sectorOpts = Geo.sectorKeys().filter(function (k) { return p.areaId !== null && k.split('/')[0] === String(p.areaId); });
    var sectorSel = el('select', { disabled: !sectorOpts.length, onchange: function (e) { p.sectorKey = e.target.value || null; p.locationSource = 'manual'; markDirty(true); renderDetail(); } },
      [el('option', { value: '', text: sectorOpts.length ? '– not set –' : '(no sectors)' })].concat(sectorOpts.map(function (k) { var s = Geo.sectorInfo(k); return el('option', { value: k, text: k + (s && s.Land_Use ? ' · ' + s.Land_Use : '') }); })));
    sectorSel.value = p.sectorKey || '';
    box.appendChild(el('div', { class: 'grid' }, [
      field('Plot / property no.', textInput(p, 'plotNo', { after: function () { locateProperty(p, false); } })),
      field('Description', textInput(p, 'description')),
      field('Latitude', textInput(p, 'lat', { type: 'number', step: 'any', numeric: true, refit: true, after: function () { locateProperty(p, false); Mapping.render(proj.properties, p); } })),
      field('Longitude', textInput(p, 'lng', { type: 'number', step: 'any', numeric: true, refit: true, after: function () { locateProperty(p, false); Mapping.render(proj.properties, p); } })),
      field('LCC Area', areaSel),
      field('Sector', sectorSel)
    ]));
    box.appendChild(el('p', { class: 'help' }, [
      p.locationSource ? el('span', { class: 'source-tag', text: 'area from ' + p.locationSource }) : el('span', { class: 'source-tag', text: 'area not set' }),
      ' ', p.sectorKey && Geo.sectorInfo(p.sectorKey) ? (function () { var s = Geo.sectorInfo(p.sectorKey); return 'Sector land use: ' + (s.Land_Use || '–') + (s.Ownership ? '; land owner (map): ' + s.Ownership : ''); }()) : 'Drop a pin on the map to detect the Area and Sector automatically.'
    ]));

    // building(s)
    var traced = tracedBuiltArea(p);
    var roofList = el('div');
    (p.roofPolygons || []).forEach(function (r, i) {
      roofList.appendChild(el('div', { class: 'inline' }, [
        el('span', { text: 'Rooftop ' + (i + 1) + ': ' + fmt(r.area_m2, 1) + ' m² × ' }),
        el('input', { type: 'number', class: 'short', min: 1, step: 1, value: r.floors || 1, onchange: function (e) { r.floors = Math.max(1, numOrNull(e.target.value) || 1); syncAreas(p); markDirty(true); renderDetail(); renderProperties(); Mapping.render(proj.properties, p); } }),
        el('span', { text: ' floor(s) = ' + fmt(r.area_m2 * (r.floors || 1), 1) + ' m²' }),
        el('button', { type: 'button', class: 'btn tiny danger', text: 'remove', onclick: function () { p.roofPolygons.splice(i, 1); syncAreas(p); markDirty(true); renderDetail(); renderProperties(); Mapping.render(proj.properties, p); } })
      ]));
    });
    if (!(p.roofPolygons || []).length) roofList.appendChild(el('p', { class: 'help', text: 'No rooftop traced. Use "Trace rooftop" on the map (one shape per building), then set the floors.' }));
    var builtInput = el('input', { type: 'number', step: 'any', min: 0, value: p.builtArea_m2 === null ? '' : p.builtArea_m2, onchange: function (e) {
      p.builtArea_m2 = numOrNull(e.target.value); p.builtAreaSource = p.builtArea_m2 === null ? null : 'manual'; markDirty(true); renderDetail(); renderProperties();
    } });
    box.appendChild(el('fieldset', null, [el('legend', { text: 'Building(s) and built area' }), roofList,
      el('div', { class: 'inline' }, [field('Built area (m²)', builtInput), el('span', { class: 'source-tag', text: p.builtAreaSource ? 'source: ' + p.builtAreaSource : 'not set' }),
        traced !== null && p.builtAreaSource !== 'traced' ? el('button', { type: 'button', class: 'btn tiny', text: 'use traced (' + fmt(traced, 1) + ' m²)', onclick: function () { p.builtAreaSource = 'traced'; syncAreas(p); markDirty(true); renderDetail(); renderProperties(); } }) : null])]));

    // land
    var parcelInfo = p.parcelPolygon ? el('div', { class: 'inline' }, [
      el('span', { text: 'Parcel traced: ' + fmt(p.parcelPolygon.area_m2, 1) + ' m²' }),
      el('button', { type: 'button', class: 'btn tiny danger', text: 'remove', onclick: function () { p.parcelPolygon = null; syncAreas(p); markDirty(true); renderDetail(); renderProperties(); Mapping.render(proj.properties, p); } })
    ]) : el('p', { class: 'help', text: 'No parcel traced. Use "Trace parcel" on the map, or type the area.' });
    var landInput = el('input', { type: 'number', step: 'any', min: 0, value: p.landArea_m2 === null ? '' : p.landArea_m2, onchange: function (e) {
      p.landArea_m2 = numOrNull(e.target.value); p.landAreaSource = p.landArea_m2 === null ? null : 'manual'; markDirty(true); renderDetail(); renderProperties();
    } });
    var lv = Valuation.landValueFor(proj, p);
    var landLine = el('p', { class: 'help' }, [
      'Land value: ', el('b', { text: lv.value === null ? '–' : money(lv.value) }), ' = ' + money(lv.rateInfo.rate) + ' per m² (' + lv.rateInfo.label + (lv.rateInfo.basis === 'default' ? ', default rate' : '') + ') × ' + fmt(lv.landArea, 1) + ' m²'
    ]);
    var landFields = [field('Land area (m²)', landInput), el('span', { class: 'source-tag', text: p.landAreaSource ? 'source: ' + p.landAreaSource : 'not set' }),
      p.parcelPolygon && p.landAreaSource !== 'traced' ? el('button', { type: 'button', class: 'btn tiny', text: 'use traced (' + fmt(p.parcelPolygon.area_m2, 1) + ' m²)', onclick: function () { p.landAreaSource = 'traced'; syncAreas(p); markDirty(true); renderDetail(); renderProperties(); } }) : null];
    if (isAdvanced()) landFields.push(field('Rate override (per m², optional)', el('input', { type: 'number', step: 'any', min: 0, value: p.landRateOverride === null ? '' : p.landRateOverride, onchange: function (e) { p.landRateOverride = numOrNull(e.target.value); markDirty(true); renderDetail(); } })));
    box.appendChild(el('fieldset', null, [el('legend', { text: 'Land parcel' }), parcelInfo, el('div', { class: 'inline' }, landFields), landLine]));

    // valuer total
    var basis = proj.valueBasis === 'annual_rental' ? 'annual rental value' : 'capital value';
    box.appendChild(el('fieldset', null, [el('legend', { text: 'Valuer\'s total value (' + proj.currency + ', ' + basis + ') – sample properties only' }),
      el('div', { class: 'grid' }, [field('Total value of land and buildings', textInput(p, 'totalValue', { type: 'number', step: 'any', numeric: true, refit: true }), 'big-field')]),
      el('p', { class: 'help', text: 'Leave blank for properties the valuer has not assessed. The building value the model learns from is this total minus the land value above.' })]));

    // characteristics
    var charBox = el('div', { class: 'grid' });
    var feats = Valuation.modelFeatures(proj);
    if (!feats.length) charBox.appendChild(el('p', { class: 'help', text: isAdvanced() ? 'No characteristics defined (Characteristics tab).' : 'No characteristics yet. Import a file with characteristic columns, or switch to Advanced to add some.' }));
    feats.forEach(function (f) {
      if (f.source) { charBox.appendChild(field(f.name, el('input', { type: 'text', disabled: true, value: charsFor(p)[f.id] || '', title: 'Derived automatically' }))); return; }
      var cur = p.characteristics[f.id];
      var input;
      if (f.type === 'numeric') input = el('input', { type: 'number', step: 'any', value: cur === undefined || cur === null ? '' : cur, onchange: function (e) { setChar(p, f.id, numOrNull(e.target.value)); } });
      else if (f.type === 'boolean') input = el('select', { onchange: function (e) { setChar(p, f.id, e.target.value || null); } }, [el('option', { value: '', text: '– not recorded –' }), el('option', { value: 'Yes', text: 'Yes' }), el('option', { value: 'No', text: 'No' })]);
      else input = el('select', { onchange: function (e) { setChar(p, f.id, e.target.value || null); } }, [el('option', { value: '', text: '– not recorded –' })].concat((f.categories || []).map(function (c) { return el('option', { value: c, text: c }); })));
      if (f.type !== 'numeric') input.value = cur === undefined || cur === null ? '' : String(cur);
      charBox.appendChild(field(f.name, input));
    });
    box.appendChild(el('fieldset', null, [el('legend', { text: 'Characteristics' }), charBox]));

    // photos
    var photoBox = el('div', { class: 'photos' });
    (p.photoIds || []).forEach(function (id) {
      var img = el('img', { alt: 'property photo' });
      loadPhotoUrl(id).then(function (url) { if (url) img.src = url; });
      photoBox.appendChild(el('div', { class: 'photo' }, [img, el('button', { type: 'button', class: 'btn tiny danger', text: '×', title: 'Remove photo', onclick: function () {
        p.photoIds = p.photoIds.filter(function (x) { return x !== id; }); Storage.deletePhoto(id); markDirty(false); renderDetail();
      } })]));
    });
    box.appendChild(el('fieldset', null, [el('legend', { text: 'Photos' }), el('input', { type: 'file', accept: 'image/*', multiple: true, onchange: function (e) { addPhotos(p, e.target.files); } }), photoBox]));

    // notes
    var notes = el('textarea', { rows: 2, style: 'width:100%', onchange: function (e) { p.notes = e.target.value; markDirty(false); } });
    notes.value = p.notes || '';
    box.appendChild(el('fieldset', null, [el('legend', { text: 'Notes' }), notes]));

    // formula value
    var v = valueOf(p);
    if (v.total !== null) {
      box.appendChild(el('fieldset', null, [el('legend', { text: 'Formula value' }),
        el('div', { class: 'stat-row' }, [
          el('div', { class: 'stat' }, [el('div', { class: 'k', text: 'Land' }), el('div', { class: 'v', text: money(v.land) })]),
          el('div', { class: 'stat' }, [el('div', { class: 'k', text: 'Buildings' }), el('div', { class: 'v', text: money(v.improvement) })]),
          el('div', { class: 'stat' }, [el('div', { class: 'k', text: 'Total' }), el('div', { class: 'v', text: money(v.total) })]),
          el('div', { class: 'stat' }, [el('button', { type: 'button', class: 'btn small', text: 'Calculation sheet', onclick: function () { showSheet(p); } })])
        ]),
        v.flags.length ? el('p', { class: 'help', text: v.flags.join('; ') }) : null]));
    }
  }

  function setChar(p, fid, value) {
    if (value === null || value === '' || value === undefined) delete p.characteristics[fid]; else p.characteristics[fid] = value;
    markDirty(true);
  }

  function loadPhotoUrl(id) {
    if (state.photoUrls[id]) return Promise.resolve(state.photoUrls[id]);
    return Storage.getPhoto(id).then(function (blob) { if (!blob) return null; var url = URL.createObjectURL(blob); state.photoUrls[id] = url; return url; });
  }

  function addPhotos(p, files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    Promise.all(list.map(function (f) { return Storage.resizeImage(f, 1024, 0.75).then(function (blob) {
      var id = 'ph_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      return Storage.savePhoto(id, blob).then(function () { p.photoIds.push(id); });
    }); })).then(function () { markDirty(false); renderDetail(); toast(list.length + ' photo(s) added.'); })
      .catch(function (e) { toast('Photo error: ' + e.message, true); });
  }

  /* ------------------------------------------------------------------ */
  /* Map interaction                                                     */
  /* ------------------------------------------------------------------ */

  function requireSelected() { var p = selected(); if (!p) toast('Select or add a property first.', true); return p; }

  function armTool(tool, btnId) {
    if (!requireSelected()) return;
    $all('.map-tools button').forEach(function (b) { b.classList.remove('armed'); });
    Mapping.startTool(tool);
    if (btnId) $(btnId).classList.add('armed');
  }
  function disarm() { $all('.map-tools button').forEach(function (b) { b.classList.remove('armed'); }); }

  function afterGeometryChange(p) {
    syncAreas(p);
    if (p.locationSource !== 'manual') locateProperty(p, false);
    markDirty(true); renderDetail(); renderProperties(); Mapping.render(state.project.properties, p);
  }

  function onPin(lat, lng) {
    var p = selected(); if (!p) return;
    p.lat = lat; p.lng = lng; disarm();
    locateProperty(p, true);
    markDirty(true); renderDetail(); renderProperties(); Mapping.render(state.project.properties, p);
    toast(p.areaId !== null ? 'Located in Area ' + p.areaId + (p.sectorKey ? ', Sector ' + p.sectorKey : '') : 'Pin placed outside the mapped Areas.');
  }

  function centroid(geometry) {
    var pts = geometry.coordinates[0]; var lat = 0, lng = 0;
    pts.forEach(function (c) { lng += c[0]; lat += c[1]; });
    return [lat / pts.length, lng / pts.length];
  }

  function onPolygon(type, geometry, area) {
    var p = selected(); if (!p) return;
    disarm();
    if (type === 'roof') p.roofPolygons.push({ geometry: geometry, area_m2: area, floors: 1 });
    else p.parcelPolygon = { geometry: geometry, area_m2: area };
    if (p.lat === null || p.lng === null) { var c = centroid(geometry); p.lat = c[0]; p.lng = c[1]; locateProperty(p, true); }
    afterGeometryChange(p);
    toast((type === 'roof' ? 'Rooftop' : 'Parcel') + ' traced: ' + fmt(area, 1) + ' m²');
  }

  function onEdited(changes) {
    var p = selected(); if (!p) return;
    changes.forEach(function (ch) {
      if (ch.type === 'roof' && p.roofPolygons[ch.index]) { p.roofPolygons[ch.index].geometry = ch.geometry; p.roofPolygons[ch.index].area_m2 = ch.area; }
      else if (ch.type === 'parcel' && p.parcelPolygon) { p.parcelPolygon.geometry = ch.geometry; p.parcelPolygon.area_m2 = ch.area; }
      else if (ch.type === 'pin') { p.lat = ch.lat; p.lng = ch.lng; locateProperty(p, true); }
    });
    afterGeometryChange(p);
  }

  function onDeleted(removed) {
    var p = selected(); if (!p) return;
    removed.filter(function (r) { return r.type === 'roof'; }).map(function (r) { return r.index; }).sort(function (a, b) { return b - a; }).forEach(function (i) { p.roofPolygons.splice(i, 1); });
    if (removed.some(function (r) { return r.type === 'parcel'; })) p.parcelPolygon = null;
    if (removed.some(function (r) { return r.type === 'pin'; })) { p.lat = null; p.lng = null; }
    afterGeometryChange(p);
  }

  /* ------------------------------------------------------------------ */
  /* Land rates tab                                                      */
  /* ------------------------------------------------------------------ */

  function renderRates() {
    var proj = state.project, lr = proj.landRates;
    $all('#rate-level-toggle button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-level') === lr.level); });
    $('#rate-uplift').value = lr.upliftFactor;
    $('#rate-default').value = lr.defaultRate;
    $('#value-basis').value = proj.valueBasis;
    $('#rates-key-head').textContent = lr.level === 'sector' ? 'Sector' : 'Area';
    var tbody = $('#rates-table tbody');
    tbody.innerHTML = '';
    var isSector = lr.level === 'sector';
    var entries = isSector ? lr.sectors : lr.areas;
    var keys = isSector ? Geo.sectorKeys().slice() : Geo.areaIds().map(String);
    Object.keys(entries).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    keys.sort(function (a, b) { var pa = a.split('/').map(Number), pb = b.split('/').map(Number); return (pa[0] - pb[0]) || ((pa[1] || 0) - (pb[1] || 0)); });
    var counts = {};
    proj.properties.forEach(function (p) { var ri = Valuation.landRateFor(proj, p); if (ri.key) counts[ri.key] = (counts[ri.key] || 0) + 1; });
    var withRate = 0;
    keys.forEach(function (k) {
      var e = entries[k] || null;
      if (e && numOrNull(e.rate) !== null) withRate++;
      var info = isSector ? Geo.sectorInfo(k) : Geo.areaInfo(k);
      var rateInput = el('input', { type: 'number', step: 'any', min: 0, value: e && e.rate !== null && e.rate !== undefined ? e.rate : '', placeholder: 'default', onchange: function (ev) {
        var v = numOrNull(ev.target.value);
        if (v === null) { delete entries[k]; }
        else { entries[k] = Object.assign({ n: null, p25: null, p75: null }, entries[k] || {}, { rate: v, source: (entries[k] && entries[k].source && /QVR 2011/.test(entries[k].source) && entries[k].rate !== v) ? 'edited by valuer' : (entries[k] ? entries[k].source : 'entered by valuer') }); }
        markDirty(true); renderRates();
      } });
      var noteInput = el('input', { type: 'text', value: e ? (e.note || '') : '', placeholder: e ? '' : 'no rate: default applies', disabled: !e, onchange: function (ev) { if (entries[k]) { entries[k].note = ev.target.value; markDirty(false); } } });
      tbody.appendChild(el('tr', { class: e ? '' : 'dim' }, [
        el('td', { text: (isSector ? 'Sector ' : 'Area ') + k }),
        el('td', { text: info && info.Land_Use ? info.Land_Use : '' }),
        el('td', { class: 'num' }, [rateInput]),
        el('td', { class: 'num', text: e && numOrNull(e.rate) !== null ? money(numOrNull(e.rate) * (numOrNull(lr.upliftFactor) || 1)) : money((numOrNull(lr.defaultRate) || 0) * (numOrNull(lr.upliftFactor) || 1)) + ' (default)' }),
        el('td', { class: 'num', text: e && e.n ? String(e.n) : '' }),
        el('td', { class: 'num', text: e && e.p25 !== null && e.p25 !== undefined ? fmt(e.p25, 0) + ' – ' + fmt(e.p75, 0) : '' }),
        el('td', null, [el('div', { class: 'help', text: e ? (e.source || '') : '' }), noteInput]),
        el('td', { class: 'num', text: counts[k] ? String(counts[k]) : '' })
      ]));
    });
    var defaultCount = proj.properties.filter(function (p) { return Valuation.landRateFor(proj, p).basis === 'default'; }).length;
    $('#rates-summary').textContent = withRate + ' of ' + keys.length + ' ' + (isSector ? 'sectors' : 'areas') + ' have a rate' + (defaultCount ? '; ' + defaultCount + ' properties currently use the default rate' : '') + '.';
  }

  /* ------------------------------------------------------------------ */
  /* Characteristics tab                                                 */
  /* ------------------------------------------------------------------ */

  function renderFeatures() {
    var tbody = $('#feature-table tbody');
    tbody.innerHTML = '';
    var proj = state.project;
    proj.features.forEach(function (f, idx) {
      if (f.source === 'zone') f.categories = zoneCategories();
      if (f.source === 'landuse') f.categories = landUseCategories();
      var derived = !!f.source;
      var catInput = el('input', { type: 'text', value: (f.categories || []).join(', '), placeholder: 'e.g. Good, Average, Bad', style: 'width: 100%', disabled: f.type !== 'categorical' || derived, onchange: function (e) {
        f.categories = e.target.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        if (f.baseCategory && f.categories.indexOf(f.baseCategory) < 0) f.baseCategory = null;
        markDirty(true); renderFeatures();
      } });
      var baseSel = el('select', { disabled: f.type !== 'categorical', onchange: function (e) { f.baseCategory = e.target.value || null; markDirty(true); } },
        [el('option', { value: '', text: 'base: most common' })].concat((f.categories || []).map(function (c) { return el('option', { value: c, text: 'base: ' + c }); })));
      baseSel.value = f.baseCategory || '';
      var typeSel = el('select', { disabled: derived, onchange: function (e) { f.type = e.target.value; if (f.type !== 'categorical') { f.categories = []; f.baseCategory = null; } markDirty(true); renderFeatures(); } },
        ['categorical', 'boolean', 'numeric'].map(function (t) { return el('option', { value: t, text: t }); }));
      typeSel.value = f.type;
      var cond = el('input', { type: 'checkbox', checked: !!f.isCondition, onchange: function (e) { f.isCondition = e.target.checked; markDirty(false); renderFeatures(); } });
      tbody.appendChild(el('tr', null, [
        el('td', null, [el('input', { type: 'text', value: f.name, onchange: function (e) { f.name = e.target.value; markDirty(true); } }), derived ? el('div', { class: 'help', text: f.source === 'zone' ? 'mirrors the Zone field' : 'from the Sector land-use map layer' }) : null]),
        el('td', null, [typeSel]),
        el('td', null, [el('div', { class: 'inline' }, [catInput, baseSel])]),
        el('td', null, [cond]),
        el('td', null, [el('button', { type: 'button', class: 'btn tiny danger', text: 'delete', onclick: function () {
          if (!confirm('Delete characteristic "' + f.name + '"? Values recorded for it on properties are removed.')) return;
          proj.features.splice(idx, 1);
          proj.properties.forEach(function (p) { delete p.characteristics[f.id]; });
          delete proj.model.included['f:' + f.id];
          markDirty(true); renderFeatures();
        } })])
      ]));
    });
    $('#condition-notice').hidden = !proj.features.some(function (f) { return f.isCondition; });
  }

  function zoneCategories() {
    var cats = {};
    state.project.properties.forEach(function (p) { if (p.zone && String(p.zone).trim()) cats[String(p.zone).trim()] = true; });
    return Object.keys(cats).sort();
  }

  function addFeature(f) {
    var proj = state.project;
    var base = f.id; var n = 1;
    while (proj.features.some(function (x) { return x.id === f.id; })) f.id = base + '_' + (++n);
    f.appliesTo = 'improvement';
    proj.features.push(f);
  }

  /* ------------------------------------------------------------------ */
  /* Model tab (advanced)                                                */
  /* ------------------------------------------------------------------ */

  function renderModel() {
    var card = $('#model-card');
    var spec = state.project.model;
    var proj = state.project;
    card.innerHTML = '';
    var prep = Valuation.modelRows(proj, charsFor);
    card.appendChild(el('p', { class: 'section-hint', text: prep.samples + ' sample properties with a usable building value (valuer total minus land value).' }));

    var formSel = el('select', { id: 'form-select', onchange: function (e) {
      spec.form = e.target.value;
      Object.keys(spec.locks).forEach(function (k) { if (k === 'area' || k === 'intercept' || (k.indexOf('f:') === 0 && proj.features.some(function (f) { return f.type === 'numeric' && k === 'f:' + f.id; }))) delete spec.locks[k]; });
      specChanged();
    } }, [['loglinear', 'Log-linear (default)'], ['loglog', 'Log-log (LoGRI guidance)'], ['linear', 'Linear']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
    formSel.value = spec.form;
    var smear = el('input', { type: 'checkbox', checked: !!spec.smearing, disabled: spec.form === 'linear', onchange: function (e) { spec.smearing = e.target.checked; specChanged(); } });
    card.appendChild(el('div', { class: 'toolbar' }, [
      el('label', null, ['Model form ', formSel]),
      el('label', { class: 'check', title: 'Duan smearing corrects the downward bias of exponentiated log predictions. Off by default, as in the LoGRI guidance note.' }, [smear, ' Bias correction (smearing)']),
      el('button', { type: 'button', class: 'btn primary', id: 'fit-model', text: 'Fit / refit', onclick: function () { fitModel(false); } }),
      el('button', { type: 'button', class: 'btn', id: 'compare-forms', text: 'Compare forms', onclick: function () { renderCompare(card); } }),
      el('button', { type: 'button', class: 'btn', id: 'btn-save-model', text: 'Save current model as…', onclick: function () { saveCurrentModel(); } })
    ]));
    if (spec.sourceName) card.appendChild(el('p', { class: 'help' }, [el('span', { class: 'tag teal', text: 'active: ' + spec.sourceName })]));
    card.appendChild(el('p', { class: 'help', text: Formula.formDescription(spec.form) }));

    var fit = spec.fit;
    if (!fit) { card.appendChild(el('p', { class: 'help', text: 'Not fitted yet. Enter valuer totals for sample properties, then click Fit.' })); return; }
    if (fit.warnings && fit.warnings.length) card.appendChild(el('div', { class: 'warnings' }, [el('b', { text: 'Check:' }), el('ul', null, fit.warnings.map(function (w) { return el('li', { text: w }); }))]));
    if (fit.residualIssues && fit.residualIssues.length) card.appendChild(el('details', { class: 'drawer' }, [el('summary', { text: fit.residualIssues.length + ' sample propert' + (fit.residualIssues.length === 1 ? 'y' : 'ies') + ' could not be used' }),
      el('ul', { class: 'drawer-body help' }, fit.residualIssues.map(function (x) { var p = findProperty(x.id); return el('li', { text: (p ? p.plotNo : x.id) + ': ' + x.reason }); }))]));
    if (!fit.ok) return;

    card.appendChild(el('div', { class: 'formula', id: 'formula-text', text: Formula.formulaText(fit.form, 'Built area') }));
    var stats = el('div', { class: 'stats-grid', id: 'model-stats' });
    Formula.fitSummary(fit, proj.currency).forEach(function (s) { stats.appendChild(el('div', { class: 'stat', title: s.help }, [el('div', { class: 'k', text: s.label }), el('div', { class: 'v', text: s.value })])); });
    card.appendChild(stats);
    card.appendChild(el('div', { class: 'chart-tools' }, [el('span', { class: 'help', text: 'Each dot is a sample property: the valuer\'s building value across, the formula\'s value up. Dots on the line are matched exactly; the band marks ±20 %.' }), scaleToggle(renderModel)]));
    card.appendChild(fitChart(fit, { title: 'Valuer vs formula – current settings', subtitle: chartSubtitle(fit), width: 620, height: 440 }));
    if (fit.excluded && fit.excluded.length) card.appendChild(el('details', { class: 'drawer' }, [el('summary', { text: fit.excluded.length + ' sample propert' + (fit.excluded.length === 1 ? 'y' : 'ies') + ' excluded from the fit' }),
      el('ul', { class: 'drawer-body help' }, fit.excluded.map(function (x) { var p = findProperty(x.id); return el('li', { text: (p ? p.plotNo : x.id) + ': ' + x.reason }); }))]));

    card.appendChild(el('div', { class: 'table-scroll' }, [weightsTable(fit, true)]));
    card.appendChild(el('p', { class: 'help', text: 'Weights for log forms are percentages relative to the base property. Locking a weight fixes it at the value you type and refits the other weights around it (offset method).' }));

    var st = el('table', { class: 'data compact' });
    st.appendChild(el('thead', null, [el('tr', null, ['Plot no.', 'Building value (valuer total − land)', 'Predicted', 'Ratio', 'Leave-one-out'].map(function (h) { return el('th', { text: h }); }))]));
    var stb = el('tbody');
    fit.sample.forEach(function (s) {
      var p = findProperty(s.id);
      stb.appendChild(el('tr', null, [el('td', { text: p ? p.plotNo : s.id }), el('td', { class: 'num', text: money(s.actual) }), el('td', { class: 'num', text: money(s.predicted) }), el('td', { class: 'num', text: fmt(s.ratio, 3) }), el('td', { class: 'num', text: s.loo === null ? '–' : money(s.loo) })]));
    });
    st.appendChild(stb);
    card.appendChild(el('details', { class: 'drawer' }, [el('summary', { text: 'Sample properties: actual vs predicted building value' }), el('div', { class: 'drawer-body table-scroll' }, [st])]));
    card.appendChild(el('div', { id: 'compare-box' }));
    renderComparison(card);
  }

  /* ---- saved models and their comparison ---- */

  function specChanged() { state.project.model.sourceName = null; fitModel(true); }

  function snapshotSpec(spec) { return JSON.parse(JSON.stringify({ form: spec.form, smearing: !!spec.smearing, included: spec.included || {}, locks: spec.locks || {}, bases: spec.bases || {} })); }

  function saveCurrentModel(name) {
    var proj = state.project;
    if (!proj.model.fit || !proj.model.fit.ok) { toast('Fit the model before saving it.', true); return null; }
    name = name || prompt('Name for this model:', 'Model ' + (proj.savedModels.length + 1));
    if (!name) return null;
    var entry = { id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name.trim(), note: '', createdAt: new Date().toISOString(), spec: snapshotSpec(proj.model), fit: JSON.parse(JSON.stringify(proj.model.fit)) };
    proj.savedModels.push(entry);
    proj.model.sourceName = entry.name;
    save(); renderModel(); renderResults();
    toast('Saved "' + entry.name + '".');
    return entry;
  }

  function refitSaved(entry) {
    var proj = state.project, keep = snapshotSpec(proj.model), keepName = proj.model.sourceName;
    Object.assign(proj.model, entry.spec);
    var s = buildSpec();
    var fit = Engine.fit(s, s.rows);
    fit.residualIssues = s.prep.issues; fit.warnings = (s.prep.warnings || []).concat(fit.warnings || []);
    entry.fit = JSON.parse(JSON.stringify(fit)); entry.refittedAt = new Date().toISOString();
    Object.assign(proj.model, keep); proj.model.sourceName = keepName;
  }

  function useSaved(entry) {
    var proj = state.project;
    Object.assign(proj.model, snapshotSpec(entry.spec));
    proj.model.sourceName = entry.name;
    fitModel(true);
    toast('"' + entry.name + '" is now the active model.');
  }

  function comparisonEntries() {
    var proj = state.project;
    var cur = { id: 'current', name: proj.model.sourceName ? 'Current (' + proj.model.sourceName + ')' : 'Current settings', fit: proj.model.fit };
    return [cur].concat(proj.savedModels.map(function (m) { return { id: m.id, name: m.name, fit: m.fit, saved: m }; }));
  }

  function renderComparison(card) {
    var proj = state.project;
    var box = el('div', { id: 'saved-models' });
    card.appendChild(box);
    box.appendChild(el('h3', { text: 'Saved models and comparison' }));
    if (!proj.savedModels.length) { box.appendChild(el('p', { class: 'help', text: 'Save the current model under a name, change the settings, save again, and the models are compared here on fit, weights and their effect on the valuation roll.' })); return; }
    var entries = comparisonEntries();
    var cmp = Valuation.compareModels(proj, entries, charsFor);
    box.appendChild(el('div', { class: 'toolbar' }, [
      el('button', { type: 'button', class: 'btn small', id: 'btn-refit-saved', text: 'Refit saved models on current data', onclick: function () { proj.savedModels.forEach(refitSaved); save(); renderModel(); toast('Saved models refitted.'); } }),
      el('button', { type: 'button', class: 'btn small', id: 'btn-export-comparison', text: 'Export comparison (Excel)', onclick: exportComparison }),
      el('span', { class: 'help', text: 'Land values are the same under every model; only the building formula differs.' })
    ]));
    // statistics table
    var t = el('table', { class: 'data compact', id: 'compare-stats' });
    t.appendChild(el('thead', null, [el('tr', null, ['Model', 'Form', 'Terms', 'Locks', 'n', 'R²', 'Adj. R²', 'RMSE', 'LOO RMSE', 'COD', 'PRD', 'Buildings total', 'All total', 'Moved > 10 %', ''].map(function (h) { return el('th', { text: h, class: /R²|RMSE|COD|PRD|total|Moved|Terms|Locks|^n$/.test(h) ? 'num' : '' }); }))]));
    var tb = el('tbody');
    cmp.entries.forEach(function (e, k) {
      var s = e.stats, entry = entries[k].saved;
      var isActive = k === 0 || (proj.model.sourceName && entry && entry.name === proj.model.sourceName);
      var actions = entry ? [
        el('button', { type: 'button', class: 'btn tiny', text: 'Use', onclick: function () { useSaved(entry); } }),
        el('button', { type: 'button', class: 'btn tiny', text: 'Rename', onclick: function () { var n = prompt('New name:', entry.name); if (n) { if (proj.model.sourceName === entry.name) proj.model.sourceName = n.trim(); entry.name = n.trim(); save(); renderModel(); } } }),
        el('button', { type: 'button', class: 'btn tiny danger', text: 'Delete', onclick: function () { if (!confirm('Delete saved model "' + entry.name + '"?')) return; proj.savedModels = proj.savedModels.filter(function (m) { return m.id !== entry.id; }); save(); renderModel(); } })
      ] : [];
      tb.appendChild(el('tr', { class: isActive && k > 0 ? 'active-model' : '' }, [
        el('td', { text: e.name + (entry && entry.fit && entry.fit.n !== undefined ? '' : '') }),
        el('td', { text: { linear: 'Linear', loglinear: 'Log-linear', loglog: 'Log-log' }[e.form] || '–' }),
        el('td', { class: 'num', text: String(e.terms) }), el('td', { class: 'num', text: String(e.locks) }),
        el('td', { class: 'num', text: s ? String(s.n) : '–' }), el('td', { class: 'num', text: s ? fmt(s.r2, 3) : '–' }), el('td', { class: 'num', text: s ? fmt(s.adjR2, 3) : '–' }),
        el('td', { class: 'num', text: s ? money(s.rmse) : '–' }), el('td', { class: 'num', text: s && s.loocvRmse !== null ? money(s.loocvRmse) : '–' }),
        el('td', { class: 'num', text: s ? fmt(s.cod, 1) + ' %' : '–' }), el('td', { class: 'num', text: s ? fmt(s.prd, 3) : '–' }),
        el('td', { class: 'num', text: money(e.totals.improvement) }), el('td', { class: 'num', text: money(e.totals.total) }),
        el('td', { class: 'num', text: k === 0 ? 'reference' : (e.movedShare === null ? '–' : fmt(e.movedShare * 100, 0) + ' % (' + e.moved + ')') }),
        el('td', null, actions)
      ]));
    });
    t.appendChild(tb);
    box.appendChild(el('div', { class: 'table-scroll' }, [t]));
    box.appendChild(el('p', { class: 'help', text: '"Moved > 10 %" counts properties whose total value under that model differs by more than 10 % from the current settings. R² on the fit scale is not comparable between log and linear forms; compare RMSE, LOO RMSE and COD.' }));
    // small multiples: valuer vs formula for every model, shared axes
    var sets = entries.map(function (e) { return Charts.fitPoints(e.fit, plotLabel); });
    var domain = Charts.sharedDomain(sets, state.chartLog);
    box.appendChild(el('h3', { text: 'Valuer vs formula, model by model' }));
    box.appendChild(el('div', { class: 'chart-tools' }, [el('span', { class: 'help', text: 'Same axes on every plot. The closer the dots sit to the line, the better the model reproduces the valuer\'s figures; a tilt away from the line means large or small properties are systematically over- or under-valued.' }), scaleToggle(renderModel)]));
    var grid = el('div', { class: 'chart-grid', id: 'compare-charts' });
    entries.forEach(function (e, k) {
      var res = Charts.scatter({ points: sets[k], log: state.chartLog, domain: domain, compact: true, width: 320, height: 300, title: e.name, subtitle: chartSubtitle(e.fit), xLabel: 'Valuer', yLabel: 'Formula' });
      grid.appendChild(el('div', { class: 'chart small' }, [res.svg]));
    });
    box.appendChild(grid);
    // weights matrix
    var wm = Formula.weightsMatrix(entries, proj.currency);
    var wt = el('table', { class: 'data compact compare-weights', id: 'compare-weights' });
    wt.appendChild(el('thead', null, [el('tr', null, [el('th', { text: 'Term' })].concat(wm.names.map(function (n) { return el('th', { text: n }); })))]));
    var wb = el('tbody');
    wm.rows.forEach(function (r) {
      wb.appendChild(el('tr', null, [el('td', { text: r.label })].concat(r.cells.map(function (c) {
        return c ? el('td', { class: 'num' }, [c.text, el('span', { class: 'badge ' + c.code, text: c.label })]) : el('td', { class: 'num help', text: '–' });
      }))));
    });
    wt.appendChild(wb);
    box.appendChild(el('h3', { text: 'Weights side by side' }));
    box.appendChild(el('div', { class: 'table-scroll' }, [wt]));
  }

  function exportComparison() {
    var proj = state.project, entries = comparisonEntries();
    var cmp = Valuation.compareModels(proj, entries, charsFor);
    var stats = cmp.entries.map(function (e) { var s = e.stats || {}; return { Model: e.name, Form: e.form || '', Terms: e.terms, Locks: e.locks, n: s.n === undefined ? '' : s.n, R2: s.r2 === undefined ? '' : s.r2, AdjR2: s.adjR2 === undefined ? '' : s.adjR2, RMSE: s.rmse === undefined ? '' : Math.round(s.rmse), LOO_RMSE: s.loocvRmse === undefined || s.loocvRmse === null ? '' : Math.round(s.loocvRmse), COD: s.cod === undefined ? '' : s.cod, PRD: s.prd === undefined ? '' : s.prd, BuildingsTotal: Math.round(e.totals.improvement), AllTotal: Math.round(e.totals.total), Valued: e.totals.valued, MovedOver10pct: e.movedShare === null ? '' : e.movedShare, MovedCount: e.moved }; });
    var wm = Formula.weightsMatrix(entries, proj.currency);
    var wHeaders = ['Term'].concat(wm.names);
    var wRows = wm.rows.map(function (r) { var o = { Term: r.label }; r.cells.forEach(function (c, k) { o[wm.names[k]] = c ? c.text + ' [' + c.label + ']' : ''; }); return o; });
    var pHeaders = ['PlotNo', 'Description', 'LCC_Area', 'LandValue'];
    entries.forEach(function (e) { pHeaders.push('Building_' + e.name, 'Total_' + e.name); });
    var pRows = cmp.perProperty.map(function (r) { var o = { PlotNo: r.plotNo, Description: r.description, LCC_Area: r.areaId, LandValue: r.land === null ? '' : Math.round(r.land) }; entries.forEach(function (e, k) { o['Building_' + e.name] = r.values[k] === null ? '' : Math.round(r.values[k]); o['Total_' + e.name] = r.totals[k] === null ? '' : Math.round(r.totals[k]); }); return o; });
    IO.downloadWorkbook('model_comparison.xlsx', [
      { name: 'Statistics', rows: stats, headers: Object.keys(stats[0]) },
      { name: 'Weights', rows: wRows, headers: wHeaders },
      { name: 'Per property', rows: pRows, headers: pHeaders }
    ]);
  }

  function weightsTable(fit, editable) {
    var spec = state.project.model, proj = state.project;
    var table = el('table', { class: 'data compact', id: editable ? 'weights-table' : 'weights-readonly' });
    var heads = editable ? ['Term', 'n', 'In model', 'Weight', 'Lock', 'Locked value', 'Std. error', 'p-value', 'Confidence'] : ['Term', 'Weight', 'Confidence'];
    table.appendChild(el('thead', null, [el('tr', null, heads.map(function (h) { return el('th', { text: h }); }))]));
    var tbody = el('tbody');
    Formula.weightsTable(fit, proj.currency).forEach(function (w) {
      var c = w.column, isBase = c.isBase;
      if (!editable && w.status === 'excluded') return;
      var cells = [el('td', { text: c.label + (isBase ? ' (base)' : '') })];
      if (editable) {
        var incl = el('input', { type: 'checkbox', checked: w.status !== 'excluded', disabled: isBase || c.kind === 'intercept' || c.kind === 'area', onchange: function (e) { spec.included[c.key] = e.target.checked; specChanged(); } });
        var lockChk = el('input', { type: 'checkbox', checked: w.status === 'locked', disabled: isBase || w.status === 'excluded', onchange: function (e) {
          if (e.target.checked) { var d = w.display; spec.locks[c.key] = d === null ? 0 : Math.round(d * 1000) / 1000; } else delete spec.locks[c.key];
          specChanged();
        } });
        var lockVal = el('input', { type: 'number', step: 'any', class: 'short', disabled: w.status !== 'locked', value: w.status === 'locked' ? spec.locks[c.key] : '', onchange: function (e) {
          var v = numOrNull(e.target.value); if (v === null) return; spec.locks[c.key] = v; specChanged();
        } });
        cells.push(el('td', { class: 'num', text: c.kind === 'category' ? String(w.count || 0) : '' }), el('td', null, [incl]),
          el('td', { class: 'num', text: w.status === 'excluded' ? '–' : w.weightText }), el('td', null, [lockChk]),
          el('td', null, [lockVal, el('span', { class: 'help', text: w.status === 'locked' ? ' ' + w.unit.replace('currency', proj.currency) : '' })]),
          el('td', { class: 'num', text: w.se === null || w.se === undefined ? '–' : fmt(w.se, 4) }), el('td', { class: 'num', text: Formula.fmtP(w.p) }));
      } else cells.push(el('td', { class: 'num', text: w.weightText }));
      cells.push(el('td', null, [el('span', { class: 'badge ' + w.significance.code, text: w.significance.label })]));
      tbody.appendChild(el('tr', { class: 'status-' + w.status }, cells));
    });
    table.appendChild(tbody);
    return table;
  }

  function renderCompare(card) {
    var box = $('#compare-box', card);
    box.innerHTML = '';
    var results = Engine.FORMS.map(function (form) { var s = buildSpec(form); return { form: form, fit: Engine.fit(s, s.rows) }; });
    if (!results.some(function (r) { return r.fit.ok; })) { box.appendChild(el('p', { class: 'help', text: 'Nothing to compare yet.' })); return; }
    var t = el('table', { class: 'data compact' });
    t.appendChild(el('thead', null, [el('tr', null, ['Form', 'R² (fit scale)', 'R² on values', 'RMSE', 'Leave-one-out RMSE', 'COD', 'PRD'].map(function (h) { return el('th', { text: h }); }))]));
    var tb = el('tbody');
    results.forEach(function (r) {
      var f = r.fit;
      tb.appendChild(el('tr', { class: r.form === state.project.model.form ? 'selected' : '' }, [
        el('td', { text: { linear: 'Linear', loglinear: 'Log-linear', loglog: 'Log-log' }[r.form] }),
        el('td', { class: 'num', text: fmt(f.r2, 3) }), el('td', { class: 'num', text: fmt(f.r2Level, 3) }), el('td', { class: 'num', text: money(f.rmse) }),
        el('td', { class: 'num', text: f.loocvRmse === null ? '–' : money(f.loocvRmse) }), el('td', { class: 'num', text: fmt(f.cod, 1) + ' %' }), el('td', { class: 'num', text: fmt(f.prd, 3) })
      ]));
    });
    t.appendChild(tb);
    box.appendChild(el('h3', { text: 'Comparison of model forms (same terms and locks; area lock dropped where units differ)' }));
    box.appendChild(el('div', { class: 'table-scroll' }, [t]));
    box.appendChild(el('p', { class: 'help', text: 'R² on the fit scale is not comparable between log and linear forms; compare RMSE, leave-one-out RMSE and COD on values instead.' }));
  }

  /* ------------------------------------------------------------------ */
  /* Results tab                                                         */
  /* ------------------------------------------------------------------ */

  function rollRows() {
    return state.project.properties.map(function (p) {
      var v = valueOf(p);
      var sampleTotal = numOrNull(p.totalValue);
      return { p: p, v: v, sampleTotal: sampleTotal, ratio: (sampleTotal && v.total !== null) ? v.total / sampleTotal : null };
    });
  }

  function renderResults() {
    var proj = state.project, fit = proj.model.fit;
    var box = $('#results-summary');
    box.innerHTML = '';
    var rows = rollRows();
    var totals = { land: 0, improvement: 0, total: 0, n: 0, defaults: 0 };
    rows.forEach(function (r) { if (r.v.total !== null) { totals.n++; totals.land += r.v.land || 0; totals.improvement += r.v.improvement || 0; totals.total += r.v.total; } if (r.v.rateInfo && r.v.rateInfo.basis === 'default') totals.defaults++; });

    var lead = el('div', { class: 'lead' });
    if (!fit || !fit.ok) {
      lead.appendChild(el('p', null, [el('b', { text: 'The building model is not fitted yet. ' }), 'Enter the valuer\'s total value for a sample of properties on the Properties tab. Land values are already calculated from the rates.']));
    } else {
      lead.appendChild(el('p', null, [el('b', { text: (proj.model.sourceName ? 'Active model: ' + proj.model.sourceName + '. ' : '') + 'Model fitted on ' + fit.n + ' sample properties. ' }), 'Typical error of a building value on the sample: ' + money(fit.rmse) + (fit.loocvRmse !== null ? ' (' + money(fit.loocvRmse) + ' when each property is predicted without itself)' : '') + '. R² ' + fmt(fit.r2, 2) + '; median formula ÷ valuer ratio ' + fmt(fit.medianRatio, 2) + '; COD ' + fmt(fit.cod, 0) + ' %.']));
      lead.appendChild(el('p', { class: 'help', text: Formula.formulaText(fit.form, 'Built area') + '. Land value = rate per m² × parcel area. Total = land + buildings.' }));
    }
    lead.appendChild(el('p', { class: 'help', text: 'Land rates by ' + (proj.landRates.level === 'sector' ? 'Sector' : 'Area') + (numOrNull(proj.landRates.upliftFactor) !== 1 ? ', uplift factor ' + fmt(proj.landRates.upliftFactor, 2) : ', no uplift') + (totals.defaults ? '; ' + totals.defaults + ' properties use the default rate' : '') + '.' }));
    var allWarnings = (fit && fit.warnings) ? fit.warnings : [];
    if (allWarnings.length) lead.appendChild(el('div', { class: 'warnings' }, [el('b', { text: 'Check:' }), el('ul', null, allWarnings.map(function (w) { return el('li', { text: w }); }))]));
    var statRow = el('div', { class: 'stat-row' }, [
      el('div', { class: 'stat' }, [el('div', { class: 'k', text: 'Valued' }), el('div', { class: 'v', text: totals.n + ' / ' + rows.length })]),
      el('div', { class: 'stat' }, [el('div', { class: 'k', text: 'Land' }), el('div', { class: 'v', text: money(totals.land) })]),
      el('div', { class: 'stat' }, [el('div', { class: 'k', text: 'Buildings' }), el('div', { class: 'v', text: money(totals.improvement) })]),
      el('div', { class: 'stat' }, [el('div', { class: 'k', text: 'Total' }), el('div', { class: 'v', text: money(totals.total) })])
    ]);
    box.appendChild(el('div', { class: 'results-headline' }, [lead, statRow]));
    if (fit && fit.ok) {
      box.appendChild(el('details', { class: 'drawer', open: true }, [el('summary', { text: 'How close is the formula to the valuer?' }),
        el('div', { class: 'drawer-body' }, [el('p', { class: 'help', text: 'Each dot is one sample property. Across: the building value implied by the valuer (total minus land). Up: the formula\'s building value. Dots on the line match exactly; the band marks ±20 %.' }), fitChart(fit, { title: 'Valuer vs formula', subtitle: chartSubtitle(fit), width: 620, height: 400 })])]));
      box.appendChild(el('details', { class: 'drawer' }, [el('summary', { text: 'Weights in the building formula' }), el('div', { class: 'drawer-body table-scroll' }, [weightsTable(fit, false)])]));
    }

    var tbody = $('#roll-table tbody');
    tbody.innerHTML = '';
    rows.slice(0, MAX_ROWS).forEach(function (r) {
      var p = r.p, ri = r.v.rateInfo;
      tbody.appendChild(el('tr', { class: r.v.total === null ? 'dim' : '' }, [
        el('td', { text: p.plotNo }), el('td', { text: p.description }), el('td', { text: areaText(p) }),
        el('td', { class: 'num', text: fmt(p.landArea_m2, 0) }), el('td', { class: 'num', text: ri ? fmt(ri.rate, 0) + (ri.basis === 'default' ? '*' : '') : '' }), el('td', { class: 'num', text: fmt(r.v.land, 0) }),
        el('td', { class: 'num', text: fmt(p.builtArea_m2, 0) }), el('td', { class: 'num', text: fmt(r.v.improvement, 0) }), el('td', { class: 'num', text: fmt(r.v.total, 0) }),
        el('td', { class: 'num', text: fmt(r.sampleTotal, 0) }), el('td', { class: 'num', text: fmt(r.ratio, 2) }),
        el('td', { class: 'help', text: r.v.flags.join('; ') }),
        el('td', null, [r.v.total !== null ? el('button', { type: 'button', class: 'btn tiny', text: 'sheet', onclick: function () { showSheet(p); } }) : null])
      ]));
    });
    $('#roll-summary').textContent = totals.n + ' of ' + rows.length + ' properties valued' + (rows.length > MAX_ROWS ? ' (first ' + MAX_ROWS + ' shown; the export has all)' : '');
  }

  function rollExportRows() {
    var proj = state.project, feats = Valuation.modelFeatures(proj);
    var headers = ['PlotNo', 'Description', 'Zone', 'Latitude', 'Longitude', 'LCC_Area', 'LCC_Sector', 'AreaSource', 'LandArea_m2', 'LandAreaSource', 'LandRate_per_m2', 'LandRateBasis', 'LandRateSource',
      'BuiltArea_m2', 'BuiltAreaSource', 'Floors_traced', 'LandValue', 'ImprovementValue', 'TotalValue', 'ValuerTotal_sample', 'Ratio_formula_to_valuer', 'Flags', 'Notes', 'Photos']
      .concat(feats.map(function (f) { return 'char_' + f.name; }));
    var rows = rollRows().map(function (r) {
      var p = r.p, ri = r.v.rateInfo || {};
      var o = {
        PlotNo: p.plotNo, Description: p.description, Zone: p.zone, Latitude: p.lat, Longitude: p.lng, LCC_Area: p.areaId, LCC_Sector: p.sectorKey, AreaSource: p.locationSource || '',
        LandArea_m2: p.landArea_m2, LandAreaSource: p.landAreaSource || '', LandRate_per_m2: ri.rate === undefined ? '' : Math.round(ri.rate * 100) / 100, LandRateBasis: ri.basis || '', LandRateSource: ri.source || '',
        BuiltArea_m2: p.builtArea_m2, BuiltAreaSource: p.builtAreaSource || '', Floors_traced: (p.roofPolygons || []).map(function (x) { return x.floors || 1; }).join('|'),
        LandValue: r.v.land === null ? '' : Math.round(r.v.land), ImprovementValue: r.v.improvement === null ? '' : Math.round(r.v.improvement), TotalValue: r.v.total === null ? '' : Math.round(r.v.total),
        ValuerTotal_sample: p.totalValue, Ratio_formula_to_valuer: r.ratio === null ? '' : Math.round(r.ratio * 1000) / 1000, Flags: r.v.flags.join('; '), Notes: p.notes, Photos: (p.photoIds || []).length
      };
      var chars = charsFor(p);
      feats.forEach(function (f) { o['char_' + f.name] = chars[f.id] === undefined ? '' : chars[f.id]; });
      return o;
    });
    return { headers: headers, rows: rows };
  }

  function weightsExportRows() {
    var proj = state.project, fit = proj.model.fit, rows = [];
    if (fit && fit.ok) {
      Formula.weightsTable(fit, proj.currency).forEach(function (w) {
        rows.push({ Model: 'improvement', Form: fit.form, Term: w.column.label, Kind: w.column.kind, Status: w.status, Weight_display: w.display === null ? '' : w.display, Unit: w.unit.replace('currency', proj.currency), Coefficient: w.coef, StdError: w.se === null ? '' : w.se, pValue: w.p === null ? '' : w.p, Confidence: w.significance.label, SampleCount: w.column.kind === 'category' ? w.count : '' });
      });
      rows.push({ Model: 'improvement', Form: fit.form, Term: '[fit statistics]', Confidence: 'n=' + fit.n + '; R2=' + fit.r2.toFixed(4) + '; adjR2=' + fit.adjR2.toFixed(4) + '; RMSE=' + Math.round(fit.rmse) + '; LOO_RMSE=' + (fit.loocvRmse === null ? 'NA' : Math.round(fit.loocvRmse)) + '; COD=' + fit.cod.toFixed(2) + '; PRD=' + fit.prd.toFixed(4) + '; smearing=' + fit.smearing.toFixed(4) });
    }
    return { headers: ['Model', 'Form', 'Term', 'Kind', 'Status', 'Weight_display', 'Unit', 'Coefficient', 'StdError', 'pValue', 'Confidence', 'SampleCount'], rows: rows };
  }

  function ratesExportRows() {
    var lr = state.project.landRates, isSector = lr.level === 'sector', entries = isSector ? lr.sectors : lr.areas;
    var rows = Object.keys(entries).map(function (k) { var e = entries[k]; return { Level: lr.level, Key: k, Rate_per_m2: e.rate, WithUplift: numOrNull(e.rate) === null ? '' : Math.round(numOrNull(e.rate) * (numOrNull(lr.upliftFactor) || 1)), Plots2011: e.n || '', P25_2011: e.p25 || '', P75_2011: e.p75 || '', Source: e.source || '', Note: e.note || '' }; });
    rows.push({ Level: lr.level, Key: '[settings]', Rate_per_m2: lr.defaultRate, WithUplift: '', Plots2011: '', P25_2011: '', P75_2011: '', Source: 'default rate; uplift factor ' + lr.upliftFactor, Note: '' });
    return { headers: [isSector ? 'Sector' : 'Area', 'Rate_per_m2', 'WithUplift', 'Plots2011', 'P25_2011', 'P75_2011', 'Source', 'Note'], rows: rows.map(function (r) { var o = {}; o[isSector ? 'Sector' : 'Area'] = r.Key; ['Rate_per_m2', 'WithUplift', 'Plots2011', 'P25_2011', 'P75_2011', 'Source', 'Note'].forEach(function (h) { o[h] = r[h]; }); return o; }) };
  }

  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function reportHtml() {
    var proj = state.project, fit = proj.model.fit, lr = proj.landRates;
    var h = ['<!DOCTYPE html><html><head><meta charset="utf-8"><title>Valuation report – ' + esc(proj.name) + '</title>',
      '<style>body{font-family:Helvetica,Arial,sans-serif;max-width:62rem;margin:2rem auto;color:#000;font-size:14px}h1,h2,h3{font-family:Raleway,Helvetica,Arial,sans-serif}h1{border-bottom:3px solid #e8a838;padding-bottom:6px}h2{color:#14472e;margin-top:26px}table{border-collapse:collapse;width:100%;margin:.6rem 0}th,td{border:1px solid #d5ddd5;padding:.3rem .5rem;text-align:left}th{background:#14472e;color:#fff;font-size:12px;text-transform:uppercase}.num{text-align:right}.muted{color:#4a5a4a}.box{background:#eaf2ea;border-radius:8px;padding:12px 16px;margin:12px 0}.cert{border:2px solid #14472e;border-radius:8px;padding:14px 18px;margin-top:26px}</style></head><body>',
      '<h1>Valuation report</h1><p><b>' + esc(proj.name) + '</b> · Lilongwe City Council · ' + esc(proj.currency) + ' · basis: ' + (proj.valueBasis === 'annual_rental' ? 'estimated annual rental value' : 'capital (market) value') + ' · generated ' + new Date().toLocaleString('en-GB') + '</p>'];
    h.push('<h2>Basis, method and assumptions (Property Valuation Act 2024, s.22)</h2><div class="box">' + Formula.methodStatement(proj, fit).map(function (s) { return '<p>' + esc(s) + '</p>'; }).join('') + '</div>');
    h.push('<h2>Land value schedule</h2><p>Rates by ' + (lr.level === 'sector' ? 'Sector' : 'Area') + '; uplift factor ' + esc(lr.upliftFactor) + '; default rate ' + esc(Formula.fmtMoney(lr.defaultRate, proj.currency)) + ' per m².' + (lr.defaultsSource ? ' Starting rates: ' + esc(lr.defaultsSource) + '.' : '') + '</p>');
    var entries = lr.level === 'sector' ? lr.sectors : lr.areas;
    h.push('<table><tr><th>' + (lr.level === 'sector' ? 'Sector' : 'Area') + '</th><th class="num">Rate per m²</th><th class="num">With uplift</th><th class="num">Plots in 2011 roll</th><th>Source</th><th>Note</th></tr>');
    Object.keys(entries).sort(function (a, b) { var pa = a.split('/').map(Number), pb = b.split('/').map(Number); return (pa[0] - pb[0]) || ((pa[1] || 0) - (pb[1] || 0)); }).forEach(function (k) { var e = entries[k]; h.push('<tr><td>' + esc(k) + '</td><td class="num">' + esc(fmt(e.rate, 0)) + '</td><td class="num">' + esc(fmt(numOrNull(e.rate) * (numOrNull(lr.upliftFactor) || 1), 0)) + '</td><td class="num">' + esc(e.n || '') + '</td><td>' + esc(e.source || '') + '</td><td>' + esc(e.note || '') + '</td></tr>'); });
    h.push('</table>');
    h.push('<h2>Building value model</h2>');
    if (!fit || !fit.ok) h.push('<p class="muted">Not fitted.</p>');
    else {
      h.push('<p>' + esc(Formula.formDescription(fit.form)) + '</p><p><code>' + esc(Formula.formulaText(fit.form, 'Built area')) + '</code></p>');
      h.push('<table><tr>' + Formula.fitSummary(fit, proj.currency).map(function (s) { return '<th>' + esc(s.label) + '</th>'; }).join('') + '</tr><tr>' + Formula.fitSummary(fit, proj.currency).map(function (s) { return '<td class="num">' + esc(s.value) + '</td>'; }).join('') + '</tr></table>');
      h.push('<table><tr><th>Term</th><th class="num">n</th><th class="num">Weight</th><th class="num">Std. error</th><th class="num">p-value</th><th>Confidence</th></tr>');
      Formula.weightsTable(fit, proj.currency).forEach(function (w) { if (w.status === 'excluded') return; h.push('<tr><td>' + esc(w.column.label) + (w.column.isBase ? ' (base)' : '') + '</td><td class="num">' + (w.column.kind === 'category' ? w.count : '') + '</td><td class="num">' + esc(w.weightText) + '</td><td class="num">' + (w.se === null ? '–' : fmt(w.se, 4)) + '</td><td class="num">' + esc(Formula.fmtP(w.p)) + '</td><td>' + esc(w.significance.label) + '</td></tr>'); });
      h.push('</table>');
      if (fit.warnings.length) h.push('<p><b>Checks:</b></p><ul>' + fit.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>');
      var chart = Charts.scatter({ points: Charts.fitPoints(fit, plotLabel), log: true, title: 'Valuer vs formula (building value, log axes)', subtitle: chartSubtitle(fit), width: 620, height: 440, xLabel: 'Valuer\'s building value (total − land)', yLabel: 'Formula building value' });
      h.push('<div style="max-width:620px">' + new XMLSerializer().serializeToString(chart.svg) + '</div><p class="muted">Each dot is a sample property; the line marks equality and the outer lines ±20 %.</p>');
    }
    if (proj.savedModels && proj.savedModels.length) {
      var cmpR = Valuation.compareModels(proj, comparisonEntries(), charsFor);
      h.push('<h2>Alternative models considered</h2><table><tr><th>Model</th><th>Form</th><th class="num">n</th><th class="num">R²</th><th class="num">RMSE</th><th class="num">COD</th><th class="num">All total</th></tr>');
      cmpR.entries.forEach(function (e) { var s = e.stats; h.push('<tr><td>' + esc(e.name) + '</td><td>' + esc(e.form || '') + '</td><td class="num">' + (s ? s.n : '') + '</td><td class="num">' + (s ? fmt(s.r2, 3) : '') + '</td><td class="num">' + (s ? fmt(s.rmse, 0) : '') + '</td><td class="num">' + (s ? fmt(s.cod, 1) + ' %' : '') + '</td><td class="num">' + fmt(e.totals.total, 0) + '</td></tr>'); });
      h.push('</table>');
    }
    var rows = rollRows(); var n = rows.filter(function (r) { return r.v.total !== null; }).length;
    h.push('<h2>Application</h2><p>' + n + ' of ' + rows.length + ' properties receive a formula value. Land, improvement and total values are reported separately in the exported roll (Local Government Act s.68(1)). Each property has a calculation sheet that shows every step.</p>');
    var cond = proj.features.filter(function (f) { return f.isCondition; });
    if (cond.length) h.push('<p><b>Legal flag:</b> condition variables in the model: ' + esc(cond.map(function (f) { return f.name; }).join(', ')) + '. Whether actual condition is a permitted input under the "reasonable condition" wording of the Local Government Act is unresolved.</p>');
    h.push('<p class="muted">Regulations under PVA 2024 s.42(2)(c) for mass valuation procedures were not confirmed as issued at the time of preparation. This report is a working document for the registered valuer\'s review.</p>');
    var v = proj.valuer || {};
    h.push('<div class="cert"><h3>Certification (PVA 2024 ss.24–25)</h3><p>Registered valuer: <b>' + esc(v.name || '______________________') + '</b> · Registration / licence no.: <b>' + esc(v.registration || '____________') + '</b></p><p>Valuation date: <b>' + esc(v.valuationDate || '____________') + '</b> · Validity: <b>' + esc(v.validityMonths || '__') + ' months</b> from the valuation date</p><p>Stamp, address, date and signature: ____________________________________________</p></div>');
    h.push('</body></html>');
    return h.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* Calculation sheet                                                   */
  /* ------------------------------------------------------------------ */

  function showSheet(p) {
    var proj = state.project;
    var box = $('#sheet-content');
    box.innerHTML = '';
    box.appendChild(el('h3', { text: 'Calculation sheet – ' + (p.plotNo || '') + (p.description ? ' · ' + p.description : '') }));
    box.appendChild(el('p', { class: 'help', text: (areaText(p) || 'Area not set') + ' · Land area: ' + fmt(p.landArea_m2, 1) + ' m² (' + (p.landAreaSource || 'not set') + ') · Built area: ' + fmt(p.builtArea_m2, 1) + ' m² (' + (p.builtAreaSource || 'not set') + ') · Basis: ' + (proj.valueBasis === 'annual_rental' ? 'annual rental value' : 'capital value') }));
    function table(sheet, totalLabel) {
      var t = el('table', { class: 'data compact' });
      t.appendChild(el('thead', null, [el('tr', null, ['Step', 'Detail', 'Amount / factor'].map(function (h) { return el('th', { text: h }); }))]));
      var tb = el('tbody');
      sheet.lines.forEach(function (l) { tb.appendChild(el('tr', null, [el('td', { text: l.label }), el('td', { text: l.detail }), el('td', { class: 'num', text: l.factorText })])); });
      tb.appendChild(el('tr', { class: 'total' }, [el('td', { text: totalLabel }), el('td', { text: '' }), el('td', { class: 'num', text: sheet.valueText })]));
      t.appendChild(tb);
      return t;
    }
    var total = 0, any = false;
    box.appendChild(el('h3', { text: '1. Land value = rate × parcel area' }));
    var ls = Formula.landSheet(Valuation.landValueFor(proj, p), proj.currency);
    if (!ls.ok) box.appendChild(el('p', { class: 'help', text: 'Cannot value land: ' + ls.notes.join('; ') })); else { box.appendChild(table(ls, 'Land value')); total += ls.value; any = true; }
    ls.notes.forEach(function (n) { if (ls.ok) box.appendChild(el('p', { class: 'help', text: n })); });
    box.appendChild(el('h3', { text: '2. Building value = ' + (modelForPrediction() ? Formula.formulaText(modelForPrediction().form, 'built area').replace('Value = ', '') : 'formula') }));
    var m = modelForPrediction();
    if (!m) box.appendChild(el('p', { class: 'help', text: 'Model not fitted.' }));
    else {
      var sheet = Formula.calculationSheet(m, { area: p.builtArea_m2, chars: charsFor(p) }, proj.currency, 'Built area');
      if (!sheet.ok) box.appendChild(el('p', { class: 'help', text: 'Cannot value buildings: ' + sheet.notes.join('; ') }));
      else { box.appendChild(table(sheet, 'Building value')); sheet.notes.forEach(function (n) { box.appendChild(el('p', { class: 'help', text: n })); }); total += sheet.value; any = true; }
    }
    if (any) box.appendChild(el('p', { class: 'grand', text: 'Total value (land + buildings): ' + money(total) }));
    $('#sheet-dialog').showModal();
  }

  /* ------------------------------------------------------------------ */
  /* Import dialog                                                       */
  /* ------------------------------------------------------------------ */

  function openImportDialog(parsed) {
    state.pendingImport = parsed;
    var guess = IO.guessMapping(parsed.headers);
    $('#import-summary').textContent = parsed.rows.length + ' rows, ' + parsed.headers.length + ' columns (sheet "' + parsed.sheet + '").';
    var mt = $('#import-mapping tbody'); mt.innerHTML = '';
    IO.FIELDS.forEach(function (f) {
      var sel = el('select', { 'data-field': f.key }, [el('option', { value: '', text: '– none –' })].concat(parsed.headers.map(function (h) { return el('option', { value: h, text: h }); })));
      sel.value = guess[f.key] || '';
      sel.addEventListener('change', refreshExtras);
      mt.appendChild(el('tr', null, [el('td', { text: f.label }), el('td', null, [sel])]));
    });
    function refreshExtras() {
      var mapped = {};
      $all('#import-mapping select').forEach(function (s) { if (s.value) mapped[s.value] = true; });
      var et = $('#import-extras tbody'); et.innerHTML = '';
      parsed.headers.forEach(function (h) {
        if (mapped[h]) return;
        var type = IO.detectType(parsed.rows.map(function (r) { return r[h]; }));
        var existing = state.project.features.find(function (f) { return f.name.toLowerCase() === h.toLowerCase(); });
        var typeSel = el('select', null, ['categorical', 'boolean', 'numeric'].map(function (t) { return el('option', { value: t, text: t }); }));
        typeSel.value = existing ? existing.type : type;
        et.appendChild(el('tr', { 'data-header': h }, [
          el('td', null, [el('input', { type: 'checkbox', class: 'extra-check', checked: true })]),
          el('td', { text: h + (existing ? ' (matches existing characteristic)' : '') }),
          el('td', null, [typeSel])
        ]));
      });
    }
    refreshExtras();
    $('#import-replace').checked = false;
    $('#import-dialog').showModal();
  }

  function confirmImport() {
    var parsed = state.pendingImport; if (!parsed) return;
    var mapping = {};
    $all('#import-mapping select').forEach(function (s) { if (s.value) mapping[s.getAttribute('data-field')] = s.value; });
    var extras = [];
    $all('#import-extras tbody tr').forEach(function (tr) {
      if (!$('.extra-check', tr).checked) return;
      extras.push({ header: tr.getAttribute('data-header'), type: $('select', tr).value });
    });
    var res = IO.applyMapping(parsed, mapping, extras, state.project.features);
    res.features.forEach(addFeature);
    if ($('#import-replace').checked) state.project.properties = [];
    state.project.properties = state.project.properties.concat(res.properties);
    var located = 0;
    res.properties.forEach(function (p) { if (p.locationSource !== 'imported' && locateProperty(p, false)) located++; });
    state.pendingImport = null;
    state.selectedId = null;
    markDirty(true);
    renderAll();
    Mapping.fitAll(state.project.properties);
    toast('Imported ' + res.properties.length + ' properties' + (res.features.length ? ' and ' + res.features.length + ' characteristics' : '') + (located ? '; ' + located + ' assigned to an Area' : '') + '.' + (res.warnings.length ? ' ' + res.warnings.length + ' warning(s): ' + res.warnings.slice(0, 3).join('; ') : ''));
  }

  /* ------------------------------------------------------------------ */
  /* Top-level rendering and wiring                                      */
  /* ------------------------------------------------------------------ */

  function renderHeader() {
    var proj = state.project;
    document.body.classList.toggle('mode-simple', !isAdvanced());
    document.body.classList.toggle('mode-advanced', isAdvanced());
    $all('#mode-toggle button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === proj.mode); });
    Mapping.showSectors(isAdvanced() && proj.landRates.level === 'sector');
    $('#project-name').value = proj.name || '';
    $('#currency').value = proj.currency || 'MWK';
    $('#valuer-name').value = proj.valuer.name || '';
    $('#valuer-registration').value = proj.valuer.registration || '';
    $('#valuation-date').value = proj.valuer.valuationDate || '';
    $('#validity-months').value = proj.valuer.validityMonths || 12;
    var tabBtn = $('.tabs button[data-tab="' + state.currentTab + '"]');
    if (tabBtn && tabBtn.hasAttribute('data-advanced') && !isAdvanced()) showTab('properties');
  }

  function renderAll() {
    renderHeader(); renderProperties(); renderDetail(); renderRates(); renderFeatures(); renderModel(); renderResults();
    Mapping.render(state.project.properties, selected());
  }

  function showTab(name) {
    state.currentTab = name;
    $all('.tabs button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === name); });
    $all('.tab').forEach(function (t) { t.classList.toggle('on', t.id === 'tab-' + name); });
    if (name === 'properties') Mapping.invalidate();
    if (name === 'results') { if (!state.project.model.fit) fitModel(true); else renderResults(); }
    if (name === 'model') renderModel();
    if (name === 'features') renderFeatures();
    if (name === 'rates') renderRates();
  }

  function setMode(mode) {
    state.project.mode = mode;
    save();
    renderHeader(); renderDetail();
    if (mode === 'advanced' && !state.project.model.fit) fitModel(true);
  }

  function wire() {
    $all('.tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); }); });
    $all('#mode-toggle button').forEach(function (b) { b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); }); });
    $('#project-name').addEventListener('change', function (e) { state.project.name = e.target.value; save(); });
    $('#currency').addEventListener('change', function (e) { state.project.currency = e.target.value || 'MWK'; save(); renderModel(); renderResults(); renderRates(); });
    $('#value-basis').addEventListener('change', function (e) { state.project.valueBasis = e.target.value; save(); renderDetail(); });
    ['valuer-name', 'valuer-registration', 'valuation-date', 'validity-months'].forEach(function (id) {
      $('#' + id).addEventListener('change', function (e) {
        var v = state.project.valuer;
        if (id === 'valuer-name') v.name = e.target.value; else if (id === 'valuer-registration') v.registration = e.target.value; else if (id === 'valuation-date') v.valuationDate = e.target.value; else v.validityMonths = numOrNull(e.target.value) || 12;
        save();
      });
    });

    $('#btn-new').addEventListener('click', function () {
      if (!confirm('Start a new empty project? Unsaved work in the current project will be lost (save it first if needed).')) return;
      Storage.clearProject().then(function () { state.project = newProject(); state.selectedId = null; renderAll(); save(); toast('New project started.'); });
    });
    $('#btn-save').addEventListener('click', function () {
      Storage.exportProjectFile(state.project).then(function (json) {
        var name = (state.project.name || 'valuation-project').replace(/[^a-z0-9_-]+/gi, '_');
        Storage.downloadText(name + '_' + new Date().toISOString().slice(0, 10) + '.json', json, 'application/json');
      });
    });
    $('#btn-open').addEventListener('click', function () { $('#file-open').click(); });
    $('#file-open').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      f.text().then(Storage.importProjectFile).then(function (p) { state.project = upgradeProject(p); state.selectedId = null; renderAll(); save(); toast('Project loaded: ' + p.properties.length + ' properties.'); })
        .catch(function (err) { toast('Could not open project: ' + err.message, true); });
      e.target.value = '';
    });

    $('#btn-import').addEventListener('click', function () { $('#file-import').click(); });
    $('#file-import').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      IO.readFile(f).then(openImportDialog).catch(function (err) { toast('Could not read file: ' + err.message, true); });
      e.target.value = '';
    });
    $('#import-cancel').addEventListener('click', function () { $('#import-dialog').close(); });
    $('#import-form').addEventListener('submit', function (e) { e.preventDefault(); $('#import-dialog').close(); confirmImport(); });

    $('#btn-add-property').addEventListener('click', function () {
      var p = newProperty(); p.plotNo = 'NEW-' + (state.project.properties.length + 1);
      state.project.properties.push(p); save(); renderProperties(); selectProperty(p.id); showTab('properties');
    });
    $('#btn-delete-property').addEventListener('click', function () {
      var p = selected(); if (!p) { toast('Select a property first.', true); return; }
      if (!confirm('Delete property ' + p.plotNo + '?')) return;
      (p.photoIds || []).forEach(Storage.deletePhoto);
      state.project.properties = state.project.properties.filter(function (x) { return x.id !== p.id; });
      state.selectedId = null; markDirty(true); renderProperties(); renderDetail(); Mapping.render(state.project.properties, null);
    });
    $('#btn-locate-all').addEventListener('click', function () {
      var n = locateAll(false);
      markDirty(true); renderProperties(); renderDetail(); renderRates();
      var unset = state.project.properties.filter(function (p) { return p.areaId === null; }).length;
      toast(n + ' properties assigned or updated' + (unset ? '; ' + unset + ' still without an Area (no position and no recognisable plot number)' : '') + '.');
    });
    $('#btn-fit-map').addEventListener('click', function () { Mapping.fitAll(state.project.properties); });
    $('#property-search').addEventListener('input', function (e) { state.filter = e.target.value; renderProperties(); });

    $('#tool-pin').addEventListener('click', function () { armTool('pin', '#tool-pin'); });
    $('#tool-roof').addEventListener('click', function () { armTool('roof', '#tool-roof'); });
    $('#tool-parcel').addEventListener('click', function () { armTool('parcel', '#tool-parcel'); });
    $('#tool-cancel').addEventListener('click', function () { Mapping.cancelTool(); disarm(); });
    $('#tool-locate').addEventListener('click', function () {
      if (!requireSelected()) return;
      Mapping.locateDevice().then(function (pos) { onPin(pos.lat, pos.lng); Mapping.focus(selected()); toast('Location set (±' + Math.round(pos.accuracy) + ' m).'); })
        .catch(function (err) { toast(err.message, true); });
    });

    // land rates
    $all('#rate-level-toggle button').forEach(function (b) { b.addEventListener('click', function () { state.project.landRates.level = b.getAttribute('data-level'); markDirty(true); renderRates(); renderHeader(); }); });
    $('#rate-uplift').addEventListener('change', function (e) { var v = numOrNull(e.target.value); if (v === null || v < 0) { toast('Enter an uplift factor of 0 or more.', true); return; } state.project.landRates.upliftFactor = v; markDirty(true); renderRates(); });
    $('#rate-default').addEventListener('change', function (e) { var v = numOrNull(e.target.value); if (v === null || v < 0) { toast('Enter a default rate of 0 or more.', true); return; } state.project.landRates.defaultRate = v; markDirty(true); renderRates(); });
    $('#btn-rates-reset').addEventListener('click', function () {
      if (!window.LAND_RATES_DEFAULT) { toast('Default rates are not available.', true); return; }
      if (!confirm('Replace all rates with the 2011 roll medians? Edited rates are lost; the uplift factor is kept.')) return;
      var keep = state.project.landRates;
      var fresh = Valuation.defaultSchedule(window.LAND_RATES_DEFAULT);
      fresh.level = keep.level; fresh.upliftFactor = keep.upliftFactor;
      state.project.landRates = fresh; markDirty(true); renderRates(); toast('Rates reset to the 2011 roll medians.');
    });
    $('#btn-rates-export').addEventListener('click', function () { var r = ratesExportRows(); IO.downloadTable('land_rates_' + state.project.landRates.level + '.csv', r.rows, r.headers, 'csv'); });
    $('#btn-rates-import').addEventListener('click', function () { $('#file-rates').click(); });
    $('#file-rates').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      IO.readFile(f).then(function (parsed) {
        var res = IO.parseRates(parsed);
        var lr = state.project.landRates;
        var target = res.level === 'sector' ? lr.sectors : lr.areas;
        var n = 0;
        Object.keys(res.entries).forEach(function (k) { if (k === '[settings]') return; target[k] = Object.assign({ n: null, p25: null, p75: null }, target[k] || {}, res.entries[k]); n++; });
        lr.level = res.level;
        markDirty(true); renderRates(); renderHeader();
        toast(n + ' ' + res.level + ' rates imported' + (res.skipped ? ' (' + res.skipped + ' rows skipped)' : '') + '.');
      }).catch(function (err) { toast('Could not import rates: ' + err.message, true); });
      e.target.value = '';
    });

    // features
    $('#btn-add-feature').addEventListener('click', function () {
      var name = prompt('Name of the characteristic (e.g. Wall material):'); if (!name) return;
      addFeature({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'feature', name: name.trim(), type: 'categorical', categories: [], baseCategory: null, isCondition: false });
      markDirty(false); renderFeatures();
    });
    $('#btn-suggest-features').addEventListener('click', function () {
      var added = 0;
      SUGGESTED_FEATURES.forEach(function (f) {
        if (state.project.features.some(function (x) { return x.name.toLowerCase() === f.name.toLowerCase(); })) return;
        addFeature(JSON.parse(JSON.stringify(f))); added++;
      });
      markDirty(false); renderFeatures();
      toast(added + ' suggested characteristics added. Adapt names and categories to Lilongwe before use.');
    });
    $('#btn-landuse-feature').addEventListener('click', function () {
      if (state.project.features.some(function (f) { return f.source === 'landuse'; })) { toast('Sector land use is already a characteristic.', true); return; }
      addFeature({ id: 'sector_land_use', name: 'Sector land use (planning)', type: 'categorical', categories: landUseCategories(), baseCategory: null, isCondition: false, source: 'landuse' });
      markDirty(true); renderFeatures();
      toast('Sector land use added as a characteristic. Properties need an Area/Sector for it to apply.');
    });

    // results
    $('#btn-export-roll-csv').addEventListener('click', function () { var r = rollExportRows(); IO.downloadTable('valuation_roll.csv', r.rows, r.headers, 'csv'); });
    $('#btn-export-roll-xlsx').addEventListener('click', function () {
      var r = rollExportRows(), w = weightsExportRows(), lr = ratesExportRows();
      IO.downloadWorkbook('valuation_roll.xlsx', [{ name: 'Valuation roll', rows: r.rows, headers: r.headers }, { name: 'Land rates', rows: lr.rows, headers: lr.headers }, { name: 'Weights', rows: w.rows, headers: w.headers }]);
    });
    $('#btn-export-weights').addEventListener('click', function () { var w = weightsExportRows(); if (!w.rows.length) { toast('Fit the model first.', true); return; } IO.downloadTable('valuation_weights.csv', w.rows, w.headers, 'csv'); });
    $('#btn-export-report').addEventListener('click', function () { Storage.downloadText('valuation_report.html', reportHtml(), 'text/html'); });

    $('#sheet-close').addEventListener('click', function () { $('#sheet-dialog').close(); });
    $('#sheet-print').addEventListener('click', function () { window.print(); });
  }

  function init() {
    Mapping.init('map', { onPin: onPin, onPolygon: onPolygon, onEdited: onEdited, onDeleted: onDeleted, onSelect: function (id) { selectProperty(id); } });
    wire();
    Storage.loadProject().then(function (p) {
      state.project = p ? upgradeProject(p) : newProject();
      renderAll();
      if (state.project.properties.length) Mapping.fitAll(state.project.properties);
    }).catch(function () { state.project = newProject(); renderAll(); });
  }

  window.App = { state: state, fitModel: fitModel, valueOf: valueOf, rollExportRows: rollExportRows, weightsExportRows: weightsExportRows, ratesExportRows: ratesExportRows, showTab: showTab, setMode: setMode, renderAll: renderAll, locateAll: locateAll, saveCurrentModel: saveCurrentModel };
  document.addEventListener('DOMContentLoaded', init);
}());
