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
          <div class="kpi-head"><div class="kpi-title">Total Expense</div></div>
          <div class="kpi-body"><div id="donut-total" class="donut"></div></div>
          <div class="kpi-meta" id="donut-total-meta"></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-head"><div class="kpi-title">Top Category Expense</div></div>
          <div class="kpi-body"><div id="donut-cat" class="donut"></div></div>
          <div class="kpi-meta" id="donut-cat-meta"></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-head"><div class="kpi-title">Top Item Expense(s)</div></div>
          <div class="kpi-body"><div id="donut-item" class="donut"></div></div>
          <div class="kpi-meta" id="donut-item-meta"></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-head"><div class="kpi-title">Average Transaction</div></div>
          <div class="kpi-body"><div id="donut-avg" class="donut"></div></div>
          <div class="kpi-meta" id="donut-avg-meta"></div>
        </div>
      </div>

      <div class="analysis-card" id="assoc">
        <div class="analysis-head">
          <div class="analysis-title">Association Analysis <span class="beta">beta</span></div>

          <div class="analysis-controls">
            <div class="association-category-group" id="assocMode">
              <button class="association-category-btn active" data-mode="cat">Categories</button>
              <button class="association-category-btn" data-mode="item">Items</button>
              <button class="association-category-btn" data-mode="dow">Day + Category</button>
            </div>

            <div class="knobs">
              <label class="knob">
                <span>Min support</span>
                <input id="minSupport" type="range" min="0.01" max="0.20" step="0.01" value="0.05">
                <b id="minSupportVal">5%</b>
              </label>
              <label class="knob">
                <span>Min confidence</span>
                <input id="minConf" type="range" min="0.10" max="0.90" step="0.05" value="0.30">
                <b id="minConfVal">30%</b>
              </label>
            </div>
          </div>
        </div>

        <div class="assoc-body">
          <div class="assoc-lead">
            <div class="assoc-art"> </div>
            <div class="assoc-summary" id="assocSummary">We'll surface pairs that commonly occur together and rules with high lift to help spot budgeting bundles.</div>
          </div>

          <div class="assoc-chips" id="coocc"></div>

          <div class="rule-wrap">
            <table class="rule-table" id="rules">
              <thead>
                <tr><th style="width:55%">Rule</th><th>Support</th><th>Confidence</th><th>Lift</th></tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </div>

    </div>
  `;

  if (!document.getElementById('reports-loader-styles')) {
    const css = document.createElement('style');
    css.id = 'reports-loader-styles';
    css.textContent = `
      .page{ position: relative; } /* make overlay anchor safely */

      .page-loader{
        position: absolute;
        inset: 0;
        display: none;
        place-items: center;
        z-index: 20;
        /* subtle glass backdrop */
        background: color-mix(in oklab, var(--bg) 85%, transparent);
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(2px);
        transition: opacity .18s ease;
      }
      .page-loader.show{ display: grid; opacity: 1; }

      .dots{ display: inline-flex; gap: 10px; align-items: center; }
      .dots span{
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--muted);
        animation: reports-bounce 1.1s infinite ease-in-out;
        opacity: .75;
      }
      .dots span:nth-child(2){ animation-delay: .12s; }
      .dots span:nth-child(3){ animation-delay: .24s; }

      @keyframes reports-bounce{
        0%   { transform: translateY(0);   opacity: .55; }
        35%  { transform: translateY(-6px); opacity: 1; }
        70%  { transform: translateY(0);   opacity: .65; }
        100% { transform: translateY(0);   opacity: .55; }
      }
    `;
    document.head.appendChild(css);
  }
  
  const reportsPageEl = root.querySelector('.page');
  const reportsLoader = document.createElement('div');
  reportsLoader.className = 'page-loader';
  reportsLoader.innerHTML = `<div class="dots" aria-label="Loading">
    <span></span><span></span><span></span>
  </div>`;
  reportsPageEl.appendChild(reportsLoader);

  const showReportsLoader = () => reportsLoader.classList.add('show');
  const hideReportsLoader = () => reportsLoader.classList.remove('show');

  showReportsLoader();
  const csvText = await window.api.invoke('load-csv');
  const parsed = Papa.parse(csvText, {
    header: true, skipEmptyLines: true,
    transformHeader: h => (h || '').trim(),
    transform: v => (typeof v === 'string' ? v.trim() : v)
  });
  
  const allRows = parsed.data.filter(r => r && r.Date && !isNaN(Date.parse(r.Date)));

  function applyIgnores(list, ignoresArr = (Store.state.ignores || [])) {
    const needles = ignoresArr.map(s => String(s || '').toLowerCase()).filter(Boolean);
    if (!needles.length) return list;
    return list.filter(tx => {
      const tag  = String(tx.Tag  || '').toLowerCase();
      const name = String(tx.Name || '').toLowerCase();
      return !needles.some(k => tag.includes(k) || name.includes(k));
    });
  }

  let rows = applyIgnores(allRows, Store.state.ignores);

  applyPrivacyUI(!!Store.state.blurSensitive);

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
        ? ["#2a5484", "#2f5ebc", "#4b68dd", "#6c74e5", "#968de7", "#b6a5e9", "#cab8ea"]
        : ["#F1F7FF", "#E9F1FF", "#DDEAFF", "#CDE0FF", "#BAD3FF", "#A5C4FF", "#8FB2FF"],
      pallete_dual: dark 
        ? ["#8b0000", "#013220"]
        : ["#ee2400", "#88E788"]
    };
  }

  function draw() {
    const data = getSelectionRows();
    chart.update(data, Store.state.initialBalance, 'all', Store.state.theme);
    drawKPIs(data);
    drawAssociations(data);
  }

  function drawKPIs(data) {
    const { text, muted, bg, line, palette, pallete_dual } = tokens();

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
      [pallete_dual[0], pallete_dual[1]],
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
    const catColors = catLabels.map((_, i) => palette[Math.min(i, palette.length - 1)]);
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
    const otherMetaTotal = top3.slice(1).reduce((s,[_k,v])=>s+v,0) + rest; 

    document.getElementById('donut-item-meta').innerHTML = `
      <div class="stat-row"><span>${cap(topItemName)}</span><b>${fmtMoney(topItemVal)}</b></div>
      ${itemSorted.length > 1
        ? `<div class="stat-row"><span>Other</span><b>${fmtMoney(otherMetaTotal)}</b></div>`
        : '' }
    `;


    const avgE = expN ? (exp/expN) : 0;
    const avgI = incN ? (inc/incN) : 0;
    donut('donut-avg',
      [avgE, avgI].every(v=>v===0) ? [1,1] : [avgE, avgI],
      ['Avg Expense','Avg Income'],
      [pallete_dual[0], pallete_dual[1]],
      { title: 'Average', value: fmtMoney(avgE) },
      { bg, text, grid: line }
    );
    document.getElementById('donut-avg-meta').innerHTML = `
      <div class="stat-row"><span>Avg Expense</span><b>${fmtMoney(avgE)}</b></div>
      <div class="stat-row"><span>Avg Income</span><b>${fmtMoney(avgI)}</b></div>
    `;
  }

  function wireThemedRanges(scope = document){
    scope.querySelectorAll('input[type="range"]').forEach(r => {
      const set = () => {
        const min = +r.min || 0, max = +r.max || 100, val = +r.value || 0;
        const pct = ((val - min) / (max - min)) * 100;
        r.style.setProperty('--percent', pct + '%');
      };
      r.addEventListener('input', set);
      set(); 
    });
  }

  function normalizeItem(r){
    const t = (r.Tag || '').trim();
    const n = (r.Name || '').trim();
    return t || n || '(Unknown)';
  }
  function dayOfWeekKey(dateStr){
    const d = new Date(dateStr);
    return d.toLocaleString(undefined, { weekday: 'short' });
  }

  function buildBaskets(data, mode='cat'){
    const byDay = new Map(); 
    for (const r of data){
      if (String(r.Type||'').toLowerCase() !== 'expense') continue;

      const d = String(r.Date).slice(0,10);
      if (!byDay.has(d)) byDay.set(d, new Set());

      if (mode === 'cat'){
        const cat = r.Category || 'Uncategorized';
        byDay.get(d).add(`C:${cat}`);
      } else if (mode === 'item'){
        byDay.get(d).add(`I:${normalizeItem(r)}`);
      } else if (mode === 'dow'){
        const key = `${dayOfWeekKey(r.Date)} + ${(r.Category || 'Uncategorized')}`;
        byDay.get(d).add(key);
      }
    }

    return [...byDay.values()].map(set => [...set]);
  }

  function apriori(baskets, minSupport=0.05, maxK=3){
    const N = baskets.length || 1;
    const support = new Map(); 
    const count1 = new Map();

    for (const b of baskets){
      for (const x of new Set(b)){
        count1.set(x, (count1.get(x)||0) + 1);
      }
    }
    let L = [...count1.entries()]
      .filter(([_,c]) => c/N >= minSupport)
      .map(([x,c]) => ([ [x], c/N ]));

    for (const [items,s] of L){
      support.set(items.slice().sort().join('|'), s);
    }

    for (let k=2; k<=maxK; k++){
      if (L.length === 0) break;

      const candidates = new Map(); 
      const prevItems = L.map(([items]) => items);
      for (let i=0; i<prevItems.length; i++){
        for (let j=i+1; j<prevItems.length; j++){
          const union = new Set([...prevItems[i], ...prevItems[j]]);
          if (union.size !== k) continue;
          const key = [...union].sort().join('|');
          candidates.set(key, 0);
        }
      }

      for (const b of baskets){
        const setB = new Set(b);
        for (const key of candidates.keys()){
          const items = key.split('|');
          let ok = true;
          for (const x of items) if (!setB.has(x)) { ok=false; break; }
          if (ok) candidates.set(key, candidates.get(key)+1);
        }
      }

      L = [];
      for (const [key,c] of candidates){
        const s = c/N;
        if (s >= minSupport){
          support.set(key, s);
          L.push([key.split('|'), s]);
        }
      }
    }
    return { support, N };
  }

  function rulesFromSupport(supportMap){
    const entries = [...supportMap.entries()];
    const supp = (arr) => supportMap.get(arr.slice().sort().join('|')) || 0;

    const rules = [];
    for (const [key, supAB] of entries){
      const items = key.split('|');
      if (items.length < 2) continue;

      for (let i=0; i<items.length; i++){
        const A = items.filter((_,idx)=> idx!==i);
        const B = [items[i]];
        const supA = supp(A);
        const supB = supp(B);
        if (!supA || !supB) continue;

        const conf = supAB / supA;
        const lift = conf / supB;
        rules.push({
          A, B,
          support: supAB,
          confidence: conf,
          lift
        });
      }
    }
    return rules.sort((a,b)=> b.lift - a.lift || b.confidence - a.confidence);
  }

  function renderCooccurrences(supportMap, container, top=12){
    const pairs = [...supportMap.entries()]
      .map(([k,s]) => ({ items: k.split('|'), s }))
      .filter(d => d.items.length >= 2)
      .sort((a,b)=> b.s - a.s)
      .slice(0, top);

    container.innerHTML = pairs.map(p => `
      <div class="chip">
        <span class="label">${p.items.map(x=>x.replace(/^C:|^I:/,'')).join(' + ')}</span>
        <span class="pct">${(p.s*100).toFixed(1)}%</span>
      </div>
    `).join('') || `<div class="empty">Not enough co-occurrences yet.</div>`;
  }

  function renderRules(rules, tableBody, minConf=0.3){
    const rows = rules
      .filter(r => r.confidence >= minConf)
      .slice(0, 20)
      .map(r => `
        <tr>
          <td><b>${r.A.map(x=>x.replace(/^C:|^I:/,'')).join(' + ')}</b>
              <span class="arrow">→</span>
              ${r.B.map(x=>x.replace(/^C:|^I:/,'')).join(' + ')}</td>
          <td>${(r.support*100).toFixed(1)}%</td>
          <td>${(r.confidence*100).toFixed(1)}%</td>
          <td>${r.lift.toFixed(2)}</td>
        </tr>
      `).join('');

    tableBody.innerHTML = rows || `
      <tr><td colspan="4" class="empty">No strong rules at this threshold.</td></tr>
    `;
  }

  function drawAssociations(data){
    const modeBtns = document.querySelectorAll('#assocMode .association-category-btn');   
    const coocc    = document.getElementById('coocc');
    const rulesTbd = document.querySelector('#rules tbody');
    const supEl    = document.getElementById('minSupport');
    const supVal   = document.getElementById('minSupportVal');
    const confEl   = document.getElementById('minConf');
    const confVal  = document.getElementById('minConfVal');
    

    let mode = document.querySelector('#assocMode .association-category-btn.active')?.dataset.mode || 'cat';
    let minSupport = Number(supEl.value);
    let minConf    = Number(confEl.value);

    function recompute(){
      supVal.textContent  = `${Math.round(minSupport*100)}%`;
      confVal.textContent = `${Math.round(minConf*100)}%`;

      const baskets = buildBaskets(data, mode);
      const { support } = apriori(baskets, minSupport, 3);
      renderCooccurrences(support, coocc);
      const rules = rulesFromSupport(support);
      renderRules(rules, rulesTbd, minConf);
    }

    if (!drawAssociations._bound){
      modeBtns.forEach(b => b.addEventListener('click', () => {
        modeBtns.forEach(bb => bb.classList.toggle('active', bb===b));     
        mode = b.dataset.mode;
        recompute();
      }));
      supEl.addEventListener('input', () => { minSupport = Number(supEl.value); recompute(); });
      confEl.addEventListener('input', () => { minConf = Number(confEl.value); recompute(); });
      drawAssociations._bound = true;
    }

    recompute();

    wireThemedRanges(document.getElementById('assoc'));

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
      hoverinfo: 'skip',               
      marker: { colors, line: { width: 0 } }
    }];

    const layout = {
      margin: { l: 8, r: 8, t: 8, b: 8 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      showlegend: false,
      hoverlabel: { bgcolor: theme.bg } 
    };
    const config = { displayModeBar: false, responsive: true };

    window.Plotly.react(el, data, layout, config);

    mountDonutCenter(el, {
      title: center?.title ?? '',
      value: center?.value ?? '',
      hole
    });

    attachPieTooltip(el);
  }

  function attachPieTooltip(plotDiv) {
    if (plotDiv._pieTipBound) return;
    plotDiv._pieTipBound = true;

    plotDiv.style.position = plotDiv.style.position || 'relative';

    let tip = plotDiv.querySelector(':scope > .pie-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'pie-tip';
      tip.innerHTML = `<div class="pie-tip-label"></div><div class="pie-tip-val"></div>`;
      plotDiv.appendChild(tip);
    }

    const $label = tip.querySelector('.pie-tip-label');
    const $val   = tip.querySelector('.pie-tip-val');

    function esc(s){ return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

    plotDiv.on('plotly_hover', (ev) => {
      const p = ev?.points?.[0];
      if (!p || p.data?.type !== 'pie') return;

      const lbl = esc(p.label);
      const valueNum = Number(p.value) || 0;
      const vals = Array.isArray(p.data?.values) ? p.data.values : [];
      const total = vals.reduce((s, v) => s + (Number(v) || 0), 0);
      const pctNum = total ? (valueNum / total) * 100 : 0;

      $label.textContent = lbl;
      $val.textContent   = `${pctNum.toFixed(1)}%  ·  $${valueNum.toFixed(2)}`;

      tip.style.opacity = '1';

      const r = plotDiv.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const x = ev.event.clientX;
      const y = ev.event.clientY;

      tip.style.left = '0px';
      tip.style.top  = '0px';
      tip.style.transform = 'none';
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;

      const toRight = x >= cx;
      let left = (x - r.left) + (toRight ? 12 : -12 - tw);
      let top  = (y - r.top)  - th / 2;

      left = Math.max(4, Math.min(left, r.width - tw - 4));
      top  = Math.max(4, Math.min(top,  r.height - th - 4));

      tip.style.left = left + 'px';
      tip.style.top  = top  + 'px';
    });

    plotDiv.on('plotly_unhover', () => {
      tip.style.opacity = '0';
    });
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
  hideReportsLoader();

  function applyPrivacyUI(blurOn) {
    root.querySelectorAll('.kpi-card').forEach(card => {
      card.classList.toggle('blur-contents', blurOn);
    });
    
    root.querySelectorAll('.donut-center, .kpi-meta').forEach(n => {
      n.style.filter = blurOn ? 'blur(6px)' : '';
    });

    root.querySelectorAll('.ms-track').forEach(n => {
      n.style.filter = blurOn ? 'blur(3px)' : '';
      n.style.opacity = blurOn ? '0.6' : '';
    });

    const assoc = root.querySelector('#assoc');
    if (assoc) {
      assoc.style.filter = blurOn ? 'blur(6px)' : '';
      assoc.style.pointerEvents = blurOn ? 'none' : '';
      assoc.style.opacity = blurOn ? '0.6' : '';

    }
  }

  const unsub = Store.subscribe((s) => {
    rows.length = 0;
    rows.push(...applyIgnores(allRows, s.ignores));

    const msItems = ['All', ...Array.from(new Set(rows.map(r => ym(r.Date)))).sort().reverse()];
    track.innerHTML = msItems.map((lab, i) =>
      `<div class="ms-item${i===0 ? ' active' : ''}" role="option" tabindex="0"
            data-ym="${lab==='All' ? '' : lab}">
        <span class="ms-label">${lab==='All' ? 'All' : formatYmLabel(lab)}</span>
      </div>`
    ).join('');

    requestAnimationFrame(() => {
      const active = track.querySelector('.ms-item.active') || track.querySelector('.ms-item');
      if (active) centerItem(active);
    });

    applyPrivacyUI(s.blurSensitive);
    draw();
  });


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
