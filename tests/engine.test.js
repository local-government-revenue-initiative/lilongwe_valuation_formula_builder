// Unit tests for js/engine.js. Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Engine = require('../js/engine.js');

const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected.json'), 'utf8'));

const features = [
  { id: 'wall', name: 'Wall material', type: 'categorical', categories: ['Masonry', 'Mud', 'Zinc'] },
  { id: 'fence', name: 'Permanent fence', type: 'boolean' }
];
const rows = expected.rows.map(([area, wall, fence, value], i) => ({
  id: 'P' + i, area, value, chars: { wall, fence: fence ? 'Yes' : 'No' }
}));

function close(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg}: got ${a}, expected ${b}`);
}

for (const form of ['linear', 'loglinear', 'loglog']) {
  test(`OLS matches independent exact solution (${form})`, () => {
    const columns = Engine.buildColumns(form, features, rows, 'Built area (m²)');
    // columns: intercept, area, wall:Masonry(base), wall:Mud, wall:Zinc, fence
    assert.equal(columns.length, 6);
    assert.ok(columns[2].isBase, 'Masonry should be the base category (most frequent)');
    const fit = Engine.fit({ form, columns }, rows);
    assert.ok(fit.ok);
    const exp = expected.cases[form];
    const map = [0, 1, 3, 4, 5]; // engine index for each expected coefficient
    map.forEach((j, k) => {
      close(fit.coef[j], exp.beta[k], 1e-9, `${form} coef ${columns[j].key}`);
      close(fit.se[j], exp.se[k], 1e-7, `${form} se ${columns[j].key}`);
    });
    close(fit.r2, exp.r2, 1e-9, `${form} r2`);
    close(fit.adjR2, exp.adjR2, 1e-9, `${form} adjR2`);
    assert.equal(fit.df, exp.df);
    assert.equal(fit.status[2], 'base');
    assert.equal(fit.n, 12);
  });
}

test('locked weight uses the offset method exactly', () => {
  const form = 'loglinear';
  const columns = Engine.buildColumns(form, features, rows);
  const fenceCol = columns.find(c => c.key === 'f:fence');
  const lockCoef = Engine.displayToCoef(form, fenceCol, 15); // +15 %
  const fit = Engine.fit({ form, columns, locks: { 'f:fence': lockCoef } }, rows);
  const exp = expected.cases.loglinear_lock_fence;
  close(lockCoef, exp.lockedCoef, 1e-12, 'lock coefficient');
  const map = [0, 1, 3, 4];
  map.forEach((j, k) => close(fit.coef[j], exp.beta[k], 1e-9, `locked fit coef ${columns[j].key}`));
  close(fit.coef[5], lockCoef, 1e-12, 'locked coefficient carried through');
  assert.equal(fit.status[5], 'locked');
  assert.equal(fit.se[5], null);
  close(fit.r2, exp.r2, 1e-9, 'constrained r2');
  assert.ok(fit.unconstrainedR2 >= fit.r2 - 1e-12, 'unconstrained fit is never worse');
  close(Engine.coefToDisplay(form, fenceCol, lockCoef), 15, 1e-9, 'round trip to display');
});

test('predict reproduces fitted values and gives a breakdown', () => {
  const form = 'loglinear';
  const columns = Engine.buildColumns(form, features, rows);
  const fit = Engine.fit({ form, columns }, rows);
  const model = { form, columns, coef: fit.coef, smearing: fit.smearing };
  rows.forEach((r, i) => {
    const pr = Engine.predict(model, r);
    close(pr.value, fit.sample[i].predicted, 1e-9, 'predict vs fitted');
    assert.equal(pr.contributions.length, columns.length);
  });
  // missing characteristic is imputed as base and flagged
  const pr = Engine.predict(model, { area: 100, chars: {} });
  assert.deepEqual(pr.missing, ['wall', 'fence']);
  assert.ok(pr.value > 0);
  // non-positive area invalid for log-log
  const ll = Engine.buildColumns('loglog', features, rows);
  const bad = Engine.predict({ form: 'loglog', columns: ll, coef: ll.map(() => 0.1), smearing: 1 }, { area: 0, chars: { wall: 'Mud', fence: 1 } });
  assert.ok(bad.invalid);
});

test('aliased (duplicate) column is detected instead of crashing', () => {
  const feats = features.concat([{ id: 'fence2', name: 'Duplicate of fence', type: 'boolean' }]);
  const rows2 = rows.map(r => ({ ...r, chars: { ...r.chars, fence2: r.chars.fence } }));
  const columns = Engine.buildColumns('linear', feats, rows2);
  const fit = Engine.fit({ form: 'linear', columns }, rows2);
  assert.ok(fit.ok);
  assert.deepEqual(fit.aliased, ['f:fence2']);
  assert.equal(fit.status[columns.findIndex(c => c.key === 'f:fence2')], 'aliased');
  close(fit.coef[columns.findIndex(c => c.key === 'f:fence')], expected.cases.linear.beta[4], 1e-9, 'fence coef unchanged');
});

test('rows with missing values, areas or characteristics are excluded with reasons', () => {
  const rows2 = rows.concat([
    { id: 'noval', area: 100, value: null, chars: { wall: 'Mud', fence: 'No' } },
    { id: 'noarea', area: null, value: 1000, chars: { wall: 'Mud', fence: 'No' } },
    { id: 'nochar', area: 100, value: 1000, chars: { wall: 'Mud' } },
    { id: 'negval', area: 100, value: -5, chars: { wall: 'Mud', fence: 'No' } }
  ]);
  const columns = Engine.buildColumns('loglinear', features, rows2);
  const fit = Engine.fit({ form: 'loglinear', columns }, rows2);
  assert.equal(fit.n, 12);
  const ids = fit.excluded.map(e => e.id).sort();
  assert.deepEqual(ids, ['negval', 'noarea', 'nochar']);
});

test('t-distribution p-values are correct', () => {
  // Reference values from standard t tables
  close(Engine.tTestPValue(2.228, 10), 0.05, 2e-3, 't=2.228 df=10');
  close(Engine.tTestPValue(1.96, 1e6), 0.05, 2e-3, 't=1.96 large df');
  close(Engine.tTestPValue(0, 5), 1, 1e-12, 't=0');
  close(Engine.tTestPValue(3.182, 3), 0.05, 2e-3, 't=3.182 df=3');
  assert.ok(Engine.tTestPValue(10, 20) < 1e-6);
});

test('ratio statistics are sensible for a perfect fit', () => {
  // value exactly = 1000 * area  -> linear fit is exact
  const perfect = rows.map(r => ({ id: r.id, area: r.area, value: 1000 * r.area, chars: r.chars }));
  const columns = Engine.buildColumns('linear', features, perfect);
  const fit = Engine.fit({ form: 'linear', columns }, perfect);
  close(fit.r2, 1, 1e-9, 'r2');
  close(fit.rmse, 0, 1e-3, 'rmse');
  close(fit.medianRatio, 1, 1e-9, 'median ratio');
  close(fit.cod, 0, 1e-6, 'cod');
  close(fit.prd, 1, 1e-9, 'prd');
  assert.ok(fit.loocvRmse !== null && fit.loocvRmse < 1e-3);
});

test('leave-one-out skips leverage-1 rows instead of giving up', () => {
  // a category that occurs once: that row alone determines its weight
  const feats = features.concat([{ id: 'pool', name: 'Pool', type: 'boolean' }]);
  const rows2 = rows.map((r, i) => ({ ...r, chars: { ...r.chars, pool: i === 0 ? 'Yes' : 'No' } }));
  const columns = Engine.buildColumns('loglinear', feats, rows2);
  const fit = Engine.fit({ form: 'loglinear', columns }, rows2);
  assert.equal(fit.loocvSkipped, 1);
  assert.equal(fit.sample[0].loo, null);
  assert.ok(fit.loocvRmse > 0);
  assert.ok(fit.warnings.some(w => /Leave-one-out RMSE is computed without 1 sample property/.test(w)));
});

test('numeric parsing handles thousands separators and currency prefixes', () => {
  assert.equal(Engine.toNumber('1,250,000'), 1250000);
  assert.equal(Engine.toNumber('MK 12,000'), 12000);
  assert.equal(Engine.toNumber(''), null);
  assert.equal(Engine.toNumber('abc'), null);
  assert.equal(Engine.parseBoolean('Yes'), true);
  assert.equal(Engine.parseBoolean('0'), false);
  assert.equal(Engine.parseBoolean('maybe'), null);
});

test('empty sample returns a clear warning rather than throwing', () => {
  const columns = Engine.buildColumns('loglinear', features, []);
  const fit = Engine.fit({ form: 'loglinear', columns }, [{ id: 'x', area: 10, value: null, chars: {} }]);
  assert.equal(fit.ok, false);
  assert.ok(fit.warnings[0].includes('No usable sample'));
});
