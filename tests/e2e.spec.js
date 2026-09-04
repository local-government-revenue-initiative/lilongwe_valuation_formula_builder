/*
 * End-to-end smoke test: opens index.html from file://, imports the synthetic
 * sample, checks Areas were detected, fits the model, edits a land rate,
 * switches to Advanced and locks a weight, exports the roll, traces a rooftop
 * on the map and checks persistence across a reload.
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
  page.on('console', m => { if (m.type() === 'error' && !/tile|arcgis|openstreetmap|fonts\.g|net::ERR/i.test(m.text())) errors.push(m.text()); });

  await page.goto(URL);
  await page.waitForSelector('#property-table');
  assert.ok(await page.evaluate(() => document.body.classList.contains('mode-simple')), 'starts in Simplified mode');
  assert.ok(await page.evaluate(() => Object.keys(window.App.state.project.landRates.areas).length >= 40), 'default land rates seeded');

  // ---- import ------------------------------------------------------------
  await page.setInputFiles('#file-import', SAMPLE);
  await page.waitForSelector('#import-dialog[open]');
  assert.equal(await page.inputValue('#import-mapping select[data-field="builtArea_m2"]'), 'Built_Area_m2');
  assert.equal(await page.inputValue('#import-mapping select[data-field="landArea_m2"]'), 'Land_Area_m2');
  assert.equal(await page.inputValue('#import-mapping select[data-field="totalValue"]'), 'Total_Value_MWK');
  assert.equal(await page.inputValue('#import-mapping select[data-field="lat"]'), 'Latitude');
  assert.equal(await page.inputValue('#import-mapping select[data-field="floors"]'), 'Floors');
  const extras = await page.$$eval('#import-extras tbody tr', rows => rows.map(r => r.getAttribute('data-header')));
  assert.deepEqual(extras.sort(), ['Fence', 'Road_Access', 'Roof_Material', 'Structure_Type', 'Wall_Material']);
  await page.click('#import-confirm');
  await page.waitForFunction(() => /250 properties, 125 with a valuer total/.test(document.querySelector('#property-count').textContent));
  const located = await page.evaluate(() => window.App.state.project.properties.filter(p => p.areaId !== null && p.locationSource === 'map').length);
  assert.equal(located, 250, 'every imported property was assigned an Area from its coordinates');
  const plotArea = await page.evaluate(() => window.App.state.project.properties.slice(0, 20).every(p => String(p.areaId) === p.plotNo.split('/')[0]));
  assert.ok(plotArea, 'detected Area matches the plot number prefix');

  // ---- results (simplified) ----------------------------------------------
  await page.click('.tabs button[data-tab="results"]');
  await page.waitForFunction(() => /Model fitted on 125 sample properties/.test(document.querySelector('#results-summary').textContent));
  const fit = await page.evaluate(() => { const f = window.App.state.project.model.fit; return { r2: f.r2, n: f.n, cod: f.cod }; });
  assert.ok(fit.r2 > 0.5 && fit.r2 <= 1, 'model fits the synthetic data, r2=' + fit.r2);
  await page.waitForFunction(() => /250 of 250 properties valued/.test(document.querySelector('#roll-summary').textContent));
  const sums = await page.evaluate(() => window.App.rollExportRows().rows.map(r => [r.LandValue, r.ImprovementValue, r.TotalValue, r.LandRateBasis]));
  sums.forEach(([l, i, t, b]) => { assert.ok(Math.abs(l + i - t) <= 1, 'land + improvement = total'); assert.equal(b, 'area', 'Area rate used'); });
  const ratios = await page.evaluate(() => window.App.rollExportRows().rows.filter(r => r.Ratio_formula_to_valuer !== '').map(r => r.Ratio_formula_to_valuer));
  const median = ratios.slice().sort((a, b) => a - b)[Math.floor(ratios.length / 2)];
  assert.ok(median > 0.9 && median < 1.1, 'median formula/valuer ratio near 1: ' + median);

  // calculation sheet shows land and building parts
  await page.click('#roll-table tbody tr button');
  await page.waitForSelector('#sheet-dialog[open]');
  const sheetText = await page.textContent('#sheet-content');
  assert.ok(/Land rate/.test(sheetText) && /Base value/.test(sheetText) && /Total value \(land \+ buildings\)/.test(sheetText));
  await page.click('#sheet-close');

  // ---- land rates: editing a rate changes the roll ------------------------
  await page.click('.tabs button[data-tab="rates"]');
  const target = await page.evaluate(() => { const p = window.App.state.project.properties.find(x => x.areaId === 3 && x.totalValue === null); return p ? { id: p.id, land: window.App.valueOf(p).land } : null; });
  assert.ok(target, 'a non-sample property in Area 3 exists');
  const row3 = page.locator('#rates-table tbody tr', { hasText: 'Area 3' }).first();
  await row3.locator('input[type="number"]').fill('8784');
  await row3.locator('input[type="number"]').dispatchEvent('change');
  await page.waitForFunction(id => { const p = window.App.state.project.properties.find(x => x.id === id); return window.App.valueOf(p).rateInfo.rate === 8784; }, target.id);
  const after = await page.evaluate(id => { const p = window.App.state.project.properties.find(x => x.id === id); return window.App.valueOf(p).land; }, target.id);
  assert.ok(Math.abs(after - 2 * target.land) < 1, 'doubling the Area 3 rate doubles land value');
  assert.equal(await page.evaluate(() => window.App.state.project.landRates.areas['3'].source), 'edited by valuer');
  await page.fill('#rate-uplift', '2');
  await page.dispatchEvent('#rate-uplift', 'change');
  await page.waitForFunction(id => { const p = window.App.state.project.properties.find(x => x.id === id); return window.App.valueOf(p).rateInfo.rate === 17568; }, target.id);
  await page.fill('#rate-uplift', '1');
  await page.dispatchEvent('#rate-uplift', 'change');

  // ---- advanced mode: model tab, lock a weight, compare forms -----------
  await page.click('#mode-toggle button[data-mode="advanced"]');
  await page.waitForFunction(() => document.body.classList.contains('mode-advanced'));
  await page.click('.tabs button[data-tab="model"]');
  await page.waitForSelector('#weights-table');
  const fenceRow = page.locator('#weights-table tbody tr', { hasText: 'Fence' }).first();
  await fenceRow.locator('input[type="checkbox"]').nth(1).check();
  await page.waitForFunction(() => window.App.state.project.model.fit.status.indexOf('locked') >= 0);
  await fenceRow.locator('input[type="number"]').fill('10');
  await fenceRow.locator('input[type="number"]').dispatchEvent('change');
  await page.waitForFunction(() => { const f = window.App.state.project.model.fit; const j = f.columns.findIndex(c => c.label === 'Fence'); return f.status[j] === 'locked' && Math.abs(Math.exp(f.coef[j]) - 1.10) < 1e-9; });
  assert.ok(/R² without locks/.test(await page.textContent('#model-stats')), 'unconstrained R² shown when a lock is active');
  // scatter plot of valuer vs formula: one dot per sample property, toggle to linear axes
  const nFit = await page.evaluate(() => window.App.state.project.model.fit.n);
  assert.equal(await page.$$eval('#model-card svg.scatter circle.dot', d => d.length), nFit, 'one dot per sample property');
  await page.click('#model-card #chart-scale button[data-scale="linear"]');
  await page.waitForFunction(() => window.App.state.chartLog === false);
  assert.equal(await page.$$eval('#model-card svg.scatter circle.dot', d => d.length), nFit, 'dots survive the axis toggle');
  await page.click('#model-card #chart-scale button[data-scale="log"]');
  await page.waitForFunction(() => window.App.state.chartLog === true);
  await page.selectOption('#form-select', 'loglog');
  await page.waitForFunction(() => window.App.state.project.model.fit.form === 'loglog');
  await page.click('#compare-forms');
  assert.equal(await page.$$eval('#compare-box tbody tr', r => r.length), 3, 'three forms compared');
  await page.selectOption('#form-select', 'loglinear');
  await page.waitForFunction(() => window.App.state.project.model.fit.form === 'loglinear');

  // ---- saved models and comparison ---------------------------------------
  page.once('dialog', d => d.accept('Log-linear, fence locked'));
  await page.click('#btn-save-model');
  await page.waitForSelector('#compare-stats');
  assert.equal(await page.$$eval('#compare-stats tbody tr', r => r.length), 2, 'current + one saved model');
  await page.selectOption('#form-select', 'loglog');
  await page.waitForFunction(() => window.App.state.project.model.fit.form === 'loglog' && window.App.state.project.model.sourceName === null);
  page.once('dialog', d => d.accept('Log-log'));
  await page.click('#btn-save-model');
  await page.waitForFunction(() => document.querySelectorAll('#compare-stats tbody tr').length === 3);
  assert.equal(await page.$$eval('#compare-weights thead th', r => r.length), 4, 'term column + three models');
  assert.equal(await page.$$eval('#compare-charts svg.scatter', s => s.length), 3, 'one small-multiple plot per model');
  const moved = await page.$$eval('#compare-stats tbody tr', rows => rows.map(r => r.children[13].textContent));
  assert.equal(moved[0], 'reference');
  assert.ok(/%/.test(moved[1]) && /%/.test(moved[2]), 'moved share shown for saved models');
  // "Use" the first saved model: form goes back to log-linear with the fence lock
  await page.locator('#compare-stats tbody tr').nth(1).locator('button', { hasText: 'Use' }).click();
  await page.waitForFunction(() => window.App.state.project.model.fit.form === 'loglinear' && window.App.state.project.model.sourceName === 'Log-linear, fence locked');
  assert.ok(await page.evaluate(() => window.App.state.project.model.locks['f:fence'] === 10), 'lock restored from the saved model');
  const [cmpDownload] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-comparison')]);
  assert.equal(cmpDownload.suggestedFilename(), 'model_comparison.xlsx');
  await page.click('.tabs button[data-tab="results"]');
  await page.waitForFunction(() => /Active model: Log-linear, fence locked/.test(document.querySelector('#results-summary').textContent));
  assert.equal(await page.$$eval('#results-summary svg.scatter circle.dot', d => d.length), await page.evaluate(() => window.App.state.project.model.fit.n), 'results tab shows the plot');

  // ---- export ------------------------------------------------------------
  await page.click('.tabs button[data-tab="results"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-roll-csv')]);
  const csvPath = path.join(__dirname, 'out_valuation_roll.csv');
  await download.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, 'utf8');
  const header = csv.split(/\r?\n/)[0];
  for (const h of ['LandValue', 'ImprovementValue', 'TotalValue', 'LandRate_per_m2', 'LandRateBasis', 'LandRateSource', 'LCC_Area', 'LandAreaSource', 'BuiltAreaSource']) assert.ok(header.includes(h), 'export has ' + h);
  assert.equal(csv.trim().split(/\r?\n/).length, 251, '250 data rows exported');
  fs.unlinkSync(csvPath);

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
  await page.mouse.click(pts[0][0], pts[0][1]);
  await page.waitForFunction(() => window.App.state.project.properties[0].roofPolygons.length === 1);
  const area = await page.evaluate(() => window.App.state.project.properties[0].roofPolygons[0].area_m2);
  const mPerPx = 156543.03392 * Math.cos(-13.9626 * Math.PI / 180) / Math.pow(2, 19);
  const expected = Math.pow(100 * mPerPx, 2);
  assert.ok(Math.abs(area - expected) / expected < 0.1, 'traced area ' + area.toFixed(1) + ' m² close to expected ' + expected.toFixed(1));

  // drop a pin and check the Area is detected
  await page.click('#tool-pin');
  await page.mouse.click(cx, cy);
  await page.waitForFunction(() => window.App.state.project.properties[0].locationSource === 'map' && window.App.state.project.properties[0].areaId === 15);

  // ---- persistence across reload ----------------------------------------
  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForFunction(() => window.App.state.project && window.App.state.project.properties.length === 250);
  assert.ok(await page.evaluate(() => window.App.state.project.model.fit && window.App.state.project.model.fit.ok), 'fitted model survives reload');
  assert.equal(await page.evaluate(() => window.App.state.project.mode), 'advanced', 'mode persists');
  assert.equal(await page.evaluate(() => window.App.state.project.landRates.areas['3'].rate), 8784, 'edited rate persists');
  assert.equal(await page.evaluate(() => window.App.state.project.savedModels.length), 2, 'saved models persist');

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  console.log('e2e OK');
})().catch(e => { console.error('e2e FAILED:', e); process.exit(1); });
