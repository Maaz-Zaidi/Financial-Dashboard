export function createBalanceChart(elId) {
  const el = document.getElementById(elId);

  const SMOOTH = 1.15; 

  let currentRange = 'all';
  let fullSeries = { x: [], y: [] };
  let lastRange = null;
  let handlersBound = false;

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

  function calcYRange(series) {
    if (!series.y.length) return undefined;
    const min = Math.min(...series.y);
    const max = Math.max(...series.y);
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
        end = new Date(min.getTime() + span);    
    }
    return [start, end];
  }

  function bindClampHandler() {
    if (handlersBound) return;
    el.on('plotly_relayout', (ev) => {
        const r0 = ev['xaxis.range[0]'];
        const r1 = ev['xaxis.range[1]'];
        if (!r0 && !r1) return;

        const curr = lastRange || [fullSeries.x[0], fullSeries.x[fullSeries.x.length - 1]];
        let start = new Date(r0 ?? curr[0]);
        let end   = new Date(r1 ?? curr[1]);

        const [ns, ne] = clampLeftOnly(start, end);

        const changed = !lastRange ||
                        ns.getTime() !== start.getTime() ||
                        ne.getTime() !== end.getTime();

        
        if (changed) {
            lastRange = [ns, ne];
            window.Plotly.relayout(el, { 'xaxis.range': lastRange });
        } else {
            lastRange = [start, end];
        }
    });
  }

 
    function yAt(series, xms) {
        const xs = series.x.map(d => +d);
        const ys = series.y;
        let j = 0;
        while (j < xs.length - 1 && xms > xs[j + 1]) j++;
        if (j >= xs.length - 1) return ys[ys.length - 1];
        const t = (xms - xs[j]) / (xs[j + 1] - xs[j] || 1);
        return ys[j] + t * (ys[j + 1] - ys[j]);
    }

    
    function buildDottedFillTrace(series, yrange) {
        if (!series.x.length) return null;

        const xMin = +series.x[0];
        const xMax = +series.x[series.x.length - 1];
        const spanX = xMax - xMin;

       
        const DOTS_X = 140;  
        const DOTS_Y = 40;   

        const stepX = spanX / (DOTS_X - 1);
        const stepY = (yrange[1] - yrange[0]) / DOTS_Y;

        const xs = [], ys = [];
        for (let i = 0; i < DOTS_X; i++) {
            const xms = xMin + i * stepX;        
            const top = yAt(series, xms);        
            for (let y = yrange[0]; y <= top; y += stepY) {
            xs.push(new Date(xms));
            ys.push(y);
            }
        }

        return {
            x: xs,
            y: ys,
            mode: 'markers',
            type: 'scatter',
            marker: { size: 2, opacity: 0.45, color: '#66e0a3' },
            hoverinfo: 'skip',
            showlegend: false
        };
    }


  function draw(series, rangeKey = currentRange) {
    currentRange = rangeKey;
    const sliced = sliceByRange(series, rangeKey);
    if (!sliced.x.length) {
      window.Plotly.purge(el);
      return;
    }

    const yrange = calcYRange(sliced);
    const start0 = sliced.x[0];
    const end0   = sliced.x[sliced.x.length - 1];
    lastRange = [start0, end0]; 

    const traceLine = {
        x: sliced.x,
        y: sliced.y,
        type: 'scatter',
        mode: 'lines',
        line: { shape: 'spline', smoothing: SMOOTH, width: 2, color: '#66e0a3' },
        hovertemplate: '$%{y:.2f}<extra></extra>',
        showlegend: false
    };

    const dottedFill = buildDottedFillTrace({ x: sliced.x, y: sliced.y }, yrange);

    const layout = {
        margin: { l: 16, r: 16, t: 8, b: 28 },
        paper_bgcolor: '#121212',
        plot_bgcolor: '#121212',
        font: { color: '#e0e0e0' },
        dragmode: 'pan',
        hovermode: 'x unified',
        hoverlabel: { bgcolor: '#1f1f1f' },
        showlegend: false,
        xaxis: {
            type: 'date',
            autorange: false,
            range: lastRange,
            rangeslider: { visible: false },
            fixedrange: false,         
            nticks: 3,                 
            tickformat: '%b %Y',
            ticklen: 6,
            tickpadding: 10,
            showgrid: false,
            showspikes: true,
            spikemode: 'across',
            spikesnap: 'cursor',
            spikethickness: 1,
            spikecolor: '#888'
        },
        yaxis: {
            autorange: false,
            range: yrange,
            fixedrange: true,         
            showgrid: false,           
            showticklabels: false,     
            zeroline: false,
            ticklen: 0,
            tickpadding: 0
        },
        shapes: [] 
    };

    const data = dottedFill ? [traceLine, dottedFill] : [traceLine];
    const config = {
      responsive: true,
      scrollZoom: true,     
      displayModeBar: false 
    };

    window.Plotly.react(el, data, layout, config);
    function setDimOverlay(xHover) {
        window.Plotly.relayout(el, {
            shapes: [{
            type: 'rect', xref: 'x', yref: 'paper',
            x0: xHover, x1: lastRange[1], y0: 0, y1: 1,
            line: { width: 0 },
            fillcolor: 'rgba(0,0,0,0.35)'
            }]
        });
    }
    function clearDimOverlay() {
        window.Plotly.relayout(el, { shapes: [] });
    }
    if (!handlersBound) {
        el.on('plotly_hover', (ev) => {
            const xHover = ev.points?.[0]?.x;
            if (xHover) setDimOverlay(xHover);
        });
        el.on('plotly_unhover', clearDimOverlay);
    }

    bindClampHandler();
  }

  return {
    update(transactions, initial_balance = 0, rangeKey = currentRange) {
      fullSeries = computeSeries(transactions, initial_balance);
      draw(fullSeries, rangeKey);
    },
    setRange(rangeKey) { draw(fullSeries, rangeKey); }
  };
}
