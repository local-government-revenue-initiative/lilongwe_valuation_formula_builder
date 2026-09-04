/*
 * formula.js - turns a fitted model into things staff and taxpayers can read:
 * a weights table, the formula in words, and a per-property calculation sheet
 * in the style of Figure 13 of the LoGRI guidance note.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.Formula = factory(root.Engine);
}(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  function fmtNum(x, digits) {
    if (x === null || x === undefined || !isFinite(x)) return '–';
    return x.toLocaleString('en-GB', { maximumFractionDigits: digits === undefined ? 2 : digits, minimumFractionDigits: 0 });
  }

  function fmtMoney(x, currency) {
    if (x === null || x === undefined || !isFinite(x)) return '–';
    return (currency || 'MWK') + ' ' + x.toLocaleString('en-GB', { maximumFractionDigits: 0 });
  }

  function fmtPct(x) {
    if (x === null || x === undefined || !isFinite(x)) return '–';
    var s = x.toLocaleString('en-GB', { maximumFractionDigits: Math.abs(x) < 1 ? 3 : 1 });
    return (x > 0 ? '+' : '') + s + ' %';
  }

  function fmtP(p) {
    if (p === null || p === undefined || !isFinite(p)) return '–';
    if (p < 0.001) return '< 0.001';
    return p.toFixed(3);
  }

  /* Weight in display units, formatted with its unit */
  function fmtWeight(form, column, coef, currency) {
    var d = Engine.coefToDisplay(form, column, coef);
    if (d === null) return '–';
    var unit = Engine.displayUnit(form, column);
    if (unit === 'currency') return fmtMoney(d, currency);
    if (unit === 'currency per unit') return fmtMoney(d, currency) + (column.kind === 'area' ? ' per m²' : ' per unit');
    if (unit === 'exponent') return d.toFixed(3);
    if (unit === '% per m²') return fmtPct(d) + ' per m²';
    if (unit === '% per unit') return fmtPct(d) + ' per unit';
    return fmtPct(d);
  }

  /*
   * Significance category, following Figure 11 of the guidance note:
   * confident (p < 0.05), mixed (p < 0.20), weak, base, locked, aliased.
   */
  function significance(status, p) {
    if (status === 'base') return { code: 'base', label: 'Base (0 by definition)' };
    if (status === 'locked') return { code: 'locked', label: 'Set manually' };
    if (status === 'aliased') return { code: 'aliased', label: 'Not estimable' };
    if (status === 'excluded') return { code: 'excluded', label: 'Not in model' };
    if (p === null || p === undefined || !isFinite(p)) return { code: 'weak', label: 'Unknown' };
    if (p < 0.05) return { code: 'confident', label: 'Confident' };
    if (p < 0.20) return { code: 'mixed', label: 'Mixed' };
    return { code: 'weak', label: 'Weak' };
  }

  /* Formula as a sentence, for the given form */
  function formulaText(form, areaName) {
    areaName = areaName || 'Area';
    if (form === 'linear') return 'Value = Base value + (weight per m² × ' + areaName + ') + sum of feature weights';
    if (form === 'loglog') return 'Value = Base value × ' + areaName + '^(area exponent) × product of (1 + feature weight)';
    return 'Value = Base value × (1 + weight per m²)^' + areaName + ' × product of (1 + feature weight)';
  }

  function formDescription(form) {
    if (form === 'linear') return 'Linear: value in currency, each weight adds or subtracts a fixed amount.';
    if (form === 'loglog') return 'Log-log: value and area both logged. Weights are percentages; the area exponent (e.g. 0.75) means value grows more slowly than area. This is the form used in the LoGRI guidance note.';
    return 'Log-linear: value logged, area not transformed. Weights are percentages; each extra square metre multiplies value by the same factor, so value grows exponentially with area. Check the fit statistics against the other forms before relying on this at large areas.';
  }

  /*
   * Rows for the weights table. Each: { column, status, coef, display, unit,
   * weightText, se, t, p, significance, count }
   */
  function weightsTable(fit, currency) {
    if (!fit) return [];
    return fit.columns.map(function (c, j) {
      var status = fit.status[j];
      return {
        column: c, status: status, coef: fit.coef[j],
        display: Engine.coefToDisplay(fit.form, c, fit.coef[j]),
        unit: Engine.displayUnit(fit.form, c),
        weightText: status === 'base' ? (fit.form === 'linear' ? fmtMoney(0, currency) : '+0 %') : fmtWeight(fit.form, c, fit.coef[j], currency),
        se: fit.se[j], t: fit.t[j], p: fit.p[j],
        significance: significance(status, fit.p[j]),
        count: c.count
      };
    });
  }

  /*
   * Calculation sheet for one property under one model.
   * Returns { ok, lines:[{label, detail, factorText}], value, valueText, notes }
   */
  function calculationSheet(model, row, currency, areaName) {
    var pr = Engine.predict(model, row);
    if (pr.invalid) return { ok: false, lines: [], value: null, valueText: '–', notes: [pr.invalid] };
    var form = model.form;
    var lines = [];
    var notes = [];
    var running = null;
    pr.contributions.forEach(function (ct) {
      var c = ct.column;
      if (c.kind === 'intercept') {
        var base = form === 'linear' ? ct.coef : Math.exp(ct.coef) * (model.smearing || 1);
        running = base;
        lines.push({ label: 'Base value', detail: form === 'linear' ? 'starting amount' : 'value of a base property before area and features', factorText: fmtMoney(base, currency) });
      } else if (c.kind === 'area') {
        var area = Engine.toNumber(row.area);
        if (form === 'linear') {
          running += ct.contribution;
          lines.push({ label: areaName || 'Area', detail: fmtNum(area) + ' m² × ' + fmtMoney(ct.coef, currency) + ' per m²', factorText: '+ ' + fmtMoney(ct.contribution, currency) });
        } else if (c.transform === 'log') {
          var f = Math.exp(ct.contribution);
          running *= f;
          lines.push({ label: areaName || 'Area', detail: fmtNum(area) + ' m² ^ ' + ct.coef.toFixed(3), factorText: '× ' + fmtNum(f, 3) });
        } else {
          var f2 = Math.exp(ct.contribution);
          running *= f2;
          lines.push({ label: areaName || 'Area', detail: '(1 ' + (ct.coef >= 0 ? '+ ' : '− ') + fmtNum(Math.abs(Math.exp(ct.coef) - 1) * 100, 3) + ' %)^' + fmtNum(area), factorText: '× ' + fmtNum(f2, 3) });
        }
      } else {
        if (c.isBase) {
          if (String(row.chars && row.chars[c.featureId]) === c.category) lines.push({ label: c.label, detail: 'base category', factorText: form === 'linear' ? '+ ' + fmtMoney(0, currency) : '+0 %' });
          return;
        }
        if (ct.x === 0) return;
        if (form === 'linear') {
          running += ct.contribution;
          lines.push({ label: c.label, detail: c.kind === 'numeric' ? fmtNum(ct.x) + ' × ' + fmtMoney(ct.coef, currency) : 'yes', factorText: '+ ' + fmtMoney(ct.contribution, currency) });
        } else {
          var pct = (Math.exp(ct.coef) - 1) * 100;
          var f3 = Math.exp(ct.contribution);
          running *= f3;
          lines.push({ label: c.label, detail: (c.kind === 'numeric' ? fmtNum(ct.x) + ' × ' : '') + fmtPct(pct), factorText: '× ' + fmtNum(f3, 3) });
        }
      }
    });
    if (pr.missing && pr.missing.length) notes.push('Missing characteristic(s) treated as the base category / 0: ' + pr.missing.join(', '));
    return { ok: true, lines: lines, value: pr.value, valueText: fmtMoney(pr.value, currency), notes: notes };
  }

  /* One-line summary of fit statistics */
  function fitSummary(fit, currency) {
    if (!fit || !fit.ok) return [];
    var out = [
      { label: 'Sample size (n)', value: String(fit.n), help: 'Properties with a value used to fit this model.' },
      { label: 'R²', value: fmtNum(fit.r2, 3), help: 'Share of variation in ' + (fit.form === 'linear' ? 'value' : 'log value') + ' explained by the model. LoGRI implementations typically reach 0.7 or above; below 0.5 suggests data problems.' },
      { label: 'Adjusted R²', value: fmtNum(fit.adjR2, 3), help: 'R² penalised for the number of free weights.' },
      { label: 'RMSE', value: fmtMoney(fit.rmse, currency), help: 'Typical error of a predicted value in currency units, on the sample.' },
      { label: 'Leave-one-out RMSE' + (fit.loocvSkipped ? ' *' : ''), value: fit.loocvRmse === null ? '–' : fmtMoney(fit.loocvRmse, currency), help: 'Error when each property is predicted by a model fitted without it. Much larger than RMSE means over-fitting.' + (fit.loocvSkipped ? ' * Computed without ' + fit.loocvSkipped + ' propert' + (fit.loocvSkipped === 1 ? 'y' : 'ies') + ' that alone determine a weight.' : '') },
      { label: 'Median ratio', value: fmtNum(fit.medianRatio, 3), help: 'Median of predicted ÷ actual. Should be close to 1.' },
      { label: 'COD', value: fmtNum(fit.cod, 1) + ' %', help: 'Coefficient of dispersion: average % spread of ratios around the median. Lower is more uniform; mass-appraisal standards usually look for under 15–20 %.' },
      { label: 'PRD', value: fmtNum(fit.prd, 3), help: 'Price-related differential: above ~1.03 means high-value properties are under-assessed relative to low-value ones (regressive); below ~0.98 the reverse.' }
    ];
    if (fit.form !== 'linear') {
      out.splice(3, 0, { label: 'R² on values', value: fmtNum(fit.r2Level, 3), help: 'R² measured on the un-logged values.' });
      out.push({ label: 'RMSE (log units)', value: fmtNum(fit.rmseLog, 3), help: 'Error in log units; roughly the typical proportional error.' });
    }
    if (fit.unconstrainedR2 !== fit.r2 && isFinite(fit.unconstrainedR2)) {
      out.push({ label: 'R² without locks', value: fmtNum(fit.unconstrainedR2, 3), help: 'What R² would be if the locked weights were estimated freely. The gap is the cost of the manual settings.' });
    }
    return out;
  }

  /*
   * Land lines for the calculation sheet.
   * lv = result of Valuation.landValueFor(project, property)
   */
  function landSheet(lv, currency) {
    if (!lv || lv.value === null) return { ok: false, lines: [], value: null, valueText: '–', notes: [lv && lv.reason ? lv.reason : 'no land area'] };
    var ri = lv.rateInfo;
    var lines = [
      { label: 'Land rate', detail: ri.label + (ri.uplift && ri.uplift !== 1 ? ' × uplift ' + fmtNum(ri.uplift, 2) : '') + (ri.source ? ' (' + ri.source + ')' : ''), factorText: fmtMoney(ri.rate, currency) + ' per m²' },
      { label: 'Parcel area', detail: 'traced or entered land area', factorText: fmtNum(lv.landArea, 1) + ' m²' }
    ];
    var notes = [];
    if (ri.basis === 'default') notes.push('No rate is set for this property\'s Area or Sector; the city-wide default rate was used.');
    return { ok: true, lines: lines, value: lv.value, valueText: fmtMoney(lv.value, currency), notes: notes };
  }

  /* Method statement for the report (Property Valuation Act 2024 s.22) */
  function methodStatement(project, fit) {
    var basis = project.valueBasis === 'annual_rental' ? 'estimated annual rental value' : 'capital (market) value';
    var lr = project.landRates || {};
    var out = [];
    out.push('Basis of valuation: ' + basis + ', in ' + (project.currency || 'MWK') + '.');
    out.push('Land: direct market comparative method (s.22(4)(a)). Land value = rate per m² for the property\'s ' + (lr.level === 'sector' ? 'Sector' : 'Area') + ' × parcel area. The schedule of rates starts from the median land values per m² in the 2011 valuation roll' + (lr.upliftFactor && lr.upliftFactor !== 1 ? ', multiplied by an uplift factor of ' + fmtNum(lr.upliftFactor, 3) : '') + '; properties in Areas without a rate use a default of ' + fmtMoney(lr.defaultRate, project.currency) + ' per m². Rates edited by the valuer are marked in the schedule.');
    out.push('Improvements: residual method (s.22(4)(f)). For each sample property the improvement value is the valuer\'s total value less the land value. A least-squares regression (' + (fit ? formDescription(fit.form).split(':')[0] : 'log-linear') + ' form) calibrates a formula of built area and observable characteristics on those residuals; the formula is then applied to every property.');
    out.push('Total value = land value + improvement value, reported separately (Local Government Act s.68(1)).');
    out.push('Assumptions: areas are roof-line measurements from imagery × floors, or figures entered by staff, as recorded per property; characteristics are externally observed; the 2011 land rates require adjustment to the valuation date; the model is calibrated on ' + (fit ? fit.n : 0) + ' sample properties.');
    return out;
  }

  return {
    fmtNum: fmtNum, fmtMoney: fmtMoney, fmtPct: fmtPct, fmtP: fmtP, fmtWeight: fmtWeight,
    significance: significance, formulaText: formulaText, formDescription: formDescription,
    weightsTable: weightsTable, calculationSheet: calculationSheet, fitSummary: fitSummary,
    landSheet: landSheet, methodStatement: methodStatement
  };
}));
