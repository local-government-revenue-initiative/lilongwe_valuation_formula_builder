/*
 * engine.js - regression engine for the Lilongwe Valuation Formula Builder.
 *
 * Pure JavaScript, no DOM access and no dependencies, so the same file runs in
 * the browser (as the global `Engine`) and under Node for unit tests.
 *
 * Model forms
 *   linear     value      = b0 + b_area * area      + sum(b_f * x_f)
 *   loglinear  ln(value)  = b0 + b_area * area      + sum(b_f * x_f)   (default)
 *   loglog     ln(value)  = b0 + b_area * ln(area)  + sum(b_f * x_f)
 *
 * Locked weights are handled with the offset method: the locked terms are
 * subtracted from the dependent variable and the remaining ("free") columns are
 * fitted by ordinary least squares. This is exactly lm(y ~ free + offset(locked))
 * in R, so the fit can be reproduced independently.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMS = ['linear', 'loglinear', 'loglog'];

  /* ------------------------------------------------------------------ */
  /* Small numeric helpers                                               */
  /* ------------------------------------------------------------------ */

  function isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }

  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; }

  function median(a) {
    if (!a.length) return NaN;
    var b = a.slice().sort(function (x, y) { return x - y; });
    var m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }

  /* Lanczos approximation of ln(Gamma(x)) */
  function lgamma(x) {
    var c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    var y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    var ser = 1.000000000190015;
    for (var j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }

  /* Continued fraction for the incomplete beta function (modified Lentz) */
  function betacf(a, b, x) {
    var MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
    var qab = a + b, qap = a + 1, qam = a - 1;
    var c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    var h = d;
    for (var m = 1; m <= MAXIT; m++) {
      var m2 = 2 * m;
      var aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      var del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  /* Regularised incomplete beta I_x(a, b) */
  function betaInc(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
    return 1 - bt * betacf(b, a, 1 - x) / b;
  }

  /* Two-sided p-value for a t statistic with df degrees of freedom */
  function tTestPValue(t, df) {
    if (!isFiniteNumber(t) || !(df > 0)) return NaN;
    var x = df / (df + t * t);
    return betaInc(df / 2, 0.5, x);
  }

  /* ------------------------------------------------------------------ */
  /* Least squares by Householder QR with aliased-column detection       */
  /* ------------------------------------------------------------------ */

  /*
   * X: array of n rows, each an array of p numbers. y: array of n numbers.
   * Returns coefficients (0 for aliased columns), the list of aliased column
   * indices, the inverse of X'X restricted to the retained columns (for
   * standard errors) and the diagonal of the hat matrix (for leave-one-out).
   */
  function lstsq(X, y) {
    var n = X.length;
    var p = n ? X[0].length : 0;
    var A = X.map(function (r) { return r.slice(); });
    var b = y.slice();
    var kept = [];          // original column indices retained, in order
    var aliased = [];
    var colNorm = [];
    for (var j = 0; j < p; j++) {
      var s = 0;
      for (var i = 0; i < n; i++) s += A[i][j] * A[i][j];
      colNorm.push(Math.sqrt(s));
    }
    var TOL = 1e-8;
    var rank = 0;
    // Householder reflections applied column by column; a column whose
    // remaining norm is negligible relative to its original norm is aliased.
    for (j = 0; j < p; j++) {
      var k = rank;
      var norm = 0;
      for (i = k; i < n; i++) norm += A[i][j] * A[i][j];
      norm = Math.sqrt(norm);
      if (norm <= TOL * Math.max(colNorm[j], 1e-300) || norm === 0 || k >= n) {
        aliased.push(j);
        continue;
      }
      var alpha = A[k][j] > 0 ? -norm : norm;
      var v = new Array(n).fill(0);
      v[k] = A[k][j] - alpha;
      for (i = k + 1; i < n; i++) v[i] = A[i][j];
      var vnorm2 = 0;
      for (i = k; i < n; i++) vnorm2 += v[i] * v[i];
      if (vnorm2 > 0) {
        // apply H = I - 2 v v' / (v'v) to remaining columns of A and to b
        for (var c = j; c < p; c++) {
          var dot = 0;
          for (i = k; i < n; i++) dot += v[i] * A[i][c];
          var f = 2 * dot / vnorm2;
          if (f !== 0) for (i = k; i < n; i++) A[i][c] -= f * v[i];
        }
        var dotb = 0;
        for (i = k; i < n; i++) dotb += v[i] * b[i];
        var fb = 2 * dotb / vnorm2;
        for (i = k; i < n; i++) b[i] -= fb * v[i];
      }
      kept.push(j);
      rank++;
    }
    // R is the upper-left rank x rank block over the kept columns.
    var R = [];
    for (var r = 0; r < rank; r++) {
      R.push([]);
      for (var q = 0; q < rank; q++) R[r].push(q < r ? 0 : A[r][kept[q]]);
    }
    // back substitution: R beta_kept = Qty[0..rank)
    var betaKept = new Array(rank).fill(0);
    for (r = rank - 1; r >= 0; r--) {
      var acc = b[r];
      for (q = r + 1; q < rank; q++) acc -= R[r][q] * betaKept[q];
      betaKept[r] = acc / R[r][r];
    }
    // R^-1 by back substitution on the identity
    var Rinv = [];
    for (r = 0; r < rank; r++) Rinv.push(new Array(rank).fill(0));
    for (var col = 0; col < rank; col++) {
      for (r = rank - 1; r >= 0; r--) {
        var a2 = (r === col ? 1 : 0);
        for (q = r + 1; q < rank; q++) a2 -= R[r][q] * Rinv[q][col];
        Rinv[r][col] = a2 / R[r][r];
      }
    }
    // (X'X)^-1 = Rinv Rinv'
    var XtXinv = [];
    for (r = 0; r < rank; r++) {
      XtXinv.push([]);
      for (q = 0; q < rank; q++) {
        var s2 = 0;
        for (var m = 0; m < rank; m++) s2 += Rinv[r][m] * Rinv[q][m];
        XtXinv[r].push(s2);
      }
    }
    // hat diagonal: h_i = x_i (X'X)^-1 x_i'
    var hat = new Array(n).fill(0);
    for (i = 0; i < n; i++) {
      var xi = kept.map(function (j2) { return X[i][j2]; });
      var h = 0;
      for (r = 0; r < rank; r++) {
        var t = 0;
        for (q = 0; q < rank; q++) t += XtXinv[r][q] * xi[q];
        h += xi[r] * t;
      }
      hat[i] = h;
    }
    var beta = new Array(p).fill(0);
    for (r = 0; r < rank; r++) beta[kept[r]] = betaKept[r];
    return { beta: beta, kept: kept, aliased: aliased, rank: rank, XtXinv: XtXinv, hat: hat };
  }

  /* ------------------------------------------------------------------ */
  /* Design matrix                                                       */
  /* ------------------------------------------------------------------ */

  function parseBoolean(v) {
    if (v === true || v === false) return v;
    if (v === null || v === undefined) return null;
    var s = String(v).trim().toLowerCase();
    if (['1', 'yes', 'y', 'true', 't'].indexOf(s) >= 0) return true;
    if (['0', 'no', 'n', 'false', 'f'].indexOf(s) >= 0) return false;
    return null;
  }

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).replace(/[,\s]/g, '').replace(/^MK|^MWK/i, '');
    if (s === '') return null;
    var x = Number(s);
    return isFinite(x) ? x : null;
  }

  /*
   * Build the column specification for a model.
   *   features: [{ id, name, type: numeric|categorical|boolean, baseCategory }]
   *   rows: [{ area, value, chars: {featureId: rawValue} }] - used to pick the
   *         most frequent category as base when none is set.
   *   areaLabel: label for the area column (e.g. "Built area (m²)")
   */
  function buildColumns(form, features, rows, areaLabel) {
    var columns = [{ key: 'intercept', kind: 'intercept', label: 'Base value' }];
    columns.push({
      key: 'area', kind: 'area',
      label: areaLabel || 'Area (m²)',
      transform: form === 'loglog' ? 'log' : 'raw'
    });
    (features || []).forEach(function (f) {
      if (f.type === 'numeric') {
        columns.push({ key: 'f:' + f.id, kind: 'numeric', featureId: f.id, label: f.name });
      } else if (f.type === 'boolean') {
        columns.push({ key: 'f:' + f.id, kind: 'boolean', featureId: f.id, label: f.name });
      } else if (f.type === 'categorical') {
        var counts = {};
        (rows || []).forEach(function (r) {
          var v = r.chars ? r.chars[f.id] : undefined;
          if (v === null || v === undefined || v === '') return;
          v = String(v);
          counts[v] = (counts[v] || 0) + 1;
        });
        var cats = (f.categories && f.categories.length) ? f.categories.slice() : Object.keys(counts);
        Object.keys(counts).forEach(function (c) { if (cats.indexOf(c) < 0) cats.push(c); });
        var base = f.baseCategory && cats.indexOf(f.baseCategory) >= 0 ? f.baseCategory : null;
        if (!base) {
          var best = -1;
          cats.forEach(function (c) { if ((counts[c] || 0) > best) { best = counts[c] || 0; base = c; } });
        }
        cats.forEach(function (c) {
          columns.push({
            key: 'f:' + f.id + ':' + c, kind: 'category', featureId: f.id, category: c,
            label: f.name + ': ' + c, isBase: c === base, base: base, count: counts[c] || 0
          });
        });
      }
    });
    return columns;
  }

  /*
   * Convert one property row into a design vector for the given columns.
   * Returns { x, missing: [featureIds], invalid: reason|null }.
   * Base-category columns are included (as zeros) so column indices line up
   * with the coefficient vector; they are never fitted.
   */
  function rowVector(columns, form, row, impute) {
    var x = [];
    var missing = [];
    var invalid = null;
    var area = toNumber(row.area);
    for (var j = 0; j < columns.length; j++) {
      var c = columns[j];
      var v;
      if (c.kind === 'intercept') v = 1;
      else if (c.kind === 'area') {
        if (area === null) { invalid = 'missing area'; v = 0; }
        else if (c.transform === 'log') {
          if (area <= 0) { invalid = 'area must be positive for a log model'; v = 0; }
          else v = Math.log(area);
        } else v = area;
      } else {
        var raw = row.chars ? row.chars[c.featureId] : undefined;
        var absent = (raw === null || raw === undefined || raw === '');
        if (c.kind === 'numeric') {
          var num = absent ? null : toNumber(raw);
          if (num === null) { if (missing.indexOf(c.featureId) < 0) missing.push(c.featureId); v = 0; }
          else v = num;
        } else if (c.kind === 'boolean') {
          var bv = absent ? null : parseBoolean(raw);
          if (bv === null) { if (missing.indexOf(c.featureId) < 0) missing.push(c.featureId); v = 0; }
          else v = bv ? 1 : 0;
        } else if (c.kind === 'category') {
          if (absent) { if (missing.indexOf(c.featureId) < 0) missing.push(c.featureId); v = 0; }
          else v = (String(raw) === c.category && !c.isBase) ? 1 : 0;
        }
      }
      x.push(v);
    }
    if (missing.length && !impute) invalid = invalid || ('missing characteristic(s): ' + missing.join(', '));
    return { x: x, missing: missing, invalid: invalid };
  }

  function responseValue(form, value) {
    var y = toNumber(value);
    if (y === null) return { y: null, invalid: 'missing value' };
    if (form !== 'linear') {
      if (y <= 0) return { y: null, invalid: 'value must be positive for a log model' };
      return { y: Math.log(y), invalid: null };
    }
    return { y: y, invalid: null };
  }

  /* ------------------------------------------------------------------ */
  /* Fitting                                                             */
  /* ------------------------------------------------------------------ */

  /*
   * spec = {
   *   form, columns,
   *   included: { columnKey: true|false }   (default true; base columns always excluded)
   *   locks:    { columnKey: coefficient }  (coefficient scale)
   *   smearing: boolean                      (Duan correction for log forms)
   * }
   * rows = [{ id, area, value, chars }]  - only rows with a value are used
   */
  function fit(spec, rows) {
    var form = spec.form || 'loglinear';
    if (FORMS.indexOf(form) < 0) throw new Error('unknown model form: ' + form);
    var columns = spec.columns;
    var included = spec.included || {};
    var locks = spec.locks || {};
    var used = [], excluded = [], X = [], y = [], yLevel = [], ids = [];
    rows.forEach(function (r) {
      var resp = responseValue(form, r.value);
      if (resp.invalid) { if (toNumber(r.value) !== null) excluded.push({ id: r.id, reason: resp.invalid }); return; }
      var rv = rowVector(columns, form, r, false);
      if (rv.invalid) { excluded.push({ id: r.id, reason: rv.invalid }); return; }
      used.push(r.id); ids.push(r.id);
      X.push(rv.x); y.push(resp.y); yLevel.push(toNumber(r.value));
    });
    var n = X.length;
    var p = columns.length;
    var isFree = [], isLocked = [], isActive = [];
    columns.forEach(function (c) {
      var active = c.isBase ? false : (included[c.key] !== false);
      var locked = active && Object.prototype.hasOwnProperty.call(locks, c.key) && isFiniteNumber(locks[c.key]);
      isActive.push(active); isLocked.push(locked); isFree.push(active && !locked);
    });
    var freeIdx = [];
    for (var j = 0; j < p; j++) if (isFree[j]) freeIdx.push(j);
    var warnings = [];
    if (n === 0) {
      return emptyResult(spec, columns, form, excluded, ['No usable sample properties: enter values (and areas) for at least a few properties.']);
    }
    if (n < 10) warnings.push('Only ' + n + ' sample properties were used; results are unreliable with fewer than about 10, and more is much better.');
    if (n <= freeIdx.length) warnings.push('More free weights (' + freeIdx.length + ') than sample properties (' + n + '): the model is under-determined. Lock or drop some weights or add sample values.');

    // offset for locked columns
    var offset = new Array(n).fill(0);
    for (var i = 0; i < n; i++) for (j = 0; j < p; j++) if (isLocked[j]) offset[i] += locks[columns[j].key] * X[i][j];
    var yStar = y.map(function (v, i2) { return v - offset[i2]; });
    var Xfree = X.map(function (r) { return freeIdx.map(function (j2) { return r[j2]; }); });

    var ls = freeIdx.length ? lstsq(Xfree, yStar) : { beta: [], kept: [], aliased: [], rank: 0, XtXinv: [], hat: new Array(n).fill(0) };
    var coef = new Array(p).fill(0), se = new Array(p).fill(null), t = new Array(p).fill(null), pv = new Array(p).fill(null);
    var aliased = ls.aliased.map(function (k) { return columns[freeIdx[k]].key; });
    var status = columns.map(function (c, j2) {
      if (c.isBase) return 'base';
      if (!isActive[j2]) return 'excluded';
      if (isLocked[j2]) return 'locked';
      return 'free';
    });
    aliased.forEach(function (key) { status[columns.findIndex(function (c) { return c.key === key; })] = 'aliased'; });
    for (var k = 0; k < freeIdx.length; k++) coef[freeIdx[k]] = ls.beta[k];
    for (j = 0; j < p; j++) if (isLocked[j]) coef[j] = locks[columns[j].key];

    // fitted values and residuals in the regression scale
    var fitted = [], resid = [];
    for (i = 0; i < n; i++) {
      var eta = 0;
      for (j = 0; j < p; j++) eta += coef[j] * X[i][j];
      fitted.push(eta); resid.push(y[i] - eta);
    }
    var df = n - ls.rank;
    var sse = 0; for (i = 0; i < n; i++) sse += resid[i] * resid[i];
    var sigma2 = df > 0 ? sse / df : NaN;
    for (k = 0; k < ls.kept.length; k++) {
      var jj = freeIdx[ls.kept[k]];
      var s = Math.sqrt(sigma2 * ls.XtXinv[k][k]);
      se[jj] = s; t[jj] = s > 0 ? coef[jj] / s : NaN; pv[jj] = tTestPValue(t[jj], df);
    }
    var ybar = mean(y);
    var sst = 0; for (i = 0; i < n; i++) sst += (y[i] - ybar) * (y[i] - ybar);
    var r2 = sst > 0 ? 1 - sse / sst : NaN;
    var adjR2 = (df > 0 && sst > 0 && n > 1) ? 1 - (1 - r2) * (n - 1) / df : NaN;
    if (isFiniteNumber(r2) && r2 < 0) warnings.push('R² is negative: the locked weights fit the sample worse than a flat average. Reconsider the locks.');

    // smearing factor (Duan) for log forms
    var smear = 1;
    if (form !== 'linear' && spec.smearing) {
      var s2 = 0; for (i = 0; i < n; i++) s2 += Math.exp(resid[i]);
      smear = s2 / n;
    }
    var predLevel = fitted.map(function (e) { return form === 'linear' ? e : Math.exp(e) * smear; });

    // level-scale measures
    var sseL = 0, sstL = 0, ybarL = mean(yLevel);
    for (i = 0; i < n; i++) { sseL += Math.pow(yLevel[i] - predLevel[i], 2); sstL += Math.pow(yLevel[i] - ybarL, 2); }
    var rmse = Math.sqrt(sseL / n);
    var r2Level = sstL > 0 ? 1 - sseL / sstL : NaN;
    var rmseLog = form === 'linear' ? null : Math.sqrt(sse / n);
    var mape = mean(yLevel.map(function (v, i2) { return Math.abs(v - predLevel[i2]) / Math.abs(v); })) * 100;

    // leave-one-out predictions via the hat matrix (free part only). A row
    // with leverage 1 fully determines a weight and cannot be predicted
    // without itself; such rows are skipped and counted.
    var loo = [];
    var looSse = 0, looN = 0, looSkipped = 0;
    for (i = 0; i < n; i++) {
      var h = ls.hat[i];
      if (!(h < 1 - 1e-10)) { looSkipped++; loo.push(null); continue; }
      var etaLoo = fitted[i] - resid[i] * h / (1 - h);
      var pl = form === 'linear' ? etaLoo : Math.exp(etaLoo) * smear;
      loo.push(pl); looSse += Math.pow(yLevel[i] - pl, 2); looN++;
    }
    var loocvRmse = looN > 0 ? Math.sqrt(looSse / looN) : null;
    if (looSkipped) warnings.push('Leave-one-out RMSE is computed without ' + looSkipped + ' sample propert' + (looSkipped === 1 ? 'y' : 'ies') + ' that alone determine a weight (leverage 1). Rare categories are the usual cause.');

    // ratio study statistics (IAAO): ratio = predicted / actual
    var ratios = predLevel.map(function (pr, i2) { return pr / yLevel[i2]; });
    var medR = median(ratios);
    var cod = 100 * mean(ratios.map(function (r) { return Math.abs(r - medR); })) / medR;
    var sumPred = 0, sumAct = 0; for (i = 0; i < n; i++) { sumPred += predLevel[i]; sumAct += yLevel[i]; }
    var prd = mean(ratios) / (sumPred / sumAct);

    // rare categories among fitted rows
    var rare = [];
    columns.forEach(function (c, j2) {
      if (c.kind !== 'category' || !isActive[j2]) return;
      var cnt = 0; for (i = 0; i < n; i++) cnt += X[i][j2];
      if (cnt > 0 && cnt < 5) rare.push({ key: c.key, label: c.label, count: cnt });
      if (cnt === 0 && status[j2] === 'free') status[j2] = 'aliased';
    });
    if (rare.length) warnings.push('Some categories appear fewer than 5 times in the sample (' + rare.map(function (r) { return r.label + ': ' + r.count; }).join('; ') + '). Their weights are unreliable; consider merging categories or locking a weight.');
    if (aliased.length) warnings.push('Some weights could not be estimated because their columns duplicate other columns or never vary in the sample: ' + aliased.join(', ') + '. They are set to 0.');

    // unconstrained comparison (all active columns free)
    var unconstrainedR2 = r2;
    if (isLocked.some(Boolean)) {
      var activeIdx = []; for (j = 0; j < p; j++) if (isActive[j]) activeIdx.push(j);
      var Xa = X.map(function (r) { return activeIdx.map(function (j2) { return r[j2]; }); });
      var lsU = lstsq(Xa, y);
      var sseU = 0;
      for (i = 0; i < n; i++) { var e2 = y[i]; for (k = 0; k < activeIdx.length; k++) e2 -= lsU.beta[k] * Xa[i][k]; sseU += e2 * e2; }
      unconstrainedR2 = sst > 0 ? 1 - sseU / sst : NaN;
    }

    return {
      ok: true, form: form, columns: columns, coef: coef, se: se, t: t, p: pv, status: status,
      n: n, kFree: ls.rank, df: df, smearing: smear,
      r2: r2, adjR2: adjR2, r2Level: r2Level, rmse: rmse, rmseLog: rmseLog, mape: mape,
      loocvRmse: loocvRmse, loocvSkipped: looSkipped, cod: cod, prd: prd, medianRatio: medR, unconstrainedR2: unconstrainedR2,
      aliased: aliased, rareCategories: rare, warnings: warnings, excluded: excluded,
      sample: ids.map(function (id, i2) {
        return { id: id, actual: yLevel[i2], predicted: predLevel[i2], loo: loo[i2], ratio: ratios[i2], leverage: ls.hat[i2] };
      })
    };
  }

  function emptyResult(spec, columns, form, excluded, warnings) {
    return {
      ok: false, form: form, columns: columns, coef: columns.map(function () { return 0; }),
      se: columns.map(function () { return null; }), t: columns.map(function () { return null; }), p: columns.map(function () { return null; }),
      status: columns.map(function (c) { return c.isBase ? 'base' : 'free'; }),
      n: 0, kFree: 0, df: 0, smearing: 1, r2: NaN, adjR2: NaN, r2Level: NaN, rmse: NaN, rmseLog: null, mape: NaN,
      loocvRmse: null, loocvSkipped: 0, cod: NaN, prd: NaN, medianRatio: NaN, unconstrainedR2: NaN,
      aliased: [], rareCategories: [], warnings: warnings, excluded: excluded, sample: []
    };
  }

  /* ------------------------------------------------------------------ */
  /* Prediction                                                          */
  /* ------------------------------------------------------------------ */

  /*
   * model: { form, columns, coef, smearing }
   * Returns { value, eta, contributions:[{column, x, coef, contribution}], missing, invalid }
   */
  function predict(model, row) {
    var rv = rowVector(model.columns, model.form, row, true);
    if (rv.invalid) return { value: null, eta: null, contributions: [], missing: rv.missing, invalid: rv.invalid };
    var eta = 0, contributions = [];
    for (var j = 0; j < model.columns.length; j++) {
      var c = model.coef[j] || 0;
      var contrib = c * rv.x[j];
      eta += contrib;
      contributions.push({ column: model.columns[j], x: rv.x[j], coef: c, contribution: contrib });
    }
    var value = model.form === 'linear' ? eta : Math.exp(eta) * (model.smearing || 1);
    return { value: value, eta: eta, contributions: contributions, missing: rv.missing, invalid: null };
  }

  /* ------------------------------------------------------------------ */
  /* Weight conversions (display units <-> coefficient)                  */
  /* ------------------------------------------------------------------ */

  /*
   * Display units:
   *   log forms:  intercept -> base value (exp), area (raw) -> % per m²,
   *               area (log) -> exponent, other columns -> % weight
   *   linear:     all in currency units (intercept = base, area = per m²)
   */
  function coefToDisplay(form, column, coef) {
    if (!isFiniteNumber(coef)) return null;
    if (form === 'linear') return coef;
    if (column.kind === 'intercept') return Math.exp(coef);
    if (column.kind === 'area' && column.transform === 'log') return coef;
    if (column.kind === 'numeric' || (column.kind === 'area')) return (Math.exp(coef) - 1) * 100;
    return (Math.exp(coef) - 1) * 100;
  }

  function displayToCoef(form, column, display) {
    if (!isFiniteNumber(display)) return null;
    if (form === 'linear') return display;
    if (column.kind === 'intercept') return display > 0 ? Math.log(display) : null;
    if (column.kind === 'area' && column.transform === 'log') return display;
    if (display <= -100) return null;
    return Math.log(1 + display / 100);
  }

  function displayUnit(form, column) {
    if (form === 'linear') {
      if (column.kind === 'intercept') return 'currency';
      if (column.kind === 'area' || column.kind === 'numeric') return 'currency per unit';
      return 'currency';
    }
    if (column.kind === 'intercept') return 'currency';
    if (column.kind === 'area') return column.transform === 'log' ? 'exponent' : '% per m²';
    if (column.kind === 'numeric') return '% per unit';
    return '%';
  }

  return {
    FORMS: FORMS,
    lstsq: lstsq,
    buildColumns: buildColumns,
    rowVector: rowVector,
    fit: fit,
    predict: predict,
    coefToDisplay: coefToDisplay,
    displayToCoef: displayToCoef,
    displayUnit: displayUnit,
    toNumber: toNumber,
    parseBoolean: parseBoolean,
    tTestPValue: tTestPValue,
    betaInc: betaInc,
    median: median,
    mean: mean
  };
}));
