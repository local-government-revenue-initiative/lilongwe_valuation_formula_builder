/*
 * End-to-end smoke test: opens index.html from file://, imports the synthetic
 * sample, fits both models, locks a weight, compares forms, traces a rooftop
 * on the map, exports the roll and checks persistence across a reload.
 *
 * Run:  node tests/e2e.spec.js        (needs the playwright package and Chromium)
 */
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html');
const SAMPLE = path.join(ROOT, 'examples', 'sample_properties.csv');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/tile|arcgis|openstreetmap|net::ERR/i.test(m.text())) errors.push(m.text()); });

  await page.goto(URL);
  await page.waitForSelector('#property-table');

  // ---- import ------------------------------------------------------------
  await page.setInputFiles('#file-import', SAMPLE);
  await page.waitForSelector('#import-dialog[open]');
  assert.equal(await page.inputValue('#import-mapping select[data-field="builtArea_m2"]'), 'Built_Area_m2');
  assert.equal(await page.inputValue('#import-mapping select[data-field="landArea_m2"]'), 'Land_Area_m2');
  assert.equal(await page.inputValue('#import-mapping select[data-field="landValue"]'), 'Land_Value_MWK');
  assert.equal(await page.inputValue('#import-mapping select[data-field="improvementValue"]'), 'Improvement_Value_MWK');
  assert.equal(await page.inputValue('#import-mapping select[data-field="lat"]'), 'Latitude');
  // import every remaining column as a characteristic, with sensible model assignment
  const extraRows = await page.$$('#import-extras tbody tr');
  for (const tr of extraRows) {
    const header = await tr.getAttribute('data-header');
    await (await tr.$('.extra-check')).check();
    const sels = await tr.$$('select');
    if (header === 'Road_Access') await sels[1].selectOption('both');
    if (header === 'Piped_Water') await sels[1].selectOption('land');
    if (header === 'Zone') await sels[1].selectOption('land');
  }
  await page.click('#import-confirm');
  await page.waitForFunction(() => /40 properties, 40 with sample values/.test(document.querySelector('#property-count').textContent));
  const featureCount = await page.$$eval('#feature-table tbody tr', r => r.length);
  assert.equal(featureCount, 6, 'six characteristics imported');

  // use the Zone field as a land characteristic
  await page.click('.tabs button[data-tab="features"]');
  await page.click('#btn-zone-feature');
  await page.waitForFunction(() => document.querySelectorAll('#feature-table tbody tr').length === 7);
  const zoneCats = await page.evaluate(() => window.App.state.project.features.find(f => f.source === 'zone').categories.length);
  assert.equal(zoneCats, 6, 'six zones in the sample');

  // ---- models ------------------------------------------------------------
  await page.click('.tabs button[data-tab="models"]');
  await page.click('#fit-land');
  await page.click('#fit-improvement');
  await page.waitForSelector('#stats-land');
  await page.waitForSelector('#stats-improvement');
  const statsText = await page.textContent('#stats-improvement');
  assert.ok(/R²/.test(statsText) && /RMSE/.test(statsText) && /COD/.test(statsText), 'fit statistics shown');
  const r2 = await page.evaluate(() => window.App.state.project.models.improvement.fit.r2);
  assert.ok(r2 > 0.5 && r2 <= 1, 'improvement model fits the synthetic data, r2=' + r2);
  const landR2 = await page.evaluate(() => window.App.state.project.models.land.fit.r2);
  assert.ok(landR2 > 0.5 && landR2 <= 1, 'land model fits, r2=' + landR2);
  const zoneTerms = await page.evaluate(() => window.App.state.project.models.land.fit.columns.filter(c => c.featureId === 'zone').length);
  assert.equal(zoneTerms, 6, 'zone enters the land model as six category columns');
  const loo = await page.evaluate(() => { const f = window.App.state.project.models.improvement.fit; return [f.loocvRmse, f.loocvSkipped]; });
  assert.ok(loo[0] !== null && loo[0] > 0, 'leave-one-out RMSE computed despite leverage-1 rows (skipped ' + loo[1] + ')');

  // lock the fence weight at +10 % and check the refit reports the cost
  const fenceRow = page.locator('#weights-improvement tbody tr', { hasText: 'Fence' }).first();
  await fenceRow.locator('input[type="checkbox"]').nth(1).check();
  await page.waitForFunction(() => window.App.state.project.models.improvement.fit.status.indexOf('locked') >= 0);
  await fenceRow.locator('input[type="number"]').fill('10');
  await fenceRow.locator('input[type="number"]').dispatchEvent('change');
  await page.waitForFunction(() => {
    const f = window.App.state.project.models.improvement.fit;
    const j = f.columns.findIndex(c => c.label === 'Fence');
    return f.status[j] === 'locked' && Math.abs(Math.exp(f.coef[j]) - 1.10) < 1e-9;
  });
  assert.ok(/R² without locks/.test(await page.textContent('#stats-improvement')), 'unconstrained R² shown when a lock is active');

  // switch to log-log and back, compare forms
  await page.selectOption('#form-improvement', 'loglog');
  await page.waitForFunction(() => window.App.state.project.models.improvement.fit.form === 'loglog');
  assert.ok(/exponent/i.test(await page.textContent('#formula-improvement')), 'log-log formula text');
  await page.click('#compare-improvement');
  const compareRows = await page.$$eval('#compare-box-improvement tbody tr', r => r.length);
  assert.equal(compareRows, 3, 'three forms compared');

  // ---- roll and export ---------------------------------------------------
  await page.click('.tabs button[data-tab="roll"]');
  await page.waitForFunction(() => /40 of 40 properties valued/.test(document.querySelector('#roll-summary').textContent));
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-roll-csv')]);
  const csvPath = path.join(__dirname, 'out_valuation_roll.csv');
  await download.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, 'utf8');
  const header = csv.split(/\r?\n/)[0];
  for (const h of ['LandValue_formula', 'ImprovementValue_formula', 'TotalValue_formula', 'LandAreaSource', 'BuiltAreaSource']) assert.ok(header.includes(h), 'export has ' + h);
  assert.equal(csv.trim().split(/\r?\n/).length, 41, '40 data rows exported');
  fs.unlinkSync(csvPath);
  // land + improvement = total for every property
  const sums = await page.evaluate(() => window.App.rollExportRows().rows.map(r => [r.LandValue_formula, r.ImprovementValue_formula, r.TotalValue_formula]));
  sums.forEach(([l, i, t]) => assert.ok(Math.abs(l + i - t) <= 1, 'land + improvement = total'));

  // calculation sheet opens
  await page.click('#roll-table tbody tr button');
  await page.waitForSelector('#sheet-dialog[open]');
  assert.ok(/Total value \(land \+ improvements\)/.test(await page.textContent('#sheet-content')));
  await page.click('#sheet-close');

  // ---- map: trace a rooftop with the mouse --------------------------------
  await page.click('.tabs button[data-tab="properties"]');
  await page.click('#property-table tbody tr:first-child');
  await page.evaluate(() => { Mapping.map().setView([-13.9626, 33.7741], 19, { animate: false }); });
  await page.waitForTimeout(300);
  const box = await (await page.$('#map')).boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.click('#tool-roof');
  const pts = [[cx - 50, cy - 50], [cx + 50, cy - 50], [cx + 50, cy + 50], [cx - 50, cy + 50]];
  for (const [x, y] of pts) { await page.mouse.click(x, y); await page.waitForTimeout(120); }
  await page.mouse.click(pts[0][0], pts[0][1]); // close the polygon
  await page.waitForFunction(() => { const p = window.App.state.project.properties[0]; return p.roofPolygons.length === 1; });
  const area = await page.evaluate(() => window.App.state.project.properties[0].roofPolygons[0].area_m2);
  // at zoom 19 near latitude -13.96 one pixel is about 0.29 m, so 100 px ≈ 29 m
  const mPerPx = 156543.03392 * Math.cos(-13.9626 * Math.PI / 180) / Math.pow(2, 19);
  const expected = Math.pow(100 * mPerPx, 2);
  assert.ok(Math.abs(area - expected) / expected < 0.1, 'traced area ' + area.toFixed(1) + ' m² close to expected ' + expected.toFixed(1));
  const built = await page.evaluate(() => window.App.state.project.properties[0].builtArea_m2);
  // imported area is kept (source "imported"); traced total is offered instead
  assert.ok(built !== null, 'built area still set');

  // ---- persistence across reload ----------------------------------------
  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForFunction(() => window.App.state.project && window.App.state.project.properties.length === 40);
  const persistedFit = await page.evaluate(() => window.App.state.project.models.land.fit && window.App.state.project.models.land.fit.ok);
  assert.ok(persistedFit, 'fitted model survives reload');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  console.log('e2e OK');
})().catch(e => { console.error('e2e FAILED:', e); process.exit(1); });
