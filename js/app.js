/*
 * app.js - user interface and application state for the Lilongwe Valuation
 * Formula Builder. Everything is plain DOM; no framework and no build step.
 */
(function () {
  'use strict';

  var PROJECT_VERSION = 1;
  var MODEL_KINDS = ['land', 'improvement'];
  var MODEL_LABEL = { land: 'Land model', improvement: 'Improvement (building) model' };
  var AREA_LABEL = { land: 'Land area (m²)', improvement: 'Built area (m²)' };
  var MAX_ROWS = 500;

  var state = { project: null, selectedId: null, filter: '', saveTimer: null, pendingImport: null, photoUrls: {} };

  /* ------------------------------------------------------------------ */
  /* Project model                                                       */
  /* ------------------------------------------------------------------ */

  function newModelSpec() { return { form: 'loglinear', smearing: false, included: {}, locks: {}, bases: {}, fit: null, fittedAt: null }; }

  function newProject() {
    return {
      version: PROJECT_VERSION, name: 'Council estates pilot', currency: 'MWK', valueBasis: 'annual_rental',
      features: [], properties: [], models: { land: newModelSpec(), improvement: newModelSpec() },
      createdAt: new Date().toISOString()
    };
  }

  function newProperty() {
    return {
      id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      plotNo: '', description: '', zone: '', lat: null, lng: null,
      roofPolygons: [], builtArea_m2: null, builtAreaSource: null, floors: null,
      parcelPolygon: null, landArea_m2: null, landAreaSource: null,
      landValue: null, improvementValue: null, totalValueEntered: null,
      characteristics: {}, photoIds: [], notes: ''
    };
  }

  function upgradeProject(p) {
    if (!p.models) p.models = {};
    MODEL_KINDS.forEach(function (k) { p.models[k] = Object.assign(newModelSpec(), p.models[k] || {}); });
    p.features = p.features || [];
    p.properties = (p.properties || []).map(function (x) { return Object.assign(newProperty(), x); });
    p.currency = p.currency || 'MWK';
    p.valueBasis = p.valueBasis || 'annual_rental';
    return p;
  }

  function findProperty(id) { return state.project.properties.find(function (p) { return p.id === id; }) || null; }
  function selected() { return state.selectedId ? findProperty(state.selectedId) : null; }

  var SUGGESTED_FEATURES = [
    { id: 'location_rating', name: 'Location rating', type: 'categorical', appliesTo: 'land', categories: ['Good', 'Average', 'Bad'], baseCategory: 'Average' },
    { id: 'street_paved', name: 'Street paved', type: 'boolean', appliesTo: 'both' },
    { id: 'street_condition', name: 'Street condition', type: 'categorical', appliesTo: 'both', categories: ['Good', 'Average', 'Bad'], baseCategory: 'Average', isCondition: true },
    { id: 'water_supply', name: 'Piped water supply', type: 'boolean', appliesTo: 'land' },
    { id: 'structure_type', name: 'Structure type', type: 'categorical', appliesTo: 'improvement', categories: ['Dwelling', 'Shop / office', 'Market / warehouse / industrial', 'Institutional', 'Other'], baseCategory: 'Dwelling' },
    { id: 'wall_material', name: 'Wall material', type: 'categorical', appliesTo: 'improvement', categories: ['Masonry / burnt brick / block', 'Mud / unburnt brick', 'Wood', 'Metal sheet / other'], baseCategory: 'Masonry / burnt brick / block' },
    { id: 'roof_material', name: 'Roof material', type: 'categorical', appliesTo: 'improvement', categories: ['Concrete / tile', 'Iron sheet', 'Asbestos', 'Thatch / other'], baseCategory: 'Iron sheet' },
    { id: 'windows', name: 'Windows (dominant type)', type: 'categorical', appliesTo: 'improvement', categories: ['Aluminium sliding / high value', 'Glazed casement / louvre', 'None / breeze block / wood'], baseCategory: 'Glazed casement / louvre' },
    { id: 'wall_condition', name: 'Wall condition', type: 'categorical', appliesTo: 'improvement', categories: ['Good', 'Average', 'Bad'], baseCategory: 'Average', isCondition: true },
    { id: 'fence', name: 'Permanent fence', type: 'boolean', appliesTo: 'improvement' },
    { id: 'security', name: 'Security features (guard post, wall, wire)', type: 'boolean', appliesTo: 'improvement' }
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

  var toastTimer = null;
  function toast(msg, isError) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false; t.className = isError ? 'error' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 7000 : 3500);
  }

  function markDirty(refit) {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () { Storage.saveProject(state.project); }, 400);
    if (refit) MODEL_KINDS.forEach(function (k) { if (state.project.models[k].fit) fitModel(k, true); });
  }

  /* ------------------------------------------------------------------ */
  /* Model data preparation and fitting                                  */
  /* ------------------------------------------------------------------ */

  function modelFeatures(kind) {
    var spec = state.project.models[kind];
    return state.project.features.filter(function (f) { return f.appliesTo === kind || f.appliesTo === 'both'; })
      .map(function (f) { return Object.assign({}, f, { baseCategory: spec.bases[f.id] || f.baseCategory || null }); });
  }

  /* Characteristics for a property, including features that mirror the zone field */
  function effectiveChars(p) {
    var chars = p.characteristics || {};
    var zoneFeatures = state.project.features.filter(function (f) { return f.source === 'zone'; });
    if (!zoneFeatures.length) return chars;
    chars = Object.assign({}, chars);
    zoneFeatures.forEach(function (f) { if (p.zone) chars[f.id] = String(p.zone).trim(); else delete chars[f.id]; });
    return chars;
  }

  function modelRow(kind, p) {
    return {
      id: p.id,
      area: kind === 'land' ? p.landArea_m2 : p.builtArea_m2,
      value: kind === 'land' ? p.landValue : p.improvementValue,
      chars: effectiveChars(p)
    };
  }

  function zoneCategories() {
    var cats = {};
    state.project.properties.forEach(function (p) { if (p.zone && String(p.zone).trim()) cats[String(p.zone).trim()] = true; });
    return Object.keys(cats).sort();
  }

  function sampleRows(kind) {
    return state.project.properties.map(function (p) { return modelRow(kind, p); }).filter(function (r) { return numOrNull(r.value) !== null; });
  }

  function buildSpec(kind, formOverride) {
    var spec = state.project.models[kind];
    var form = formOverride || spec.form;
    var rows = sampleRows(kind);
    var columns = Engine.buildColumns(form, modelFeatures(kind), rows, AREA_LABEL[kind]);
    var locks = {};
    Object.keys(spec.locks).forEach(function (key) {
      var col = columns.find(function (c) { return c.key === key; });
      if (!col) return;
      if (formOverride && formOverride !== spec.form && (col.kind === 'area' || col.kind === 'intercept' || col.kind === 'numeric')) return; // units differ between forms
      var coef = Engine.displayToCoef(form, col, spec.locks[key]);
      if (coef !== null) locks[key] = coef;
    });
    return { form: form, columns: columns, included: spec.included, locks: locks, smearing: spec.smearing && form !== 'linear', rows: rows };
  }

  function fitModel(kind, silent) {
    var spec = state.project.models[kind];
    var s = buildSpec(kind);
    var fit = Engine.fit(s, s.rows);
    spec.fit = fit;
    spec.fittedAt = new Date().toISOString();
    if (!silent) toast(MODEL_LABEL[kind] + (fit.ok ? ' fitted on ' + fit.n + ' sample properties.' : ': nothing to fit yet.'), !fit.ok);
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () { Storage.saveProject(state.project); }, 400);
    renderModel(kind);
    renderRoll();
    return fit;
  }

  function modelForPrediction(kind) {
    var spec = state.project.models[kind];
    if (!spec.fit || !spec.fit.ok) return null;
    return { form: spec.fit.form, columns: spec.fit.columns, coef: spec.fit.coef, smearing: spec.fit.smearing };
  }

  function valueProperty(p) {
    var out = { land: null, improvement: null, total: null, flags: [] };
    var lm = modelForPrediction('land'), im = modelForPrediction('improvement');
    if (lm) {
      if (numOrNull(p.landArea_m2) === null) out.flags.push('no land area');
      else { var pl = Engine.predict(lm, modelRow('land', p)); if (pl.invalid) out.flags.push('land: ' + pl.invalid); else { out.land = pl.value; if (pl.missing.length) out.flags.push('land: missing ' + pl.missing.join(', ')); } }
    } else out.flags.push('land model not fitted');
    if (im) {
      if (numOrNull(p.builtArea_m2) === null) out.flags.push('no built area');
      else { var pi = Engine.predict(im, modelRow('improvement', p)); if (pi.invalid) out.flags.push('improvement: ' + pi.invalid); else { out.improvement = pi.value; if (pi.missing.length) out.flags.push('improvement: missing ' + pi.missing.join(', ')); } }
    } else out.flags.push('improvement model not fitted');
    if (out.land !== null || out.improvement !== null) out.total = (out.land || 0) + (out.improvement || 0);
    if ((out.land === null) !== (out.improvement === null)) out.flags.push('total is partial');
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: properties                                               */
  /* ------------------------------------------------------------------ */

  function isSample(p) { return numOrNull(p.landValue) !== null || numOrNull(p.improvementValue) !== null; }

  function filteredProperties() {
    var q = state.filter.trim().toLowerCase();
    if (!q) return state.project.properties;
    return state.project.properties.filter(function (p) {
      return [p.plotNo, p.description, p.zone, p.notes].some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
    });
  }

  function renderProperties() {
    var tbody = $('#property-table tbody');
    tbody.innerHTML = '';
    var list = filteredProperties();
    list.slice(0, MAX_ROWS).forEach(function (p) {
      var tr = el('tr', { class: 'selectable' + (p.id === state.selectedId ? ' selected' : ''), 'data-id': p.id, onclick: function () { selectProperty(p.id); } }, [
        el('td', { text: p.plotNo || '' }),
        el('td', { text: p.description || '' }),
        el('td', { text: p.zone || '' }),
        el('td', { class: 'num', text: fmt(p.builtArea_m2, 0) }),
        el('td', { class: 'num', text: fmt(p.landArea_m2, 0) }),
        el('td', { class: 'num', text: fmt(p.landValue, 0) }),
        el('td', { class: 'num', text: fmt(p.improvementValue, 0) }),
        el('td', { text: (p.lat !== null && p.lng !== null) ? '●' : '' })
      ]);
      tbody.appendChild(tr);
    });
    var n = state.project.properties.length, s = state.project.properties.filter(isSample).length;
    $('#property-count').textContent = n + ' properties, ' + s + ' with sample values' + (list.length > MAX_ROWS ? ' (showing first ' + MAX_ROWS + ' of ' + list.length + '; use search)' : '');
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

  function field(labelText, input) { return el('label', null, [labelText, input]); }

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
    if (!p) { box.appendChild(el('p', { class: 'muted', text: 'Select a property from the list, add one, or import a file.' })); return; }
    var proj = state.project;

    // identity
    box.appendChild(el('div', { class: 'grid' }, [
      field('Plot / property no.', textInput(p, 'plotNo')),
      field('Description', textInput(p, 'description')),
      field('Zone', textInput(p, 'zone')),
      field('Latitude', textInput(p, 'lat', { type: 'number', step: 'any', numeric: true, after: function () { Mapping.render(proj.properties, p); } })),
      field('Longitude', textInput(p, 'lng', { type: 'number', step: 'any', numeric: true, after: function () { Mapping.render(proj.properties, p); } }))
    ]));

    // areas
    var traced = tracedBuiltArea(p);
    var roofList = el('div');
    (p.roofPolygons || []).forEach(function (r, i) {
      roofList.appendChild(el('div', { class: 'inline' }, [
        el('span', { text: 'Rooftop ' + (i + 1) + ': ' + fmt(r.area_m2, 1) + ' m² × ' }),
        el('input', { type: 'number', class: 'short', min: 1, step: 1, value: r.floors || 1, onchange: function (e) { r.floors = Math.max(1, numOrNull(e.target.value) || 1); syncAreas(p); markDirty(true); renderDetail(); renderProperties(); Mapping.render(proj.properties, p); } }),
        el('span', { text: ' floor(s) = ' + fmt(r.area_m2 * (r.floors || 1), 1) + ' m²' }),
        el('button', { class: 'tiny secondary danger', text: 'remove', onclick: function () { p.roofPolygons.splice(i, 1); syncAreas(p); markDirty(true); renderDetail(); renderProperties(); Mapping.render(proj.properties, p); } })
      ]));
    });
    if (!(p.roofPolygons || []).length) roofList.appendChild(el('p', { class: 'muted small', text: 'No rooftop traced yet. Use "Trace rooftop" on the map (one shape per building), then set floors.' }));

    var builtInput = el('input', { type: 'number', step: 'any', min: 0, value: p.builtArea_m2 === null ? '' : p.builtArea_m2, onchange: function (e) {
      p.builtArea_m2 = numOrNull(e.target.value); p.builtAreaSource = p.builtArea_m2 === null ? null : 'manual'; markDirty(true); renderDetail(); renderProperties();
    } });
    var builtRow = el('div', { class: 'inline' }, [
      field('Built area (m²)', builtInput),
      el('span', { class: 'source-tag', text: p.builtAreaSource ? 'source: ' + p.builtAreaSource : 'not set' }),
      traced !== null && p.builtAreaSource !== 'traced' ? el('button', { class: 'tiny secondary', text: 'use traced (' + fmt(traced, 1) + ' m²)', onclick: function () { p.builtAreaSource = 'traced'; syncAreas(p); markDirty(true); renderDetail(); renderProperties(); } }) : null
    ]);
    box.appendChild(el('fieldset', null, [el('legend', { text: 'Building(s) and built area' }), roofList, builtRow]));

    var parcelInfo = p.parcelPolygon ? el('div', { class: 'inline' }, [
      el('span', { text: 'Parcel traced: ' + fmt(p.parcelPolygon.area_m2, 1) + ' m²' }),
      el('button', { class: 'tiny secondary danger', text: 'remove', onclick: function () { p.parcelPolygon = null; syncAreas(p); markDirty(true); renderDetail(); renderProperties(); Mapping.render(proj.properties, p); } })
    ]) : el('p', { class: 'muted small', text: 'No parcel traced yet. Use "Trace parcel" on the map.' });
    var landInput = el('input', { type: 'number', step: 'any', min: 0, value: p.landArea_m2 === null ? '' : p.landArea_m2, onchange: function (e) {
      p.landArea_m2 = numOrNull(e.target.value); p.landAreaSource = p.landArea_m2 === null ? null : 'manual'; markDirty(true); renderDetail(); renderProperties();
    } });
    var landRow = el('div', { class: 'inline' }, [
      field('Land area (m²)', landInput),
      el('span', { class: 'source-tag', text: p.landAreaSource ? 'source: ' + p.landAreaSource : 'not set' }),
      p.parcelPolygon && p.landAreaSource !== 'traced' ? el('button', { class: 'tiny secondary', text: 'use traced (' + fmt(p.parcelPolygon.area_m2, 1) + ' m²)', onclick: function () { p.landAreaSource = 'traced'; syncAreas(p); markDirty(true); renderDetail(); renderProperties(); } }) : null
    ]);
    box.appendChild(el('fieldset', null, [el('legend', { text: 'Land parcel' }), parcelInfo, landRow]));

    // sample values
    var basis = proj.valueBasis === 'capital' ? 'capital value' : 'annual rental value';
    box.appendChild(el('fieldset', null, [
      el('legend', { text: 'Sample values (' + proj.currency + ', ' + basis + ') – optional, valuer-assessed' }),
      el('div', { class: 'grid' }, [
        field('Land value', textInput(p, 'landValue', { type: 'number', step: 'any', numeric: true, refit: true })),
        field('Improvement (building) value', textInput(p, 'improvementValue', { type: 'number', step: 'any', numeric: true, refit: true })),
        field('Total entered (if not split)', textInput(p, 'totalValueEntered', { type: 'number', step: 'any', numeric: true }))
      ]),
      el('p', { class: 'muted small', text: 'Leave blank for properties that are not in the valuer\'s sample. Land and improvement are fitted as separate models.' })
    ]));

    // characteristics
    var charBox = el('div', { class: 'grid' });
    if (!proj.features.length) charBox.appendChild(el('p', { class: 'muted small', text: 'No characteristics defined yet (see tab 2).' }));
    proj.features.forEach(function (f) {
      if (f.source === 'zone') { charBox.appendChild(field(f.name + ' (' + f.appliesTo + ')', el('input', { type: 'text', disabled: true, value: p.zone || '', title: 'Taken from the Zone field above' }))); return; }
      var cur = p.characteristics[f.id];
      var input;
      if (f.type === 'numeric') input = el('input', { type: 'number', step: 'any', value: cur === undefined || cur === null ? '' : cur, onchange: function (e) { setChar(p, f.id, numOrNull(e.target.value)); } });
      else if (f.type === 'boolean') input = el('select', { onchange: function (e) { setChar(p, f.id, e.target.value || null); } }, [el('option', { value: '', text: '– not recorded –' }), el('option', { value: 'Yes', text: 'Yes' }), el('option', { value: 'No', text: 'No' })]);
      else input = el('select', { onchange: function (e) { setChar(p, f.id, e.target.value || null); } }, [el('option', { value: '', text: '– not recorded –' })].concat((f.categories || []).map(function (c) { return el('option', { value: c, text: c }); })));
      if (f.type !== 'numeric') input.value = cur === undefined || cur === null ? '' : String(cur);
      charBox.appendChild(field(f.name + ' (' + f.appliesTo + ')', input));
    });
    box.appendChild(el('fieldset', null, [el('legend', { text: 'Characteristics' }), charBox]));

    // photos
    var photoBox = el('div', { class: 'photos' });
    (p.photoIds || []).forEach(function (id) {
      var img = el('img', { alt: 'property photo' });
      loadPhotoUrl(id).then(function (url) { if (url) img.src = url; });
      photoBox.appendChild(el('div', { class: 'photo' }, [img, el('button', { class: 'tiny secondary danger', text: '×', title: 'Remove photo', onclick: function () {
        p.photoIds = p.photoIds.filter(function (x) { return x !== id; }); Storage.deletePhoto(id); markDirty(false); renderDetail();
      } })]));
    });
    var photoInput = el('input', { type: 'file', accept: 'image/*', multiple: true, onchange: function (e) { addPhotos(p, e.target.files); } });
    box.appendChild(el('fieldset', null, [el('legend', { text: 'Photos' }), photoInput, photoBox]));

    // notes
    var notes = el('textarea', { rows: 2, style: 'width:100%', onchange: function (e) { p.notes = e.target.value; markDirty(false); } });
    notes.value = p.notes || '';
    box.appendChild(el('fieldset', null, [el('legend', { text: 'Notes' }), notes]));

    // predicted values (if models fitted)
    var v = valueProperty(p);
    if (v.total !== null) {
      box.appendChild(el('fieldset', null, [el('legend', { text: 'Formula value (current models)' }),
        el('div', { class: 'inline' }, [el('span', { text: 'Land: ' + money(v.land) }), el('span', { text: 'Improvement: ' + money(v.improvement) }), el('strong', { text: 'Total: ' + money(v.total) }),
          el('button', { class: 'tiny secondary', text: 'calculation sheet', onclick: function () { showSheet(p); } })]),
        v.flags.length ? el('p', { class: 'muted small', text: v.flags.join('; ') }) : null]));
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

  function onPin(lat, lng) {
    var p = selected(); if (!p) return;
    p.lat = lat; p.lng = lng;
    $all('.map-tools button').forEach(function (b) { b.classList.remove('armed'); });
    markDirty(false); renderDetail(); renderProperties(); Mapping.render(state.project.properties, p);
  }

  function onPolygon(type, geometry, area) {
    var p = selected(); if (!p) return;
    $all('.map-tools button').forEach(function (b) { b.classList.remove('armed'); });
    if (type === 'roof') p.roofPolygons.push({ geometry: geometry, area_m2: area, floors: 1 });
    else p.parcelPolygon = { geometry: geometry, area_m2: area };
    if (p.lat === null || p.lng === null) { var c = centroid(geometry); p.lat = c[0]; p.lng = c[1]; }
    syncAreas(p);
    markDirty(true); renderDetail(); renderProperties(); Mapping.render(state.project.properties, p);
    toast((type === 'roof' ? 'Rooftop' : 'Parcel') + ' traced: ' + fmt(area, 1) + ' m²');
  }

  function centroid(geometry) {
    var pts = geometry.coordinates[0]; var lat = 0, lng = 0;
    pts.forEach(function (c) { lng += c[0]; lat += c[1]; });
    return [lat / pts.length, lng / pts.length];
  }

  function onEdited(changes) {
    var p = selected(); if (!p) return;
    changes.forEach(function (ch) {
      if (ch.type === 'roof' && p.roofPolygons[ch.index]) { p.roofPolygons[ch.index].geometry = ch.geometry; p.roofPolygons[ch.index].area_m2 = ch.area; }
      else if (ch.type === 'parcel' && p.parcelPolygon) { p.parcelPolygon.geometry = ch.geometry; p.parcelPolygon.area_m2 = ch.area; }
      else if (ch.type === 'pin') { p.lat = ch.lat; p.lng = ch.lng; }
    });
    syncAreas(p); markDirty(true); renderDetail(); renderProperties(); Mapping.render(state.project.properties, p);
  }

  function onDeleted(removed) {
    var p = selected(); if (!p) return;
    var roofIdx = removed.filter(function (r) { return r.type === 'roof'; }).map(function (r) { return r.index; }).sort(function (a, b) { return b - a; });
    roofIdx.forEach(function (i) { p.roofPolygons.splice(i, 1); });
    if (removed.some(function (r) { return r.type === 'parcel'; })) p.parcelPolygon = null;
    if (removed.some(function (r) { return r.type === 'pin'; })) { p.lat = null; p.lng = null; }
    syncAreas(p); markDirty(true); renderDetail(); renderProperties(); Mapping.render(state.project.properties, p);
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: features                                                 */
  /* ------------------------------------------------------------------ */

  function renderFeatures() {
    var tbody = $('#feature-table tbody');
    tbody.innerHTML = '';
    var proj = state.project;
    proj.features.forEach(function (f, idx) {
      if (f.source === 'zone') f.categories = zoneCategories();
      var catInput = el('input', { type: 'text', value: (f.categories || []).join(', '), placeholder: 'e.g. Good, Average, Bad', style: 'width: 100%', disabled: f.type !== 'categorical' || f.source === 'zone', title: f.source === 'zone' ? 'Categories follow the Zone field of the properties' : null, onchange: function (e) {
        f.categories = e.target.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        if (f.baseCategory && f.categories.indexOf(f.baseCategory) < 0) f.baseCategory = null;
        markDirty(true); renderFeatures();
      } });
      var baseSel = el('select', { disabled: f.type !== 'categorical', onchange: function (e) { f.baseCategory = e.target.value || null; markDirty(true); } },
        [el('option', { value: '', text: 'base: most common' })].concat((f.categories || []).map(function (c) { return el('option', { value: c, text: 'base: ' + c }); })));
      baseSel.value = f.baseCategory || '';
      var typeSel = el('select', { disabled: f.source === 'zone', onchange: function (e) { f.type = e.target.value; if (f.type !== 'categorical') { f.categories = []; f.baseCategory = null; } markDirty(true); renderFeatures(); } },
        ['categorical', 'boolean', 'numeric'].map(function (t) { return el('option', { value: t, text: t }); }));
      typeSel.value = f.type;
      var applySel = el('select', { onchange: function (e) { f.appliesTo = e.target.value; markDirty(true); } },
        [['land', 'Land'], ['improvement', 'Improvement'], ['both', 'Both']].map(function (a) { return el('option', { value: a[0], text: a[1] }); }));
      applySel.value = f.appliesTo || 'improvement';
      var cond = el('input', { type: 'checkbox', checked: !!f.isCondition, onchange: function (e) { f.isCondition = e.target.checked; markDirty(false); renderFeatures(); } });
      tbody.appendChild(el('tr', null, [
        el('td', null, [el('input', { type: 'text', value: f.name, onchange: function (e) { f.name = e.target.value; markDirty(true); } }), f.source === 'zone' ? el('div', { class: 'muted small', text: 'mirrors the Zone field' }) : null]),
        el('td', null, [typeSel]),
        el('td', null, [applySel]),
        el('td', null, [el('div', { class: 'inline' }, [catInput, baseSel])]),
        el('td', null, [cond]),
        el('td', null, [el('button', { class: 'tiny secondary danger', text: 'delete', onclick: function () {
          if (!confirm('Delete characteristic "' + f.name + '"? Values recorded for it on properties are removed.')) return;
          proj.features.splice(idx, 1);
          proj.properties.forEach(function (p) { delete p.characteristics[f.id]; });
          markDirty(true); renderFeatures();
        } })])
      ]));
    });
    $('#condition-notice').hidden = !proj.features.some(function (f) { return f.isCondition; });
  }

  function addFeature(f) {
    var proj = state.project;
    var base = f.id; var n = 1;
    while (proj.features.some(function (x) { return x.id === f.id; })) f.id = base + '_' + (++n);
    proj.features.push(f);
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: models                                                   */
  /* ------------------------------------------------------------------ */

  function renderModels() { MODEL_KINDS.forEach(renderModel); }

  function renderModel(kind) {
    var card = $('#model-' + kind);
    var spec = state.project.models[kind];
    var proj = state.project;
    card.innerHTML = '';
    var rows = sampleRows(kind);
    card.appendChild(el('h3', null, [MODEL_LABEL[kind], el('span', { class: 'muted small', text: rows.length + ' sample properties with a ' + kind + ' value' })]));

    var formSel = el('select', { id: 'form-' + kind, onchange: function (e) {
      spec.form = e.target.value;
      // area / base locks are in form-specific units: drop them on a form change
      Object.keys(spec.locks).forEach(function (k) { if (k === 'area' || k === 'intercept' || k.indexOf('f:') === 0 && proj.features.some(function (f) { return f.type === 'numeric' && k === 'f:' + f.id; })) delete spec.locks[k]; });
      fitModel(kind, true);
    } }, [['loglinear', 'Log-linear (default)'], ['loglog', 'Log-log (LoGRI guidance)'], ['linear', 'Linear']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
    formSel.value = spec.form;
    var smear = el('input', { type: 'checkbox', checked: !!spec.smearing, disabled: spec.form === 'linear', onchange: function (e) { spec.smearing = e.target.checked; fitModel(kind, true); } });
    card.appendChild(el('div', { class: 'model-controls' }, [
      el('label', null, ['Model form ', formSel]),
      el('label', { title: 'Duan smearing: corrects the downward bias of exponentiated log predictions. Off by default to match the LoGRI guidance note.' }, [smear, ' Bias correction (smearing)']),
      el('button', { id: 'fit-' + kind, text: 'Fit / refit', onclick: function () { fitModel(kind, false); } }),
      el('button', { id: 'compare-' + kind, class: 'secondary', text: 'Compare forms', onclick: function () { renderCompare(kind, card); } })
    ]));
    card.appendChild(el('p', { class: 'muted small', text: Formula.formDescription(spec.form) }));

    var fit = spec.fit;
    if (!fit) { card.appendChild(el('p', { class: 'muted', text: 'Not fitted yet. Enter ' + kind + ' values and areas for sample properties, then click Fit.' })); return; }
    if (fit.warnings && fit.warnings.length) card.appendChild(el('div', { class: 'warnings' }, [el('strong', { text: 'Check:' }), el('ul', null, fit.warnings.map(function (w) { return el('li', { text: w }); }))]));
    if (!fit.ok) return;

    card.appendChild(el('div', { class: 'formula', id: 'formula-' + kind, text: Formula.formulaText(fit.form, AREA_LABEL[kind].replace(' (m²)', '')) }));
    var stats = el('div', { class: 'stats', id: 'stats-' + kind });
    Formula.fitSummary(fit, proj.currency).forEach(function (s) {
      stats.appendChild(el('div', { class: 'stat', title: s.help }, [el('div', { class: 'label', text: s.label }), el('div', { class: 'value', text: s.value })]));
    });
    card.appendChild(stats);
    if (fit.excluded && fit.excluded.length) card.appendChild(el('details', null, [el('summary', { text: fit.excluded.length + ' sample propert' + (fit.excluded.length === 1 ? 'y' : 'ies') + ' excluded from the fit' }),
      el('ul', { class: 'small' }, fit.excluded.map(function (x) { var p = findProperty(x.id); return el('li', { text: (p ? p.plotNo : x.id) + ': ' + x.reason }); }))]));

    // weights table
    var table = el('table', { class: 'compact weights', id: 'weights-' + kind });
    table.appendChild(el('thead', null, [el('tr', null, ['Term', 'n', 'In model', 'Weight', 'Lock', 'Locked value', 'Std. error', 'p-value', 'Confidence'].map(function (h) { return el('th', { text: h }); }))]));
    var tbody = el('tbody');
    Formula.weightsTable(fit, proj.currency).forEach(function (w) {
      var c = w.column;
      var isBase = c.isBase;
      var incl = el('input', { type: 'checkbox', checked: w.status !== 'excluded', disabled: isBase || c.kind === 'intercept' || c.kind === 'area', onchange: function (e) { spec.included[c.key] = e.target.checked; fitModel(kind, true); } });
      var lockChk = el('input', { type: 'checkbox', checked: w.status === 'locked', disabled: isBase || w.status === 'excluded', onchange: function (e) {
        if (e.target.checked) { var d = w.display; spec.locks[c.key] = d === null ? 0 : Math.round(d * 1000) / 1000; } else delete spec.locks[c.key];
        fitModel(kind, true);
      } });
      var lockVal = el('input', { type: 'number', step: 'any', class: 'short', disabled: w.status !== 'locked', value: w.status === 'locked' ? spec.locks[c.key] : '', onchange: function (e) {
        var v = numOrNull(e.target.value); if (v === null) return; spec.locks[c.key] = v; fitModel(kind, true);
      } });
      var unitText = w.status === 'locked' ? ' ' + w.unit.replace('currency', proj.currency) : '';
      tbody.appendChild(el('tr', { class: 'status-' + w.status }, [
        el('td', { text: c.label + (isBase ? ' (base)' : '') }),
        el('td', { class: 'num', text: c.kind === 'category' ? String(w.count || 0) : '' }),
        el('td', null, [incl]),
        el('td', { class: 'num', text: w.status === 'excluded' ? '–' : w.weightText }),
        el('td', null, [lockChk]),
        el('td', null, [lockVal, el('span', { class: 'muted small', text: unitText })]),
        el('td', { class: 'num', text: w.se === null || w.se === undefined ? '–' : fmt(w.se, 4) }),
        el('td', { class: 'num', text: Formula.fmtP(w.p) }),
        el('td', null, [el('span', { class: 'badge ' + w.significance.code, text: w.significance.label })])
      ]));
    });
    table.appendChild(tbody);
    card.appendChild(el('div', { class: 'table-wrap' }, [table]));
    card.appendChild(el('p', { class: 'muted small', text: 'Weights for log forms are percentages relative to the base property; the base value is the value of a base property before the area term. Locking a weight fixes it at the value you type and refits the other weights around it (offset method).' }));

    // sample fit table
    var st = el('table', { class: 'compact' });
    st.appendChild(el('thead', null, [el('tr', null, ['Plot no.', 'Actual', 'Predicted', 'Ratio', 'Leave-one-out'].map(function (h) { return el('th', { text: h }); }))]));
    var stb = el('tbody');
    fit.sample.forEach(function (s) {
      var p = findProperty(s.id);
      stb.appendChild(el('tr', null, [el('td', { text: p ? p.plotNo : s.id }), el('td', { class: 'num', text: money(s.actual) }), el('td', { class: 'num', text: money(s.predicted) }), el('td', { class: 'num', text: fmt(s.ratio, 3) }), el('td', { class: 'num', text: s.loo === null ? '–' : money(s.loo) })]));
    });
    st.appendChild(stb);
    card.appendChild(el('details', null, [el('summary', { text: 'Sample properties: actual vs predicted' }), el('div', { class: 'table-wrap' }, [st])]));
    card.appendChild(el('div', { class: 'compare', id: 'compare-box-' + kind }));
  }

  function renderCompare(kind, card) {
    var box = $('#compare-box-' + kind, card) || card.appendChild(el('div', { class: 'compare', id: 'compare-box-' + kind }));
    box.innerHTML = '';
    var results = Engine.FORMS.map(function (form) { var s = buildSpec(kind, form); var f = Engine.fit(s, s.rows); return { form: form, fit: f }; });
    if (!results.some(function (r) { return r.fit.ok; })) { box.appendChild(el('p', { class: 'muted', text: 'Nothing to compare yet.' })); return; }
    var t = el('table', { class: 'compact' });
    t.appendChild(el('thead', null, [el('tr', null, ['Form', 'R² (fit scale)', 'R² on values', 'RMSE', 'Leave-one-out RMSE', 'COD', 'PRD'].map(function (h) { return el('th', { text: h }); }))]));
    var tb = el('tbody');
    results.forEach(function (r) {
      var f = r.fit;
      tb.appendChild(el('tr', { class: r.form === state.project.models[kind].form ? 'selected' : '' }, [
        el('td', { text: { linear: 'Linear', loglinear: 'Log-linear', loglog: 'Log-log' }[r.form] }),
        el('td', { class: 'num', text: fmt(f.r2, 3) }), el('td', { class: 'num', text: fmt(f.r2Level, 3) }), el('td', { class: 'num', text: money(f.rmse) }),
        el('td', { class: 'num', text: f.loocvRmse === null ? '–' : money(f.loocvRmse) }), el('td', { class: 'num', text: fmt(f.cod, 1) + ' %' }), el('td', { class: 'num', text: fmt(f.prd, 3) })
      ]));
    });
    t.appendChild(tb);
    box.appendChild(el('div', { class: 'subhead' }, [el('strong', { text: 'Comparison of model forms (same terms and locks; area lock dropped where units differ)' })]));
    box.appendChild(t);
    box.appendChild(el('p', { class: 'muted small', text: 'R² on the fit scale is not comparable between log and linear forms; compare RMSE, leave-one-out RMSE and COD on values instead.' }));
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: valuation roll                                           */
  /* ------------------------------------------------------------------ */

  function rollRows() {
    return state.project.properties.map(function (p) {
      var v = valueProperty(p);
      var sampleTotal = (numOrNull(p.landValue) || 0) + (numOrNull(p.improvementValue) || 0);
      if (!isSample(p)) sampleTotal = null;
      return { p: p, v: v, sampleTotal: sampleTotal, ratio: (sampleTotal && v.total !== null) ? v.total / sampleTotal : null };
    });
  }

  function renderRoll() {
    var tbody = $('#roll-table tbody');
    tbody.innerHTML = '';
    var rows = rollRows();
    var totals = { land: 0, improvement: 0, total: 0, n: 0 };
    rows.forEach(function (r) { if (r.v.total !== null) { totals.n++; totals.land += r.v.land || 0; totals.improvement += r.v.improvement || 0; totals.total += r.v.total; } });
    rows.slice(0, MAX_ROWS).forEach(function (r) {
      var p = r.p;
      tbody.appendChild(el('tr', { class: r.v.total === null ? 'dim' : '' }, [
        el('td', { text: p.plotNo }), el('td', { text: p.description }), el('td', { text: p.zone }),
        el('td', { class: 'num', text: fmt(p.landArea_m2, 0) }), el('td', { class: 'num', text: fmt(p.builtArea_m2, 0) }),
        el('td', { class: 'num', text: fmt(r.v.land, 0) }), el('td', { class: 'num', text: fmt(r.v.improvement, 0) }), el('td', { class: 'num', text: fmt(r.v.total, 0) }),
        el('td', { class: 'num', text: fmt(r.sampleTotal, 0) }), el('td', { class: 'num', text: fmt(r.ratio, 3) }),
        el('td', { class: 'small', text: r.v.flags.join('; ') }),
        el('td', null, [r.v.total !== null ? el('button', { class: 'tiny secondary', text: 'sheet', onclick: function () { showSheet(p); } }) : null])
      ]));
    });
    $('#roll-summary').textContent = totals.n + ' of ' + rows.length + ' properties valued. Totals: land ' + money(totals.land) + ', improvements ' + money(totals.improvement) + ', all ' + money(totals.total) + (rows.length > MAX_ROWS ? '. Showing first ' + MAX_ROWS + ' rows; the export contains all.' : '.');
  }

  function rollExportRows() {
    var proj = state.project;
    var feats = proj.features;
    var headers = ['PlotNo', 'Description', 'Zone', 'Latitude', 'Longitude', 'LandArea_m2', 'LandAreaSource', 'BuiltArea_m2', 'BuiltAreaSource', 'Floors_traced',
      'LandValue_formula', 'ImprovementValue_formula', 'TotalValue_formula', 'LandValue_sample', 'ImprovementValue_sample', 'TotalValue_entered', 'Ratio_formula_to_sample', 'Flags', 'Notes', 'Photos']
      .concat(feats.map(function (f) { return 'char_' + f.name; }));
    var rows = rollRows().map(function (r) {
      var p = r.p;
      var o = {
        PlotNo: p.plotNo, Description: p.description, Zone: p.zone, Latitude: p.lat, Longitude: p.lng,
        LandArea_m2: p.landArea_m2, LandAreaSource: p.landAreaSource || '', BuiltArea_m2: p.builtArea_m2, BuiltAreaSource: p.builtAreaSource || '',
        Floors_traced: (p.roofPolygons || []).map(function (x) { return x.floors || 1; }).join('|'),
        LandValue_formula: r.v.land === null ? '' : Math.round(r.v.land), ImprovementValue_formula: r.v.improvement === null ? '' : Math.round(r.v.improvement), TotalValue_formula: r.v.total === null ? '' : Math.round(r.v.total),
        LandValue_sample: p.landValue, ImprovementValue_sample: p.improvementValue, TotalValue_entered: p.totalValueEntered,
        Ratio_formula_to_sample: r.ratio === null ? '' : Math.round(r.ratio * 1000) / 1000, Flags: r.v.flags.join('; '), Notes: p.notes, Photos: (p.photoIds || []).length
      };
      feats.forEach(function (f) { o['char_' + f.name] = p.characteristics[f.id] === undefined ? '' : p.characteristics[f.id]; });
      return o;
    });
    return { headers: headers, rows: rows };
  }

  function weightsExportRows() {
    var proj = state.project;
    var rows = [];
    MODEL_KINDS.forEach(function (kind) {
      var fit = proj.models[kind].fit;
      if (!fit || !fit.ok) return;
      Formula.weightsTable(fit, proj.currency).forEach(function (w) {
        rows.push({ Model: kind, Form: fit.form, Term: w.column.label, Kind: w.column.kind, Status: w.status, Weight_display: w.display === null ? '' : w.display, Unit: w.unit.replace('currency', proj.currency), Coefficient: w.coef, StdError: w.se === null ? '' : w.se, pValue: w.p === null ? '' : w.p, Confidence: w.significance.label, SampleCount: w.column.kind === 'category' ? w.count : '' });
      });
      rows.push({ Model: kind, Form: fit.form, Term: '[fit statistics]', Kind: '', Status: '', Weight_display: '', Unit: '', Coefficient: '', StdError: '', pValue: '', Confidence: 'n=' + fit.n + '; R2=' + fit.r2.toFixed(4) + '; adjR2=' + fit.adjR2.toFixed(4) + '; RMSE=' + Math.round(fit.rmse) + '; LOO_RMSE=' + (fit.loocvRmse === null ? 'NA' : Math.round(fit.loocvRmse)) + '; COD=' + fit.cod.toFixed(2) + '; PRD=' + fit.prd.toFixed(4) + '; smearing=' + fit.smearing.toFixed(4), SampleCount: '' });
    });
    return { headers: ['Model', 'Form', 'Term', 'Kind', 'Status', 'Weight_display', 'Unit', 'Coefficient', 'StdError', 'pValue', 'Confidence', 'SampleCount'], rows: rows };
  }

  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function reportHtml() {
    var proj = state.project;
    var h = ['<!DOCTYPE html><html><head><meta charset="utf-8"><title>Valuation model report – ' + esc(proj.name) + '</title>',
      '<style>body{font-family:system-ui,Arial,sans-serif;max-width:60rem;margin:2rem auto;color:#1f2933;font-size:14px}table{border-collapse:collapse;width:100%;margin:.6rem 0}th,td{border:1px solid #ccc;padding:.3rem .5rem;text-align:left}th{background:#f0f3f6}.num{text-align:right}.muted{color:#5f6b7a}.formula{font-family:monospace;background:#f0f3f6;padding:.4rem .6rem}</style></head><body>',
      '<h1>Valuation model report</h1><p><strong>' + esc(proj.name) + '</strong> · ' + esc(proj.currency) + ' · basis: ' + (proj.valueBasis === 'capital' ? 'capital value' : 'annual rental value') + ' · generated ' + new Date().toLocaleString('en-GB') + '</p>',
      '<p class="muted">Prepared with the Lilongwe Valuation Formula Builder. Under LGA 1998 s.67 and the Property Valuation Act 2024 the valuation must be designed, supervised and certified by a registered valuer; this report is a working document for that purpose.</p>'];
    MODEL_KINDS.forEach(function (kind) {
      var fit = proj.models[kind].fit;
      h.push('<h2>' + MODEL_LABEL[kind] + '</h2>');
      if (!fit || !fit.ok) { h.push('<p class="muted">Not fitted.</p>'); return; }
      h.push('<p>' + esc(Formula.formDescription(fit.form)) + '</p><p class="formula">' + esc(Formula.formulaText(fit.form, AREA_LABEL[kind].replace(' (m²)', ''))) + '</p>');
      h.push('<table><tr>' + Formula.fitSummary(fit, proj.currency).map(function (s) { return '<th>' + esc(s.label) + '</th>'; }).join('') + '</tr><tr>' + Formula.fitSummary(fit, proj.currency).map(function (s) { return '<td class="num">' + esc(s.value) + '</td>'; }).join('') + '</tr></table>');
      h.push('<table><tr><th>Term</th><th>n</th><th>Weight</th><th>Std. error</th><th>p-value</th><th>Confidence</th></tr>');
      Formula.weightsTable(fit, proj.currency).forEach(function (w) {
        if (w.status === 'excluded') return;
        h.push('<tr><td>' + esc(w.column.label) + (w.column.isBase ? ' (base)' : '') + '</td><td class="num">' + (w.column.kind === 'category' ? w.count : '') + '</td><td class="num">' + esc(w.weightText) + '</td><td class="num">' + (w.se === null ? '–' : fmt(w.se, 4)) + '</td><td class="num">' + esc(Formula.fmtP(w.p)) + '</td><td>' + esc(w.significance.label) + '</td></tr>');
      });
      h.push('</table>');
      if (fit.warnings.length) h.push('<p><strong>Checks:</strong></p><ul>' + fit.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>');
    });
    var rows = rollRows();
    var n = rows.filter(function (r) { return r.v.total !== null; }).length;
    h.push('<h2>Application</h2><p>' + n + ' of ' + rows.length + ' properties receive a formula value. Land and improvement values are reported separately in the exported roll (LGA s.68(1)).</p>');
    var cond = proj.features.filter(function (f) { return f.isCondition; });
    if (cond.length) h.push('<p><strong>Legal flag:</strong> condition variables in the model: ' + esc(cond.map(function (f) { return f.name; }).join(', ')) + '. Whether actual condition is a permitted input under the "reasonable condition" wording of the LGA is unresolved.</p>');
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
    box.className = 'sheet';
    box.appendChild(el('h3', { text: 'Calculation sheet – ' + (p.plotNo || '') + (p.description ? ' · ' + p.description : '') }));
    box.appendChild(el('p', { class: 'muted small', text: 'Zone: ' + (p.zone || '–') + ' · Land area: ' + fmt(p.landArea_m2, 1) + ' m² (' + (p.landAreaSource || 'not set') + ') · Built area: ' + fmt(p.builtArea_m2, 1) + ' m² (' + (p.builtAreaSource || 'not set') + ') · Basis: ' + (proj.valueBasis === 'capital' ? 'capital value' : 'annual rental value') }));
    var total = 0, any = false;
    MODEL_KINDS.forEach(function (kind) {
      var m = modelForPrediction(kind);
      box.appendChild(el('h4', { text: MODEL_LABEL[kind] }));
      if (!m) { box.appendChild(el('p', { class: 'muted', text: 'Model not fitted.' })); return; }
      var sheet = Formula.calculationSheet(m, modelRow(kind, p), proj.currency, AREA_LABEL[kind].replace(' (m²)', ''));
      if (!sheet.ok) { box.appendChild(el('p', { class: 'muted', text: 'Cannot value: ' + sheet.notes.join('; ') })); return; }
      var t = el('table', { class: 'compact' });
      t.appendChild(el('thead', null, [el('tr', null, ['Step', 'Detail', 'Amount / factor'].map(function (h) { return el('th', { text: h }); }))]));
      var tb = el('tbody');
      sheet.lines.forEach(function (l) { tb.appendChild(el('tr', null, [el('td', { text: l.label }), el('td', { text: l.detail }), el('td', { class: 'num', text: l.factorText })])); });
      tb.appendChild(el('tr', { class: 'total' }, [el('td', { text: kind === 'land' ? 'Land value' : 'Improvement value' }), el('td', { text: Formula.formulaText(m.form, AREA_LABEL[kind].replace(' (m²)', '')) }), el('td', { class: 'num', text: sheet.valueText })]));
      t.appendChild(tb);
      box.appendChild(t);
      sheet.notes.forEach(function (n) { box.appendChild(el('p', { class: 'muted small', text: n })); });
      total += sheet.value; any = true;
    });
    if (any) box.appendChild(el('p', null, [el('strong', { text: 'Total value (land + improvements): ' + money(total) })]));
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
        var applySel = el('select', null, [['improvement', 'Improvement'], ['land', 'Land'], ['both', 'Both']].map(function (a) { return el('option', { value: a[0], text: a[1] }); }));
        if (existing) applySel.value = existing.appliesTo;
        et.appendChild(el('tr', { 'data-header': h }, [
          el('td', null, [el('input', { type: 'checkbox', class: 'extra-check' })]),
          el('td', { text: h + (existing ? ' (matches existing characteristic)' : '') }),
          el('td', null, [typeSel]), el('td', null, [applySel])
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
      var sels = $all('select', tr);
      extras.push({ header: tr.getAttribute('data-header'), type: sels[0].value, appliesTo: sels[1].value });
    });
    var res = IO.applyMapping(parsed, mapping, extras, state.project.features);
    res.features.forEach(addFeature);
    if ($('#import-replace').checked) state.project.properties = [];
    state.project.properties = state.project.properties.concat(res.properties);
    state.pendingImport = null;
    state.selectedId = null;
    markDirty(true);
    renderAll();
    Mapping.fitAll(state.project.properties);
    toast('Imported ' + res.properties.length + ' properties' + (res.features.length ? ' and ' + res.features.length + ' characteristics' : '') + '.' + (res.warnings.length ? ' ' + res.warnings.length + ' warning(s): ' + res.warnings.slice(0, 3).join('; ') : ''));
  }

  /* ------------------------------------------------------------------ */
  /* Top-level rendering and wiring                                      */
  /* ------------------------------------------------------------------ */

  function renderHeader() {
    $('#project-name').value = state.project.name || '';
    $('#currency').value = state.project.currency || 'MWK';
    $('#value-basis').value = state.project.valueBasis || 'annual_rental';
  }

  function renderAll() {
    renderHeader(); renderProperties(); renderDetail(); renderFeatures(); renderModels(); renderRoll();
    Mapping.render(state.project.properties, selected());
  }

  function showTab(name) {
    $all('.tabs button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name); });
    $all('.tab').forEach(function (t) { t.classList.toggle('active', t.id === 'tab-' + name); });
    if (name === 'properties') Mapping.invalidate();
    if (name === 'roll') renderRoll();
    if (name === 'models') renderModels();
    if (name === 'features') renderFeatures();
  }

  function wire() {
    $all('.tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); }); });
    $('#project-name').addEventListener('change', function (e) { state.project.name = e.target.value; markDirty(false); });
    $('#currency').addEventListener('change', function (e) { state.project.currency = e.target.value || 'MWK'; markDirty(false); renderModels(); renderRoll(); });
    $('#value-basis').addEventListener('change', function (e) { state.project.valueBasis = e.target.value; markDirty(false); });

    $('#btn-new').addEventListener('click', function () {
      if (!confirm('Start a new empty project? Unsaved work in the current project will be lost (save it first if needed).')) return;
      Storage.clearProject().then(function () { state.project = newProject(); state.selectedId = null; renderAll(); markDirty(false); toast('New project started.'); });
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
      f.text().then(Storage.importProjectFile).then(function (p) { state.project = upgradeProject(p); state.selectedId = null; renderAll(); markDirty(false); toast('Project loaded: ' + p.properties.length + ' properties.'); })
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
      state.project.properties.push(p); markDirty(false); renderProperties(); selectProperty(p.id); showTab('properties');
    });
    $('#btn-delete-property').addEventListener('click', function () {
      var p = selected(); if (!p) { toast('Select a property first.', true); return; }
      if (!confirm('Delete property ' + p.plotNo + '?')) return;
      (p.photoIds || []).forEach(Storage.deletePhoto);
      state.project.properties = state.project.properties.filter(function (x) { return x.id !== p.id; });
      state.selectedId = null; markDirty(true); renderProperties(); renderDetail(); Mapping.render(state.project.properties, null);
    });
    $('#btn-fit-map').addEventListener('click', function () { Mapping.fitAll(state.project.properties); });
    $('#property-search').addEventListener('input', function (e) { state.filter = e.target.value; renderProperties(); });

    $('#btn-split-totals').addEventListener('click', function () { $('#split-dialog').showModal(); });
    $('#split-cancel').addEventListener('click', function () { $('#split-dialog').close(); });
    $('#split-confirm').addEventListener('click', function (e) {
      e.preventDefault(); $('#split-dialog').close();
      var share = numOrNull($('#split-share').value); if (share === null || share < 0 || share > 100) { toast('Enter a land share between 0 and 100.', true); return; }
      var n = 0;
      state.project.properties.forEach(function (p) {
        if (numOrNull(p.totalValueEntered) === null || numOrNull(p.landValue) !== null || numOrNull(p.improvementValue) !== null) return;
        p.landValue = Math.round(p.totalValueEntered * share / 100); p.improvementValue = Math.round(p.totalValueEntered * (100 - share) / 100);
        p.notes = (p.notes ? p.notes + ' ' : '') + '[Land/improvement split from entered total at ' + share + '% land share on ' + new Date().toISOString().slice(0, 10) + '.]';
        n++;
      });
      markDirty(true); renderProperties(); renderDetail();
      toast(n + ' properties split at ' + share + '% land share.');
    });

    $('#tool-pin').addEventListener('click', function () { armTool('pin', '#tool-pin'); });
    $('#tool-roof').addEventListener('click', function () { armTool('roof', '#tool-roof'); });
    $('#tool-parcel').addEventListener('click', function () { armTool('parcel', '#tool-parcel'); });
    $('#tool-cancel').addEventListener('click', function () { Mapping.cancelTool(); $all('.map-tools button').forEach(function (b) { b.classList.remove('armed'); }); });
    $('#tool-locate').addEventListener('click', function () {
      if (!requireSelected()) return;
      Mapping.locateDevice().then(function (pos) { onPin(pos.lat, pos.lng); Mapping.focus(selected()); toast('Location set (±' + Math.round(pos.accuracy) + ' m).'); })
        .catch(function (err) { toast(err.message, true); });
    });

    $('#btn-add-feature').addEventListener('click', function () {
      var name = prompt('Name of the characteristic (e.g. Wall material):'); if (!name) return;
      addFeature({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'feature', name: name.trim(), type: 'categorical', appliesTo: 'improvement', categories: [], baseCategory: null, isCondition: false });
      markDirty(false); renderFeatures();
    });
    $('#btn-zone-feature').addEventListener('click', function () {
      if (state.project.features.some(function (f) { return f.source === 'zone'; })) { toast('The Zone field is already used as a characteristic.', true); return; }
      var cats = zoneCategories();
      if (!cats.length) { toast('No property has a Zone value yet.', true); return; }
      addFeature({ id: 'zone', name: 'Zone', type: 'categorical', appliesTo: 'land', categories: cats, baseCategory: null, isCondition: false, source: 'zone' });
      markDirty(true); renderFeatures();
      toast('Zone added as a land characteristic with ' + cats.length + ' categories. Merge zones with similar values into fewer categories if the sample is small.');
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

    $('#btn-export-roll-csv').addEventListener('click', function () { var r = rollExportRows(); IO.downloadTable('valuation_roll.csv', r.rows, r.headers, 'csv'); });
    $('#btn-export-roll-xlsx').addEventListener('click', function () {
      var r = rollExportRows(), w = weightsExportRows();
      IO.downloadWorkbook('valuation_roll.xlsx', [{ name: 'Valuation roll', rows: r.rows, headers: r.headers }, { name: 'Weights', rows: w.rows, headers: w.headers }]);
    });
    $('#btn-export-weights').addEventListener('click', function () { var w = weightsExportRows(); if (!w.rows.length) { toast('Fit a model first.', true); return; } IO.downloadTable('valuation_weights.csv', w.rows, w.headers, 'csv'); });
    $('#btn-export-report').addEventListener('click', function () { Storage.downloadText('valuation_model_report.html', reportHtml(), 'text/html'); });

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

  // expose a little for tests and debugging
  window.App = { state: state, fitModel: fitModel, valueProperty: valueProperty, rollExportRows: rollExportRows, weightsExportRows: weightsExportRows, showTab: showTab, renderAll: renderAll };
  document.addEventListener('DOMContentLoaded', init);
}());
