export function createBalanceChart(elId) {
  const el = document.getElementById(elId);

  const SMOOTH = 0.9;
  const MAX_LINE_POINTS = 1200;
  const DOTS_X_PER_1000PX = 140;
  const DOTS_Y_PER_240PX  = 40;
  const DIM_DOTS_ON_HOVER = true;

  let uiRev = 0;
  let currentRange = 'all';
  let fullSeries = { x: [], y: [] };
  let lastRange = null;
  let clampBound = false;

  const state = { sliced: { x: [], y: [] }, dots: { x: [], y: [] } };
  let hoverBound = false;
  let hoverRAF = 0;
  let pendingHoverX = null;
  let lastHoverIdx = -1;

  function computeSeries(transactions, initial_balance = 0) {
    const sorted = transactions
      .filter(t => t && t.Date && !isNaN(Date.parse(t.Date)))
      .slice()
      .sort((a, b) => new Date(a.Date) - new Date(b.Date));

    let bal = initial_balance;
    const x = [], y = [];
    for (const tx of sorted) {
      const amt = Number(String(tx.Amount ?? '').replace(/[^0-9.-]/g, '')) || 0;
      const isIncome = String(tx.Type || '').toLowerCase().includes('income');
      bal += isIncome ? amt : -amt;
      x.push(new Date(tx.Date));
      y.push(bal);
    }
    return { x, y };
  }

  function sliceByRange(series, rangeKey) {
    if (!series.x.length) return { x: [], y: [] };
    const end = series.x[series.x.length - 1];
    let start;
    if (rangeKey === '1m') { start = new Date(end); start.setMonth(start.getMonth() - 1); }
    else if (rangeKey === '6m') { start = new Date(end); start.setMonth(start.getMonth() - 6); }
    else { start = series.x[0]; }

    const x = [], y = [];
    for (let i = 0; i < series.x.length; i++) {
      const dt = series.x[i];
      if (dt >= start && dt <= end) { x.push(dt); y.push(series.y[i]); }
    }
    return { x, y };
  }

  function lttb(series, threshold) {
    const xs = series.x.map(d => +d), ys = series.y;
    const n = xs.length;
    if (threshold >= n || threshold <= 3) return { x: series.x, y: series.y };

    const outX = new Array(threshold);
    const outY = new Array(threshold);
    let a = 0;
    outX[0] = new Date(xs[0]); outY[0] = ys[0];

    const bucketSize = (n - 2) / (threshold - 2);
    for (let i = 0; i < threshold - 2; i++) {
      const start = Math.floor((i + 1) * bucketSize) + 1;
      const end   = Math.floor((i + 2) * bucketSize) + 1;
      const endC  = Math.min(end, n);

      let avgX = 0, avgY = 0, count = endC - start;
      for (let j = start; j < endC; j++) { avgX += xs[j]; avgY += ys[j]; }
      if (count) { avgX /= count; avgY /= count; } else { avgX = xs[start-1]; avgY = ys[start-1]; }

      let maxArea = -1, maxIdx = -1;
      for (let j = a + 1; j < start; j++) {
        const area = Math.abs((xs[a] - avgX)*(ys[j]-ys[a]) - (xs[a]-xs[j])*(avgY-ys[a]));
        if (area > maxArea) { maxArea = area; maxIdx = j; }
      }
      if (maxIdx < 0) maxIdx = a + 1;
      outX[i+1] = new Date(xs[maxIdx]);
      outY[i+1] = ys[maxIdx];
      a = maxIdx;
    }
    outX[threshold-1] = new Date(xs[n-1]);
    outY[threshold-1] = ys[n-1];
    return { x: outX, y: outY };
  }

  function calcYRange(series) {
    if (!series.y.length) return undefined;
    const min = Math.min(...series.y), max = Math.max(...series.y);
    if (min === max) {
      const pad = Math.max(1, Math.abs(max) * 0.05);
      return [min - pad, max + pad];
    }
    const pad = (max - min) * 0.10;
    return [min - pad, max + pad];
  }

  function clampLeftOnly(start, end) {
    const min = fullSeries.x[0];
    if (start < min) {
      const span = end - start;
      start = min;
      end   = new Date(min.getTime() + span);
    }
    return [start, end];
  }

  function bindClampHandler() {
    if (clampBound) return;
    el.on('plotly_relayout', (ev) => {
      const r0 = ev['xaxis.range[0]'];
      const r1 = ev['xaxis.range[1]'];
      if (!r0 && !r1) return;
      const curr = lastRange || [fullSeries.x[0], fullSeries.x[fullSeries.x.length - 1]];
      let start = new Date(r0 ?? curr[0]);
      let end   = new Date(r1 ?? curr[1]);
      const [ns, ne] = clampLeftOnly(start, end);
      const changed = !lastRange || ns.getTime() !== start.getTime() || ne.getTime() !== end.getTime();
      if (changed) {
        lastRange = [ns, ne];
        window.Plotly.relayout(el, { 'xaxis.range': lastRange });
      } else {
        lastRange = [start, end];
      }
    });
    clampBound = true;
  }

  function binarySearchIdx(xs, xms) {
    let lo = 0, hi = xs.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = +xs[mid];
      if (v <= xms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function buildDottedPoints(series, yrange) {
    if (!series.x.length) return { x: [], y: [] };
    const width  = Math.max(300, el.clientWidth  || 1000);
    const height = Math.max(160, el.clientHeight || 240);
    const cols = Math.max(20, Math.round(DOTS_X_PER_1000PX * (width / 1000)));
    const rows = Math.max(8,  Math.round(DOTS_Y_PER_240PX  * (height / 240)));

    const xMin = +series.x[0];
    const xMax = +series.x[series.x.length - 1];
    const spanX = xMax - xMin;

    const stepX = spanX / (cols - 1);
    const stepY = (yrange[1] - yrange[0]) / rows;

    const xs = [], ys = [];
    const sx = series.x.map(d => +d), sy = series.y;
    function yInterp(ms) {
      let j = 0;
      while (j < sx.length - 1 && ms > sx[j + 1]) j++;
      if (j >= sx.length - 1) return sy[sy.length - 1];
      const t = (ms - sx[j]) / Math.max(1, sx[j + 1] - sx[j]);
      return sy[j] + t * (sy[j + 1] - sy[j]);
    }
    for (let i = 0; i < cols; i++) {
      const xms = xMin + i * stepX;
      const top = yInterp(xms);
      for (let y = yrange[0]; y <= top; y += stepY) {
        xs.push(new Date(xms));
        ys.push(y);
      }
    }
    return { x: xs, y: ys };
  }

  let lastYRange = null;

  function buildDottedFillTraceFor(series, yrange, color = '#ff6b6b', opacity = 0.45) {
    if (!series?.x?.length) return null;
    const pts = buildDottedPoints(series, yrange);
    return {
      x: pts.x,
      y: pts.y,
      type: 'scattergl',
      mode: 'markers',
      marker: { size: 2, opacity, color },
      hoverinfo: 'skip',
      name: '__forecast_dots',
      showlegend: false
    };
  }

  function clearForecastOverlay(el) {
    if (!el || !el.data) return;
    const idx = [];
    el.data.forEach((t, i) => {
      if (t && (t.name === '__forecast_line' || t.name === '__forecast_dots')) idx.push(i);
    });
    if (idx.length) window.Plotly.deleteTraces(el, idx);
  }

  function applyForecastOverlay(el, payload, theme = 'dark') {
    if (!el || !payload || !lastYRange) return;

    clearForecastOverlay(el);

    const redLine = (theme === 'dark') ? '#ff6b6b' : '#d9544f';
    const redDots = (theme === 'dark') ? 'rgba(255,107,107,0.35)' : 'rgba(217,84,79,0.35)';

    const lineTrace = {
      x: payload.line.x,
      y: payload.line.y,
      type: 'scattergl',
      mode: 'lines',
      line: { shape: 'spline', smoothing: SMOOTH, width: 2, color: redLine }, // solid
      name: '__forecast_line',
      hovertemplate: '%{x|%Y-%m-%d} · $%{y:.2f}<extra>Forecast</extra>',
      showlegend: false
    };

    const fillX = (payload.fill?.x?.length ? payload.fill.x : payload.line.x);
    const fillY = (payload.fill?.y?.length ? payload.fill.y : payload.line.y);
    const dotsTrace = buildDottedFillTraceFor(
      { x: fillX, y: fillY },
      lastYRange,
      redDots,
      0.45
    );

    const traces = [];
    if (dotsTrace) traces.push(dotsTrace);
    traces.push(lineTrace);
    window.Plotly.addTraces(el, traces);
  }

  function draw(series, rangeKey = currentRange, theme = 'dark') {
    currentRange = rangeKey;
    let sliced = sliceByRange(series, rangeKey);
    if (!sliced.x.length) { window.Plotly.purge(el); state.sliced={x:[],y:[]}; state.dots={x:[],y:[]}; return; }

    const targetPts = Math.min(MAX_LINE_POINTS, Math.max(400, Math.floor(el.clientWidth * 1.2)));
    sliced = lttb(sliced, targetPts);

    const yrange = calcYRange(sliced);
    lastYRange = yrange;

    const lineLeft = {
      x: sliced.x, y: sliced.y,
      type: 'scattergl', mode: 'lines',
      line: { shape: 'spline', smoothing: SMOOTH, width: 2, color: '#66e0a3' },
      hovertemplate: '$%{y:.2f}<extra></extra>',
      name: '', showlegend: false
    };
    const lineRight = {
      x: [], y: [],
      type: 'scattergl', mode: 'lines',
      line: { shape: 'spline', smoothing: SMOOTH, width: 2, color: 'rgba(102,224,163,0.35)' },
      hoverinfo: 'skip',
      name: '', showlegend: false
    };

    const dottedAll = buildDottedPoints({ x: sliced.x, y: sliced.y }, yrange);
    const dotsLeft = {
      x: dottedAll.x, y: dottedAll.y,
      type: 'scattergl', mode: 'markers',
      marker: { size: 2, opacity: 0.45, color: '#66e0a3' },
      hoverinfo: 'skip', name: '', showlegend: false
    };
    const dotsRight = {
      x: [], y: [],
      type: 'scattergl', mode: 'markers',
      marker: { size: 2, opacity: 0.18, color: '#66e0a3' },
      hoverinfo: 'skip', name: '', showlegend: false
    };

    const start0 = sliced.x[0], end0 = sliced.x[sliced.x.length - 1];
    const span = end0 - start0, padMs = Math.max(1, span * 0.02);
    let padStart = new Date(+start0 - padMs);
    if (padStart < series.x[0]) padStart = series.x[0];
    const padEnd = new Date(+padStart + span + 2 * padMs);
    lastRange = [padStart, padEnd];

    const bg   = (theme === 'dark') ? '#0f1115' : '#f6f7f9';
    const text = (theme === 'dark') ? '#e6eaf2' : '#15171a';
    const muted_text = (theme === 'dark') ? '#94a3b8' : '#6b7280';

    const layout = {
      uirevision: `rev-${uiRev}`,    
      margin: { l: 32, r: 32, t: 12, b: 28 },
      paper_bgcolor: bg, plot_bgcolor: bg,
      font: { color: text },
      dragmode: 'pan',
      hovermode: 'x unified',
      hoverlabel: { bgcolor: bg },
      xaxis: {
        type: 'date',
        autorange: false, range: lastRange,
        rangeslider: { visible: false },
        fixedrange: false,
        nticks: 3, tickformat: '%b %Y', ticklen: 6, tickpadding: 10, tickcolor: bg, tickfont: { color: muted_text },
        showgrid: false,
        showspikes: true, spikemode: 'across', spikesnap: 'cursor',
        spikethickness: 1, spikecolor: '#888'
      },
      yaxis: {
        autorange: false, range: yrange,
        fixedrange: true, showgrid: false, showticklabels: false, zeroline: false
      },
      showlegend: false,
      shapes: []
    };

    const config = { responsive: true, scrollZoom: true, displayModeBar: false };

    window.Plotly.react(el, [lineLeft, lineRight, dotsLeft, dotsRight], layout, config);

    window.Plotly.restyle(el, { x: [sliced.x], y: [sliced.y] }, [0]);
    window.Plotly.restyle(el, { x: [[]], y: [[]] }, [1]);

    state.sliced = sliced;
    state.dots   = dottedAll;

    if (!hoverBound) {
      el.on('plotly_hover', (ev) => {
        pendingHoverX = ev?.points?.[0]?.x || null;
        if (hoverRAF) return;
        hoverRAF = requestAnimationFrame(() => {
          hoverRAF = 0;
          const data = state.sliced;
          if (!pendingHoverX || !data.x.length) return;

          const idx = binarySearchIdx(data.x, +new Date(pendingHoverX));
          if (idx === lastHoverIdx) return;
          lastHoverIdx = idx;

          const leftX  = data.x.slice(0, idx + 1);
          const leftY  = data.y.slice(0, idx + 1);
          const rightX = data.x.slice(idx);
          const rightY = data.y.slice(idx);

          window.Plotly.restyle(el, { x: [leftX],  y: [leftY]  }, [0]);
          window.Plotly.restyle(el, { x: [rightX], y: [rightY] }, [1]);

          if (DIM_DOTS_ON_HOVER) {
            const splitMs = +new Date(pendingHoverX);
            const all = state.dots;
            const leftDX = [], leftDY = [], rightDX = [], rightDY = [];
            for (let i = 0; i < all.x.length; i++) {
              if (+all.x[i] <= splitMs) { leftDX.push(all.x[i]); leftDY.push(all.y[i]); }
              else { rightDX.push(all.x[i]); rightDY.push(all.y[i]); }
            }
            window.Plotly.restyle(el, { x: [leftDX],  y: [leftDY]  }, [2]);
            window.Plotly.restyle(el, { x: [rightDX], y: [rightDY] }, [3]);
          }
        });
      });

      el.on('plotly_unhover', () => {
        lastHoverIdx = -1;
        pendingHoverX = null;
        if (hoverRAF) { cancelAnimationFrame(hoverRAF); hoverRAF = 0; }
        const data = state.sliced, dots = state.dots;
        window.Plotly.restyle(el, { x: [data.x], y: [data.y] }, [0]);
        window.Plotly.restyle(el, { x: [[]],     y: [[]]     }, [1]);
        if (DIM_DOTS_ON_HOVER) {
          window.Plotly.restyle(el, { x: [dots.x], y: [dots.y] }, [2]);
          window.Plotly.restyle(el, { x: [[]],     y: [[]]     }, [3]);
        }
      });

      hoverBound = true;
    }

    bindClampHandler();
  }

  return {
    update(transactions, initial_balance = 0, rangeKey = currentRange, theme = 'dark') {
      fullSeries = computeSeries(transactions, initial_balance);
      uiRev++;                        
      draw(fullSeries, rangeKey, theme);
    },
    setRange(rangeKey, theme = 'dark') {
      draw(fullSeries, rangeKey, theme);
    },
    setInteractionEnabled(enabled) {
      window.Plotly.relayout(el, {
        hovermode: enabled ? 'x unified' : false,
        'xaxis.fixedrange': !enabled ? true : false,
        dragmode: enabled ? 'pan' : false
      });
    },
    setForecast(payload, theme = 'dark') { applyForecastOverlay(el, payload, theme); },
    clearForecast() { clearForecastOverlay(el); }
  };
}
