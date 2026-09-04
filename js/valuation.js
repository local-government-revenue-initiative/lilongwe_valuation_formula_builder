/*
 * valuation.js - the valuation logic that sits between the data and the UI:
 * land value from the rate schedule, improvement value from the fitted model,
 * and the residual samples used to fit that model. Pure functions, no DOM,
 * so the same file is unit-tested under Node.
 *
 * Method (Property Valuation Act 2024 s.22(4)): land by direct market
 * comparison using a schedule of land value per m² by Area or Sector; the
 * improvement value of sample properties is the residual of the valuer's
 * total value after deducting land; a regression calibrates the improvement
 * formula on those residuals and applies it to all properties.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.Valuation = factory(root.Engine);
}(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  var LAND_SHARE_WARN = 0.85;

  function num(v) { return Engine.toNumber(v); }

  /* Default schedule object for a new project, seeded from the QVR defaults if present */
  function defaultSchedule(defaults) {
    var s = { level: 'area', upliftFactor: 1, defaultRate: 600, areas: {}, sectors: {}, defaultsSource: null };
    if (defaults) {
      s.defaultRate = defaults.cityMedian || 600;
      s.defaultsSource = defaults.source || null;
      var src = 'QVR 2011 median (capital value, per m²)';
      Object.keys(defaults.areas || {}).forEach(function (k) { var d = defaults.areas[k]; s.areas[k] = { rate: d.rate, n: d.n, p25: d.p25, p75: d.p75, source: src, note: '' }; });
      Object.keys(defaults.sectors || {}).forEach(function (k) { var d = defaults.sectors[k]; s.sectors[k] = { rate: d.rate, n: d.n, p25: d.p25, p75: d.p75, source: src, note: '' }; });
    }
    return s;
  }

  /*
   * Which rate applies to a property.
   * Returns { rate, basis: 'override'|'sector'|'area'|'default', key, label, source }
   */
  function landRateFor(project, p) {
    var s = project.landRates || defaultSchedule(null);
    var uplift = num(s.upliftFactor) === null ? 1 : num(s.upliftFactor);
    var ov = num(p.landRateOverride);
    if (ov !== null && ov > 0) return { rate: ov, basis: 'override', key: null, label: 'Property-specific rate', source: p.landRateOverrideNote || 'set by valuer' };
    if (s.level === 'sector' && p.sectorKey && s.sectors[p.sectorKey] && num(s.sectors[p.sectorKey].rate) !== null) {
      var e = s.sectors[p.sectorKey];
      return { rate: num(e.rate) * uplift, basis: 'sector', key: p.sectorKey, label: 'Sector ' + p.sectorKey, source: e.source || '', uplift: uplift };
    }
    if (p.areaId !== null && p.areaId !== undefined && s.areas[String(p.areaId)] && num(s.areas[String(p.areaId)].rate) !== null) {
      var a = s.areas[String(p.areaId)];
      return { rate: num(a.rate) * uplift, basis: 'area', key: String(p.areaId), label: 'Area ' + p.areaId, source: a.source || '', uplift: uplift };
    }
    var d = num(s.defaultRate) === null ? 0 : num(s.defaultRate);
    return { rate: d * uplift, basis: 'default', key: null, label: 'City-wide default rate', source: 'default rate', uplift: uplift };
  }

  /* Land value = rate × land area, or null when there is no land area */
  function landValueFor(project, p) {
    var area = num(p.landArea_m2);
    if (area === null || area <= 0) return { value: null, rateInfo: landRateFor(project, p), landArea: area, reason: 'no land area' };
    var ri = landRateFor(project, p);
    return { value: ri.rate * area, rateInfo: ri, landArea: area, reason: null };
  }

  /* Features that apply to the improvement model (all features; legacy land-only ones are skipped) */
  function modelFeatures(project) {
    return (project.features || []).filter(function (f) { return f.appliesTo !== 'land'; });
  }

  /*
   * Rows for the improvement model. Every property becomes a row; sample rows
   * carry value = total − land (the residual). Returns { rows, samples, issues }
   *   samples: number of rows with a usable residual
   *   issues:  [{ id, reason }] for sample properties that could not be used
   */
  function modelRows(project, charsFor) {
    var rows = [], issues = [], samples = 0, highShare = 0, withTotal = 0;
    (project.properties || []).forEach(function (p) {
      var total = num(p.totalValue);
      var row = { id: p.id, area: p.builtArea_m2, value: null, chars: charsFor ? charsFor(p) : (p.characteristics || {}) };
      if (total !== null) {
        withTotal++;
        var lv = landValueFor(project, p);
        if (lv.value === null) issues.push({ id: p.id, reason: 'total value given but no land area, so land cannot be deducted' });
        else if (total - lv.value <= 0) issues.push({ id: p.id, reason: 'total value (' + Math.round(total) + ') is not above the land value (' + Math.round(lv.value) + '); check the total or the land rate' });
        else {
          row.value = total - lv.value; samples++;
          if (lv.value / total > LAND_SHARE_WARN) highShare++;
        }
      }
      rows.push(row);
    });
    var warnings = [];
    if (withTotal && samples && highShare / samples > 0.25) warnings.push('Land exceeds ' + Math.round(LAND_SHARE_WARN * 100) + ' % of the total value for ' + highShare + ' of ' + samples + ' sample properties. The land rates may be too high for the value basis used.');
    return { rows: rows, samples: samples, issues: issues, warnings: warnings };
  }

  /* Value one property with the fitted model. model = { form, columns, coef, smearing } or null */
  function valueProperty(project, p, model, charsFor) {
    var out = { land: null, improvement: null, total: null, rateInfo: null, flags: [], missing: [] };
    var lv = landValueFor(project, p);
    out.rateInfo = lv.rateInfo;
    if (lv.value === null) out.flags.push('no land area'); else out.land = lv.value;
    if (lv.rateInfo.basis === 'default') out.flags.push('default land rate (no Area/Sector rate)');
    if (!model) out.flags.push('improvement model not fitted');
    else if (num(p.builtArea_m2) === null) out.flags.push('no built area');
    else {
      var pr = Engine.predict(model, { area: p.builtArea_m2, chars: charsFor ? charsFor(p) : (p.characteristics || {}) });
      if (pr.invalid) out.flags.push('improvement: ' + pr.invalid);
      else { out.improvement = pr.value; out.missing = pr.missing; if (pr.missing.length) out.flags.push('missing: ' + pr.missing.join(', ')); }
    }
    if (out.land !== null || out.improvement !== null) out.total = (out.land || 0) + (out.improvement || 0);
    if ((out.land === null) !== (out.improvement === null)) out.flags.push('total is partial');
    return out;
  }

  /*
   * Compare several fitted models on the same properties. entries[0] is the
   * reference (normally the current model). Each entry: { id, name, fit }.
   * Returns { entries: [{ id, name, form, stats, terms, locks, totals, compared, moved, movedShare }],
   *           perProperty: [{ id, plotNo, land, values, totals }] }
   */
  function compareModels(project, entries, charsFor, threshold) {
    threshold = threshold || 0.10;
    var props = project.properties || [];
    var out = {
      entries: entries.map(function (e) {
        var f = e.fit && e.fit.ok ? e.fit : null;
        return {
          id: e.id, name: e.name, form: f ? f.form : (e.fit ? e.fit.form : null),
          stats: f ? { n: f.n, r2: f.r2, adjR2: f.adjR2, rmse: f.rmse, loocvRmse: f.loocvRmse, cod: f.cod, prd: f.prd, medianRatio: f.medianRatio } : null,
          terms: f ? f.status.filter(function (s) { return s === 'free' || s === 'locked'; }).length : 0,
          locks: f ? f.status.filter(function (s) { return s === 'locked'; }).length : 0,
          totals: { land: 0, improvement: 0, total: 0, valued: 0 }, compared: 0, moved: 0, movedShare: null
        };
      }),
      perProperty: []
    };
    var models = entries.map(function (e) { var f = e.fit && e.fit.ok ? e.fit : null; return f ? { form: f.form, columns: f.columns, coef: f.coef, smearing: f.smearing } : null; });
    props.forEach(function (p) {
      var lv = landValueFor(project, p).value;
      var chars = charsFor ? charsFor(p) : (p.characteristics || {});
      var row = { id: p.id, plotNo: p.plotNo, description: p.description, areaId: p.areaId, land: lv, values: [], totals: [] };
      models.forEach(function (m, k) {
        var imp = null;
        if (m && num(p.builtArea_m2) !== null) { var pr = Engine.predict(m, { area: p.builtArea_m2, chars: chars }); if (!pr.invalid) imp = pr.value; }
        var tot = (lv !== null || imp !== null) ? (lv || 0) + (imp || 0) : null;
        row.values.push(imp); row.totals.push(tot);
        if (tot !== null) { var t = out.entries[k].totals; t.land += lv || 0; t.improvement += imp || 0; t.total += tot; t.valued++; }
      });
      var ref = row.totals[0];
      for (var k = 1; k < models.length; k++) {
        var t2 = row.totals[k];
        if (ref !== null && ref > 0 && t2 !== null) { out.entries[k].compared++; if (Math.abs(t2 - ref) / ref > threshold) out.entries[k].moved++; }
      }
      out.perProperty.push(row);
    });
    out.entries.forEach(function (e, k) { if (k > 0 && e.compared) e.movedShare = e.moved / e.compared; if (k === 0) e.movedShare = 0; });
    return out;
  }

  /* Migrate a version-1 project (two values, two models) to version 2 */
  function migrateProject(p, defaults) {
    if (!p) return p;
    if (!p.landRates) p.landRates = defaultSchedule(defaults);
    if (!p.model) {
      var old = p.models && p.models.improvement ? p.models.improvement : null;
      p.model = old ? { form: old.form || 'loglinear', smearing: !!old.smearing, included: old.included || {}, locks: old.locks || {}, fit: null, fittedAt: null }
        : { form: 'loglinear', smearing: false, included: {}, locks: {}, fit: null, fittedAt: null };
    }
    delete p.models;
    (p.properties || []).forEach(function (x) {
      if (x.totalValue === undefined) {
        var l = num(x.landValue), i = num(x.improvementValue), t = num(x.totalValueEntered);
        x.totalValue = (l !== null || i !== null) ? (l || 0) + (i || 0) : t;
      }
      delete x.landValue; delete x.improvementValue; delete x.totalValueEntered;
      if (x.areaId === undefined) x.areaId = null;
      if (x.sectorKey === undefined) x.sectorKey = null;
      if (x.locationSource === undefined) x.locationSource = null;
      if (x.landRateOverride === undefined) x.landRateOverride = null;
    });
    if (!p.mode) p.mode = 'simple';
    if (!Array.isArray(p.savedModels)) p.savedModels = [];
    if (!p.valuer) p.valuer = { name: '', registration: '', valuationDate: '', validityMonths: 12 };
    p.version = 2;
    return p;
  }

  return { defaultSchedule: defaultSchedule, landRateFor: landRateFor, landValueFor: landValueFor, modelFeatures: modelFeatures, modelRows: modelRows, valueProperty: valueProperty, compareModels: compareModels, migrateProject: migrateProject, LAND_SHARE_WARN: LAND_SHARE_WARN };
}));
