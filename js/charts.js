/*
 * charts.js - small inline-SVG charts, no library. Currently one chart type:
 * a scatter of the valuer's building value against the formula's prediction,
 * with a 45° reference line and ±20 % bands, on log or linear axes, with a
 * per-point hover tooltip. Built with DOM calls so it works from file://.
 */
(function (root) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var COLOR = { dot: '#14472e', ring: '#ffffff', ref: '#4a5a4a', band: '#c8d3e0', grid: '#e4eae4', text: '#1f2933', muted: '#4a5a4a', hover: '#e8a838' };

  function svgEl(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function compact(v) {
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toLocaleString('en-GB', { maximumFractionDigits: 1 }) + ' bn';
    if (a >= 1e6) return (v / 1e6).toLocaleString('en-GB', { maximumFractionDigits: 1 }) + ' M';
    if (a >= 1e3) return (v / 1e3).toLocaleString('en-GB', { maximumFractionDigits: 0 }) + ' k';
    return v.toLocaleString('en-GB', { maximumFractionDigits: 0 });
  }

  function niceLinearTicks(lo, hi, count) {
    var span = hi - lo || 1;
    var raw = span / (count || 5);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var step = [1, 2, 5, 10].map(function (m) { return m * mag; }).find(function (s) { return s >= raw; }) || mag * 10;
    var ticks = [];
    for (var t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(t);
    return ticks;
  }

  function logTicks(lo, hi) {
    var major = [], minor = [];
    var a = Math.floor(Math.log10(lo)), b = Math.ceil(Math.log10(hi));
    for (var e = a; e <= b; e++) {
      var base = Math.pow(10, e);
      if (base >= lo && base <= hi) major.push(base);
      [2, 5].forEach(function (m) { var v = m * base; if (v >= lo && v <= hi) minor.push(v); });
    }
    if (major.length <= 2) { major = major.concat(minor); minor = []; major.sort(function (x, y) { return x - y; }); }
    return { major: major, minor: minor };
  }

  /*
   * opts = { points: [{ x, y, label, sub }], title, subtitle, xLabel, yLabel,
   *          log: true|false, width, height, domain: [min, max] (shared axes), compact: bool }
   * Returns { svg, skipped }  (skipped = points dropped because non-positive on a log scale)
   */
  function scatter(opts) {
    var log = opts.log !== false;
    var W = opts.width || 520, H = opts.height || 420;
    var small = !!opts.compact;
    var m = small ? { l: 46, r: 12, t: 30, b: 40 } : { l: 64, r: 16, t: 34, b: 50 };
    var pts = (opts.points || []).filter(function (p) { return isFinite(p.x) && isFinite(p.y) && (!log || (p.x > 0 && p.y > 0)); });
    var skipped = (opts.points || []).length - pts.length;
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'scatter', role: 'img', 'aria-label': (opts.title || 'Scatter plot') + ', ' + pts.length + ' points' });
    var title = svgEl('text', { x: m.l, y: 18, class: 'chart-title', fill: COLOR.text, 'font-size': small ? 12 : 14, 'font-weight': 700 }, opts.title || '');
    svg.appendChild(title);
    if (opts.subtitle) svg.appendChild(svgEl('text', { x: W - m.r, y: 18, 'text-anchor': 'end', fill: COLOR.muted, 'font-size': 11 }, opts.subtitle));
    if (!pts.length) { svg.appendChild(svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: COLOR.muted, 'font-size': 13 }, 'No sample points to plot')); return { svg: svg, skipped: skipped }; }

    var vals = []; pts.forEach(function (p) { vals.push(p.x, p.y); });
    var lo = opts.domain ? opts.domain[0] : Math.min.apply(null, vals), hi = opts.domain ? opts.domain[1] : Math.max.apply(null, vals);
    if (log) { lo = lo / 1.15; hi = hi * 1.15; } else { var pad = (hi - lo) * 0.05 || 1; lo = Math.max(0, lo - pad); hi = hi + pad; }
    var plotW = W - m.l - m.r, plotH = H - m.t - m.b;
    var sx = function (v) { return m.l + (log ? (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) : (v - lo) / (hi - lo)) * plotW; };
    var sy = function (v) { return m.t + plotH - (log ? (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) : (v - lo) / (hi - lo)) * plotH; };

    // gridlines and ticks (same scale on both axes)
    var ticks = log ? logTicks(lo, hi) : { major: niceLinearTicks(lo, hi, small ? 4 : 6), minor: [] };
    var g = svgEl('g', { class: 'grid' });
    ticks.minor.forEach(function (t) {
      g.appendChild(svgEl('line', { x1: sx(t), x2: sx(t), y1: m.t, y2: m.t + plotH, stroke: COLOR.grid, 'stroke-width': 1 }));
      g.appendChild(svgEl('line', { x1: m.l, x2: m.l + plotW, y1: sy(t), y2: sy(t), stroke: COLOR.grid, 'stroke-width': 1 }));
    });
    ticks.major.forEach(function (t) {
      g.appendChild(svgEl('line', { x1: sx(t), x2: sx(t), y1: m.t, y2: m.t + plotH, stroke: COLOR.grid, 'stroke-width': 1 }));
      g.appendChild(svgEl('line', { x1: m.l, x2: m.l + plotW, y1: sy(t), y2: sy(t), stroke: COLOR.grid, 'stroke-width': 1 }));
      g.appendChild(svgEl('text', { x: sx(t), y: m.t + plotH + 16, 'text-anchor': 'middle', fill: COLOR.muted, 'font-size': 10 }, compact(t)));
      g.appendChild(svgEl('text', { x: m.l - 6, y: sy(t) + 3, 'text-anchor': 'end', fill: COLOR.muted, 'font-size': 10 }, compact(t)));
    });
    svg.appendChild(g);
    svg.appendChild(svgEl('line', { x1: m.l, x2: m.l, y1: m.t, y2: m.t + plotH, stroke: COLOR.band, 'stroke-width': 1 }));
    svg.appendChild(svgEl('line', { x1: m.l, x2: m.l + plotW, y1: m.t + plotH, y2: m.t + plotH, stroke: COLOR.band, 'stroke-width': 1 }));

    // ±20 % bands and the 45° line
    function clipLine(f) {
      // polyline of y = f(x) across the domain, clipped to the plot box
      var xs = [], N = 40;
      for (var i = 0; i <= N; i++) {
        var x = log ? lo * Math.pow(hi / lo, i / N) : lo + (hi - lo) * i / N;
        var y = f(x);
        if (y >= lo && y <= hi) xs.push(sx(x).toFixed(1) + ',' + sy(y).toFixed(1));
      }
      return xs.join(' ');
    }
    svg.appendChild(svgEl('polyline', { points: clipLine(function (x) { return x * 1.2; }), fill: 'none', stroke: COLOR.band, 'stroke-width': 1 }));
    svg.appendChild(svgEl('polyline', { points: clipLine(function (x) { return x / 1.2; }), fill: 'none', stroke: COLOR.band, 'stroke-width': 1 }));
    svg.appendChild(svgEl('polyline', { points: clipLine(function (x) { return x; }), fill: 'none', stroke: COLOR.ref, 'stroke-width': 1.5 }));
    if (!small) {
      svg.appendChild(svgEl('text', { x: m.l + plotW - 4, y: sy(Math.min(hi / 1.25, hi)) - 4, 'text-anchor': 'end', fill: COLOR.muted, 'font-size': 10 }, 'formula = valuer'));
      svg.appendChild(svgEl('text', { x: m.l + plotW - 4, y: sy(Math.min(hi / 1.5, hi)) + 12, 'text-anchor': 'end', fill: COLOR.muted, 'font-size': 10 }, '±20 % band'));
    }

    // axis labels
    svg.appendChild(svgEl('text', { x: m.l + plotW / 2, y: H - 8, 'text-anchor': 'middle', fill: COLOR.text, 'font-size': 11, 'font-weight': 700 }, opts.xLabel || 'Valuer'));
    var yl = svgEl('text', { x: 14, y: m.t + plotH / 2, 'text-anchor': 'middle', fill: COLOR.text, 'font-size': 11, 'font-weight': 700, transform: 'rotate(-90 14 ' + (m.t + plotH / 2) + ')' }, opts.yLabel || 'Formula');
    svg.appendChild(yl);

    // points with a large transparent hit target and a tooltip
    var dots = svgEl('g', { class: 'dots' });
    var tip = svgEl('g', { class: 'tip', visibility: 'hidden' });
    var tipRect = svgEl('rect', { rx: 4, fill: COLOR.text, opacity: 0.92 });
    var tipT1 = svgEl('text', { fill: '#fff', 'font-size': 11, 'font-weight': 700 });
    var tipT2 = svgEl('text', { fill: '#fff', 'font-size': 11 });
    tip.appendChild(tipRect); tip.appendChild(tipT1); tip.appendChild(tipT2);
    var r = small ? 3.5 : 4.5;
    pts.forEach(function (p) {
      var cx = sx(p.x), cy = sy(p.y);
      var dot = svgEl('circle', { cx: cx, cy: cy, r: r, fill: COLOR.dot, stroke: COLOR.ring, 'stroke-width': 2, class: 'dot' });
      var hit = svgEl('circle', { cx: cx, cy: cy, r: 12, fill: 'transparent', class: 'hit' });
      hit.setAttribute('tabindex', '0');
      function show() {
        dot.setAttribute('fill', COLOR.hover); dot.setAttribute('r', r + 2);
        var l1 = p.label || '';
        var ratio = p.x > 0 ? (p.y / p.x) : NaN;
        var l2 = 'valuer ' + compact(p.x) + ' · formula ' + compact(p.y) + (isFinite(ratio) ? ' · ratio ' + ratio.toFixed(2) : '');
        tipT1.textContent = l1; tipT2.textContent = l2;
        var w = Math.max(l1.length, l2.length) * 6.3 + 16, h = 34;
        var tx = cx + 12, ty = cy - h - 6;
        if (tx + w > W - m.r) tx = cx - w - 12;
        if (ty < m.t) ty = cy + 10;
        tipRect.setAttribute('x', tx); tipRect.setAttribute('y', ty); tipRect.setAttribute('width', w); tipRect.setAttribute('height', h);
        tipT1.setAttribute('x', tx + 8); tipT1.setAttribute('y', ty + 14);
        tipT2.setAttribute('x', tx + 8); tipT2.setAttribute('y', ty + 28);
        tip.setAttribute('visibility', 'visible');
      }
      function hide() { dot.setAttribute('fill', COLOR.dot); dot.setAttribute('r', r); tip.setAttribute('visibility', 'hidden'); }
      hit.addEventListener('pointerenter', show); hit.addEventListener('pointerleave', hide);
      hit.addEventListener('focus', show); hit.addEventListener('blur', hide);
      dots.appendChild(dot); dots.appendChild(hit);
    });
    svg.appendChild(dots);
    svg.appendChild(tip);
    return { svg: svg, skipped: skipped };
  }

  /* Points for a fitted model: { x: valuer building value, y: predicted, label } */
  function fitPoints(fit, labelFor) {
    if (!fit || !fit.ok || !fit.sample) return [];
    return fit.sample.map(function (s) { return { x: s.actual, y: s.predicted, label: labelFor ? labelFor(s.id) : s.id }; });
  }

  /* Common domain across several point sets */
  function sharedDomain(pointSets, log) {
    var vals = [];
    pointSets.forEach(function (ps) { ps.forEach(function (p) { if (isFinite(p.x) && isFinite(p.y) && (!log || (p.x > 0 && p.y > 0))) vals.push(p.x, p.y); }); });
    if (!vals.length) return null;
    return [Math.min.apply(null, vals), Math.max.apply(null, vals)];
  }

  root.Charts = { scatter: scatter, fitPoints: fitPoints, sharedDomain: sharedDomain, compact: compact };
}(typeof self !== 'undefined' ? self : this));
