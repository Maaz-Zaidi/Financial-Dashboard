// renderer/pages/reports.js
import { createBalanceChart } from '../chart.js';

export async function init(root, Store) {
  root.innerHTML = `
    <div class="page">
      <div class="chart-toolbar">
        <div class="range-group" id="rg">
          <button class="range-btn active" data-range="all">All time</button>
          <button class="range-btn" data-range="6m">Past 6 Months</button>
          <button class="range-btn" data-range="1m">Recent Month</button>
        </div>
      </div>

      <div id="balance-chart"></div>

      <!-- Month scroller -->
      <div class="month-scroller" id="ms">
        <div class="ms-track" id="msTrack"></div>
        <div class="ms-center-indicator"></div>
      </div>

      <!-- KPI donuts -->
      <div class="kpi-row kpi-4">
        <div class="kpi-card">
          <div class="kpi-title">Total Expense</div>
          <div id="donut-total" class="donut"></div>
          <div class="kpi-meta" id="donut-total-meta"></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-title">Top Category Expense</div>
          <div id="donut-cat" class="donut"></div>
          <div class="kpi-meta" id="donut-cat-meta"></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-title">Top Item Expense</div>
          <div id="donut-item" class="donut"></div>
          <div class="kpi-meta" id="donut-item-meta"></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-title">Average Transaction Size</div>
          <div id="donut-avg" class="donut"></div>
          <div class="kpi-meta" id="donut-avg-meta"></div>
        </div>
      </div>

      <div class="card" style="padding:16px; margin-top:12px; color:var(--muted);">
        <!-- room for more analysis later -->
      </div>
    </div>
  `;

  const csvText = await window.api.invoke('load-csv');
  const parsed = Papa.parse(csvText, {
    header: true, skipEmptyLines: true,
    transformHeader: h => (h || '').trim(),
    transform: v => (typeof v === 'string' ? v.trim() : v)
  });
  const rows = parsed.data.filter(r => r && r.Date && !isNaN(Date.parse(r.Date)));

  const fmtMoney = (n) => '$' + (Number(n)||0).toFixed(2);
  const sanitizeAmount = (v) => {
    const num = Number(String(v ?? '').replace(/[^0-9.-]/g,'')); 
    return Number.isFinite(num) ? num : 0;
  };
  const ym = (d) => String(d).slice(0,7); 
  const cap = (s, n=22) => (s && s.length > n ? s.slice(0,n-1) + '…' : (s || '—'));

  function subsetByRange(data, rangeKey) {
    if (!data.length) return [];
    const sorted = data.slice().sort((a,b)=> new Date(a.Date)-new Date(b.Date));
    const last = new Date(sorted[sorted.length-1].Date);
    let start;
    if (rangeKey === '1m') { start = new Date(last); start.setMonth(start.getMonth()-1); }
    else if (rangeKey === '6m') { start = new Date(last); start.setMonth(start.getMonth()-6); }
    else return sorted; 
    return sorted.filter(r => {
      const d = new Date(r.Date);
      return d >= start && d <= last;
    });
  }

  const monthsDesc = Array.from(new Set(rows.map(r => ym(r.Date)))).sort().reverse();

  const rangeGroup = root.querySelector('#rg');
  const rangeBtns  = root.querySelectorAll('.range-btn');
  const scroller   = root.querySelector('#ms');
  const track      = root.querySelector('#msTrack');

  let range = 'all';          
  let selectedMonth = null;     
  const chart = createBalanceChart('balance-chart');

  const msItems = ['All', ...monthsDesc];
  track.innerHTML = msItems.map((lab, i) =>
    `<div class="ms-item${i===0 ? ' active' : ''}" role="option" tabindex="0"
          data-ym="${lab==='All' ? '' : lab}">
      <span class="ms-label">${lab==='All' ? 'All' : formatYmLabel(lab)}</span>
    </div>`
  ).join('');

  function formatYmLabel(ymStr) {
    const [y,m] = ymStr.split('-').map(Number);
    return new Date(y, m-1, 1).toLocaleString(undefined, { month:'short', year:'numeric' });
  }

  requestAnimationFrame(() => centerItem(track.querySelector('.ms-item')));

  track.addEventListener('click', (e) => {
    const btn = e.target.closest('.ms-item'); if (!btn) return;
    centerItem(btn);
    applyMsSelection(btn);
  });

  let raf = 0;
  scroller.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const btn = activeCenterItem();
      if (btn) applyMsSelection(btn, /*fromScroll*/true);
    });
  }, { passive:true });

  function centerItem(btn) {
    const r  = scroller.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const target = (br.left - r.left) - (r.width/2 - br.width/2) + scroller.scrollLeft;
    scroller.scrollTo({ left: target, behavior: 'smooth' });
  }
  function activeCenterItem() {
    const r = scroller.getBoundingClientRect();
    const cx = r.left + r.width/2;
    const items = [...track.querySelectorAll('.ms-item')];
    let best = null, bestDist = Infinity;
    for (const it of items) {
      const ir = it.getBoundingClientRect();
      const ic = ir.left + ir.width/2;
      const d  = Math.abs(ic - cx);
      if (d < bestDist) { best = it; bestDist = d; }
    }
    return best;
  }
  function applyMsSelection(btn) {
    track.querySelectorAll('.ms-item').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    selectedMonth = (btn.dataset.ym || '') || null;
    rangeGroup.classList.toggle('dim', !!selectedMonth);
    scroller.classList.toggle('dim', range !== 'all' && !selectedMonth);
    draw();
  }

  rangeBtns.forEach(b => b.addEventListener('click', () => {
    rangeBtns.forEach(bb => bb.classList.toggle('active', bb===b));
    range = b.dataset.range;
    scroller.classList.toggle('dim', range !== 'all' && !selectedMonth);
    rangeGroup.classList.toggle('dim', !!selectedMonth);
    draw();
  }));

  function getSelectionRows() {
    if (selectedMonth) return rows.filter(r => ym(r.Date) === selectedMonth);
    return subsetByRange(rows, range);
  }

  function tokens() {
    const dark = Store.state.theme === 'dark';
    return {
      text:   dark ? '#e6eaf2' : '#15171a',
      muted:  dark ? '#94a3b8' : '#6b7280',
      bg:     dark ? '#161a20' : '#f1f2f4',
      line:   dark ? '#242a37' : '#eaecef',
      palette: dark
        ? ['#66e0a3','#81b1ff','#b59dff','#f7b3a7','#fadc7a','#7adccf','#b1e39b']
        : ['#22c55e','#3b82f6','#8b5cf6','#ef4444','#f59e0b','#14b8a6','#84cc16']
    };
  }

  function draw() {
    const data = getSelectionRows();
    chart.update(data, Store.state.initialBalance, 'all', Store.state.theme);
    drawKPIs(data);
  }

  function drawKPIs(data) {
    const { text, muted, bg, line, palette } = tokens();

    let exp = 0, inc = 0, expN = 0, incN = 0;
    for (const r of data) {
      const t = String(r.Type||'').toLowerCase();
      const a = Math.abs(sanitizeAmount(r.Amount));
      if (t === 'expense') { exp += a; expN++; }
      else if (t === 'income') { inc += a; incN++; }
    }
    donut('donut-total',
      [exp, inc],
      ['Expenses', 'Income'],
      [palette[0], palette[1]],
      { title: 'Total', value: fmtMoney(exp) },
      { bg, text, grid: line }
    );
    document.getElementById('donut-total-meta').innerHTML = `
      <div class="stat-row"><span>Expenses</span><b>${fmtMoney(exp)}</b></div>
      <div class="stat-row"><span>Income</span><b>${fmtMoney(inc)}</b></div>
    `;

    const byCat = new Map();
    for (const r of data) {
      if (String(r.Type||'').toLowerCase() !== 'expense') continue;
      byCat.set(r.Category || 'Uncategorized',
        (byCat.get(r.Category || 'Uncategorized') || 0) + Math.abs(sanitizeAmount(r.Amount)));
    }
    const catSorted = [...byCat.entries()].sort((a,b)=> b[1]-a[1]);
    const catLabels = catSorted.map(([k])=>k);
    const catValues = catSorted.map(([_,v])=>v);
    const catColors = catLabels.map((_,i)=> palette[i % palette.length]);
    const topCatName = catLabels[0] || '—';
    const topCatVal  = catValues[0] || 0;
    donut('donut-cat',
      catValues.length ? catValues : [1,1],
      catLabels.length ? catLabels : ['—','—'],
      catColors,
      { title: 'Top Category', value: cap(topCatName) },
      { bg, text, grid: line }
    );
    document.getElementById('donut-cat-meta').innerHTML = `
      <div class="stat-row"><span>${cap(topCatName)}</span><b>${fmtMoney(topCatVal)}</b></div>
      <div class="stat-row"><span>Other</span><b>${fmtMoney(Math.max(0, catValues.reduce((a,b)=>a+b,0)-topCatVal))}</b></div>
    `;

    const byItem = new Map();
    for (const r of data) {
      if (String(r.Type||'').toLowerCase() !== 'expense') continue;
      const key = (r.Tag && r.Tag.trim()) || (r.Name && r.Name.trim()) || '(Unknown)';
      byItem.set(key, (byItem.get(key)||0) + Math.abs(sanitizeAmount(r.Amount)));
    }
    const itemSorted = [...byItem.entries()].sort((a,b)=> b[1]-a[1]);
    const top3 = itemSorted.slice(0,3);
    const rest = itemSorted.slice(3).reduce((s,[_k,v])=>s+v,0);
    const itemLabels = [...top3.map(([k])=>k), ...(rest>0 ? ['Other'] : [])];
    const itemValues = [...top3.map(([_,v])=>v), ...(rest>0 ? [rest] : [])];
    const itemColors = itemLabels.map((_,i)=> palette[(i+1) % palette.length]);
    const topItemName = top3[0]?.[0] || '—';
    const topItemVal  = top3[0]?.[1] || 0;
    donut('donut-item',
      itemValues.length ? itemValues : [1,1],
      itemLabels.length ? itemLabels : ['—','—'],
      itemColors,
      { title: 'Top Item', value: cap(topItemName) },
      { bg, text, grid: line }
    );
    document.getElementById('donut-item-meta').innerHTML = `
      ${top3.map(([k,v])=>`<div class="stat-row"><span>${cap(k)}</span><b>${fmtMoney(v)}</b></div>`).join('')}
      ${rest>0 ? `<div class="stat-row"><span>Other</span><b>${fmtMoney(rest)}</b></div>` : ''}
    `;

    const avgE = expN ? (exp/expN) : 0;
    const avgI = incN ? (inc/incN) : 0;
    donut('donut-avg',
      [avgE, avgI].every(v=>v===0) ? [1,1] : [avgE, avgI],
      ['Avg Expense','Avg Income'],
      [palette[0], palette[1]],
      { title: 'Average', value: fmtMoney(avgE) },
      { bg, text, grid: line }
    );
    document.getElementById('donut-avg-meta').innerHTML = `
      <div class="stat-row"><span>Avg Expense</span><b>${fmtMoney(avgE)}</b></div>
      <div class="stat-row"><span>Avg Income</span><b>${fmtMoney(avgI)}</b></div>
    `;
  }
  
  function donut(elId, values, labels, colors, center, theme, options = {}) {
    const el   = document.getElementById(elId);
    const hole = options.hole ?? 0.68;

    const data = [{
      type: 'pie',
      values: (values?.length ? values : [1,1]),
      labels: (labels?.length ? labels : ['—','—']),
      hole,
      sort: false,
      textinfo: 'none',
      textposition: 'none',
      hovertemplate: '<b>%{label}</b><br>%{percent:.1%}<extra></extra>',
      marker: { colors, line: { width: 0 } }
    }];

    const layout = {
      margin: { l: 8, r: 8, t: 8, b: 8 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      showlegend: false,
      hoverlabel: { bgcolor: theme.bg, bordercolor: theme.grid, font: { color: theme.text, size: 12 } }
    };
    const config = { displayModeBar: false, responsive: true };

    window.Plotly.react(el, data, layout, config);

    mountDonutCenter(el, { title: center?.title ?? '', value: center?.value ?? '', hole });
  }

  function mountDonutCenter(donutEl, { title, value, hole }) {
    let host = donutEl.querySelector(':scope > .donut-center');
    if (!host) {
      donutEl.style.position = 'relative';
      host = document.createElement('div');
      host.className = 'donut-center';
      host.innerHTML = `<div class="t"></div><div class="v"></div>`;
      donutEl.appendChild(host);
    }
    host.querySelector('.t').textContent = title;
    host.querySelector('.v').textContent = value;

    requestAnimationFrame(() => {
      const w = donutEl.clientWidth || 0;
      const h = donutEl.clientHeight || 0;
      const inner = Math.floor(Math.min(w, h) * (hole * 0.92)); 
      host.style.width  = inner + 'px';
      host.style.height = 'auto';
      host.style.left   = '50%';
      host.style.top    = '50%';
      host.style.transform = 'translate(-50%,-50%)';
    });
  }
  draw();
  const unsub = Store.subscribe(() => draw());

  let to=null;
  const onScroll = () => {
    chart.setInteractionEnabled(false);
    clearTimeout(to);
    to = setTimeout(()=>chart.setInteractionEnabled(true),120);
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  return {
    destroy() { window.removeEventListener('scroll', onScroll); unsub(); }
  };
}
