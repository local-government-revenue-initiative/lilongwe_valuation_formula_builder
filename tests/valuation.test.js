// Unit tests for js/geo.js and js/valuation.js. Run with:  node --test tests/valuation.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = {};
require(path.join(__dirname, '..', 'data', 'lilongwe_areas.js'));
require(path.join(__dirname, '..', 'data', 'lilongwe_sectors.js'));
require(path.join(__dirname, '..', 'data', 'land_rates_default.js'));
const Geo = require('../js/geo.js');
const Valuation = require('../js/valuation.js');
const Engine = require('../js/engine.js');
Geo.setLayers(window.LILONGWE_AREAS, window.LILONGWE_SECTORS);
const DEFAULTS = window.LAND_RATES_DEFAULT;

test('geo layers loaded with all Areas and Sectors', () => {
  assert.equal(Geo.areaIds().length, 58);
  assert.equal(Geo.sectorKeys().length, 131);
  assert.ok(Geo.areaInfo(3), 'Area 3 exists');
});

test('a point in central Lilongwe falls in an Area and its Sector', () => {
  const loc = Geo.locate(-13.9626, 33.7741);
  assert.equal(loc.areaId, 15);
  assert.equal(loc.sectorKey, '15');
  assert.ok(loc.sectorLandUse);
});

test('a point outside the city matches nothing', () => {
  const loc = Geo.locate(-15, 35);
  assert.equal(loc.areaId, null);
  assert.equal(loc.sectorKey, null);
});

test('every Area polygon contains its own interior sample point', () => {
  // a point inside the outer ring of each Area must locate back to that Area
  let checked = 0;
  window.LILONGWE_AREAS.features.forEach(f => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const outer = polys[0][0];
    // centroid of the vertices; skip if it is not inside (concave shapes)
    const cx = outer.reduce((s, c) => s + c[0], 0) / outer.length, cy = outer.reduce((s, c) => s + c[1], 0) / outer.length;
    if (!Geo.inRing([cx, cy], outer)) return;
    const loc = Geo.locate(cy, cx);
    assert.equal(loc.areaId, f.properties.Area_ID, 'Area ' + f.properties.Area_ID);
    checked++;
  });
  assert.ok(checked > 40, 'checked ' + checked + ' areas');
});

test('plot numbers parse to Area and Sector', () => {
  assert.deepEqual(Geo.fromPlotNo('46/1/232'), { areaId: 46, sectorKey: '46/1' });
  assert.deepEqual(Geo.fromPlotNo('1/12A'), { areaId: 1, sectorKey: '1' });
  assert.deepEqual(Geo.fromPlotNo(' 25/4/88 '), { areaId: 25, sectorKey: '25/4' });
  assert.deepEqual(Geo.fromPlotNo('FE/MC/04'), { areaId: null, sectorKey: null });
  assert.deepEqual(Geo.fromPlotNo(''), { areaId: null, sectorKey: null });
});

test('default schedule carries the QVR medians and city default', () => {
  const s = Valuation.defaultSchedule(DEFAULTS);
  assert.equal(s.level, 'area');
  assert.equal(s.defaultRate, 600);
  assert.equal(s.areas['3'].rate, 4392);
  assert.equal(s.areas['25'].rate, 600);
  assert.ok(Object.keys(s.sectors).length >= 50);
});

function project(overrides) {
  return Object.assign({ currency: 'MWK', valueBasis: 'capital', features: [], properties: [], landRates: Valuation.defaultSchedule(DEFAULTS), model: {} }, overrides || {});
}

test('land rate lookup: area, sector, override, default, uplift', () => {
  const proj = project();
  const p = { areaId: 3, sectorKey: '3', landArea_m2: 1000, landRateOverride: null };
  let ri = Valuation.landRateFor(proj, p);
  assert.equal(ri.basis, 'area'); assert.equal(ri.rate, 4392);
  proj.landRates.level = 'sector';
  ri = Valuation.landRateFor(proj, p);
  assert.equal(ri.basis, 'sector'); assert.equal(ri.rate, proj.landRates.sectors['3'].rate);
  proj.landRates.level = 'area';
  proj.landRates.upliftFactor = 2;
  assert.equal(Valuation.landRateFor(proj, p).rate, 8784);
  assert.equal(Valuation.landValueFor(proj, p).value, 8784 * 1000);
  p.landRateOverride = 100;
  ri = Valuation.landRateFor(proj, p);
  assert.equal(ri.basis, 'override'); assert.equal(ri.rate, 100);
  const q = { areaId: 999, sectorKey: null, landArea_m2: 10, landRateOverride: null };
  ri = Valuation.landRateFor(proj, q);
  assert.equal(ri.basis, 'default'); assert.equal(ri.rate, 1200);
  const r = { areaId: null, sectorKey: null, landArea_m2: null };
  assert.equal(Valuation.landValueFor(proj, r).value, null);
});

test('model rows: residual = total − land; bad rows excluded with reasons', () => {
  const proj = project({
    properties: [
      { id: 'a', areaId: 3, landArea_m2: 100, builtArea_m2: 80, totalValue: 1000000, characteristics: {} },     // residual 1000000 − 439200
      { id: 'b', areaId: 3, landArea_m2: 100, builtArea_m2: 80, totalValue: 100000, characteristics: {} },      // below land value
      { id: 'c', areaId: 3, landArea_m2: null, builtArea_m2: 80, totalValue: 500000, characteristics: {} },      // no land area
      { id: 'd', areaId: 3, landArea_m2: 100, builtArea_m2: 80, totalValue: null, characteristics: {} }          // not a sample
    ]
  });
  const prep = Valuation.modelRows(proj);
  assert.equal(prep.rows.length, 4);
  assert.equal(prep.samples, 1);
  assert.equal(prep.rows[0].value, 1000000 - 439200);
  assert.equal(prep.rows[3].value, null);
  assert.deepEqual(prep.issues.map(i => i.id).sort(), ['b', 'c']);
  assert.ok(/not above the land value/.test(prep.issues.find(i => i.id === 'b').reason));
});

test('valueProperty combines land and model, flags default rates and partial totals', () => {
  const proj = project();
  const columns = Engine.buildColumns('linear', [], [], 'Built area');
  const model = { form: 'linear', columns, coef: [1000, 500], smearing: 1 }; // improvement = 1000 + 500 × area
  const p = { areaId: 3, landArea_m2: 10, builtArea_m2: 20, characteristics: {} };
  const v = Valuation.valueProperty(proj, p, model);
  assert.equal(v.land, 43920); assert.equal(v.improvement, 11000); assert.equal(v.total, 54920);
  assert.deepEqual(v.flags, []);
  const q = { areaId: 999, landArea_m2: 10, builtArea_m2: null, characteristics: {} };
  const w = Valuation.valueProperty(proj, q, model);
  assert.equal(w.land, 6000); assert.equal(w.improvement, null); assert.equal(w.total, 6000);
  assert.ok(w.flags.some(f => /default land rate/.test(f)) && w.flags.some(f => /no built area/.test(f)) && w.flags.some(f => /partial/.test(f)));
});

test('compareModels reports totals, moved share and per-property values', () => {
  const proj = project({
    properties: [
      { id: 'a', plotNo: 'A', areaId: 3, landArea_m2: 10, builtArea_m2: 100, characteristics: {} },
      { id: 'b', plotNo: 'B', areaId: 3, landArea_m2: 10, builtArea_m2: 200, characteristics: {} },
      { id: 'c', plotNo: 'C', areaId: 3, landArea_m2: 10, builtArea_m2: null, characteristics: {} }
    ]
  });
  const columns = Engine.buildColumns('linear', [], [], 'Built area');
  const mk = (coef) => ({ ok: true, form: 'linear', columns, coef, smearing: 1, status: ['free', 'free'], n: 5, r2: 0.9, adjR2: 0.88, rmse: 10, loocvRmse: 12, cod: 5, prd: 1, medianRatio: 1 });
  const same = mk([1000, 500]);
  const other = mk([1000, 600]); // +20 % on the area term
  const cmp = Valuation.compareModels(proj, [{ id: 'cur', name: 'Current', fit: same }, { id: 's', name: 'Same', fit: same }, { id: 'o', name: 'Other', fit: other }]);
  assert.equal(cmp.entries.length, 3);
  // land 43,920 each for a and b and c; buildings 51,000 and 101,000 under Current
  assert.equal(cmp.entries[0].totals.improvement, 51000 + 101000);
  assert.equal(cmp.entries[0].totals.land, 3 * 43920);
  assert.equal(cmp.entries[0].totals.valued, 3);
  assert.equal(cmp.entries[1].movedShare, 0, 'identical model moves nothing');
  // Other: a → 61,000 (+10,000 on 94,920 = 10.5 %), b → 121,000 (+20,000 on 144,920 = 13.8 %); c has no building value, so it is compared but unchanged
  assert.equal(cmp.entries[2].moved, 2);
  assert.equal(cmp.entries[2].compared, 3);
  assert.ok(Math.abs(cmp.entries[2].movedShare - 2 / 3) < 1e-12);
  assert.deepEqual(cmp.perProperty.map(r => r.values[2]), [61000, 121000, null]);
  assert.equal(cmp.entries[0].terms, 2);
});

test('weightsMatrix lists each term once with a cell per model', () => {
  const Formula = require('../js/formula.js');
  const columns = Engine.buildColumns('linear', [{ id: 'fence', name: 'Fence', type: 'boolean' }], [], 'Built area');
  const mk = (coef, status) => ({ ok: true, form: 'linear', columns, coef, smearing: 1, status, se: [1, 1, 1], t: [1, 1, 1], p: [0.01, 0.01, 0.5] });
  const a = mk([1000, 500, 20], ['free', 'free', 'free']);
  const b = mk([900, 550, 0], ['free', 'free', 'excluded']);
  const m = Formula.weightsMatrix([{ name: 'A', fit: a }, { name: 'B', fit: b }], 'MWK');
  assert.deepEqual(m.names, ['A', 'B']);
  assert.deepEqual(m.rows.map(r => r.key), ['intercept', 'area', 'f:fence']);
  assert.ok(m.rows[0].cells[0] && m.rows[0].cells[1], 'base value has a cell for both models');
  assert.equal(m.rows[2].cells[1], null, 'excluded term shows no cell');
});

test('a version-1 project migrates to the single-model layout', () => {
  const old = { version: 1, models: { land: {}, improvement: { form: 'loglog', locks: { 'f:fence': 10 } } }, properties: [{ id: 'x', landValue: 100, improvementValue: 250 }, { id: 'y', totalValueEntered: 900 }] };
  const p = Valuation.migrateProject(old, DEFAULTS);
  assert.equal(p.version, 2);
  assert.equal(p.model.form, 'loglog');
  assert.equal(p.model.locks['f:fence'], 10);
  assert.equal(p.properties[0].totalValue, 350);
  assert.equal(p.properties[1].totalValue, 900);
  assert.equal(p.properties[0].landValue, undefined);
  assert.ok(p.landRates.areas['3']);
  assert.equal(p.mode, 'simple');
  assert.deepEqual(p.savedModels, []);
});
