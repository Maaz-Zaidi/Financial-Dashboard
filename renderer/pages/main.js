import { createBalanceChart } from '../chart.js';

export async function init(root, Store) {
  root.innerHTML = `
    <div class="page">
      <div class="chart-toolbar">
        <div class="range-group">
          <button class="range-btn active" data-range="all">All time</button>
          <button class="range-btn" data-range="6m">Past 6 Months</button>
          <button class="range-btn" data-range="1m">Recent Month</button>
        </div>
      </div>
      <div id="balance-chart"></div>

      <div id="searchbar-root"></div>

      <div id="table-container" class="card">
        <table id="tx-table">
          <thead><tr><th>Date</th><th>Name</th><th>Amount</th><th>Category</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div id="infinite-sentinel"></div>
    </div>
  `;
  

  const searchBarApi = await import('../ui/searchbar.bundle.js').then(({ mountSearchBar }) => {
    const mountNode = root.querySelector('#searchbar-root');

    return mountSearchBar(mountNode); 
  });
  

  let searchQuery = '';
  let selectedCategories = ['All'];

  root.addEventListener('search:change', (e) => {
    searchQuery = (e.detail || '').toLowerCase();
    renderPage(true);
    updateChart();
  });

  root.addEventListener('filters:change', (e) => {
    selectedCategories = Array.isArray(e.detail) && e.detail.length ? e.detail : ['All'];
    renderPage(true);
    updateChart();
  });

  root.addEventListener('add:click', () => {
    console.log('Add clicked');
  });
  root.addEventListener('export:click', () => {
    console.log('Export clicked');
  });

  const rangeButtons = root.querySelectorAll('.range-btn');
  const tbody        = root.querySelector('#tx-table tbody');
  const tableCard    = root.querySelector('#table-container');
  const table     = root.querySelector('#tx-table');

  const loader = document.createElement('div');
  loader.className = 'loader';
  loader.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  tableCard.prepend(loader);


  let currentRange = 'all';
  let allData = [];
  let page = 0;
  const pageSize = 50;

  const chart = createBalanceChart('balance-chart');

  let scrollTO = null;
  const onScroll = () => {
    chart.setInteractionEnabled(false);
    clearTimeout(scrollTO);
    scrollTO = setTimeout(() => chart.setInteractionEnabled(true), 120);
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  const sentinel = root.querySelector('#infinite-sentinel');
  let io = null, loading = false;
  function ensureObserver() {
    if (io) return;
    io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) {
        renderPage();
      }
    }, { root: null, rootMargin: '200px 0px', threshold: 0 });
    io.observe(sentinel);
  }

  const unsub = Store.subscribe(() => {
    applyPrivacyUI();
    renderPage(true);
    updateChart();
  });

  async function loadData() {
    tableCard.classList.add('loading');   
    const csvText = await window.api.invoke('load-csv');
    const parsed = Papa.parse(csvText, {
      header: true, skipEmptyLines: true,
      transformHeader: h => (h || '').trim(),
      transform: v => (typeof v === 'string' ? v.trim() : v)
    });
    allData = parsed.data.filter(r => r && r.Date && !isNaN(Date.parse(r.Date)));
    const categories = [...new Set(allData.map(r => r.Category).filter(Boolean))].sort();
    searchBarApi.setCategories(categories);
    updateChart();
    renderPage(true);   

    requestAnimationFrame(() => {
        tableCard.classList.remove('loading'); 
        applyPrivacyUI();
    });
  }

  function applyPrivacyUI() {
    const on = !!Store.state.blurSensitive;
    table.classList.toggle('details-blurred', on);
    table.classList.toggle('details-disabled', on); 
  }

  function getFilteredTx() {
    const q = searchQuery;
    const ignores = (Store.state.ignores || []).map(s => s.toLowerCase());

    let rows = allData.filter(r => r && r.Date && !isNaN(Date.parse(r.Date)));

    if (ignores.length) {
      rows = rows.filter(tx => {
        const tag  = String(tx.Tag  || '').toLowerCase();
        const name = String(tx.Name || '').toLowerCase();
        return !ignores.some(k => tag.includes(k) || name.includes(k));
      });
    }

    if (q) {
        rows = rows.filter(tx =>
        ['Date','Name','Amount','Category','Type','Tag','Source','ID']
            .some(k => String(tx[k] ?? '').toLowerCase().includes(q))
        );
    }

    if (!(selectedCategories.length === 1 && selectedCategories[0] === 'All')) {
        const allow = new Set(selectedCategories);
        rows = rows.filter(tx => allow.has(String(tx.Category || '')));
    }

    rows.sort((a,b) => new Date(b.Date) - new Date(a.Date));
    return rows;
  }

  function sanitizeAmount(v) {
    const num = Number(String(v ?? '').replace(/[^0-9.-]/g,''));
    return Number.isFinite(num) ? num : 0;
  }

  function fmtMoney(n) {
    const num = Number(n) || 0;
    return '$' + num.toFixed(2);
  }

  function weekKey(dateStr) {
    const d = new Date(dateStr);
    const day = (d.getDay() + 6) % 7; 
    const monday = new Date(d); monday.setDate(d.getDate() - day);
    monday.setHours(0,0,0,0);
    return monday.toISOString().slice(0,10);
  }

  function getThemeColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
      bg: cs.getPropertyValue('--surface').trim() || '#161a20',
      text: cs.getPropertyValue('--text').trim() || '#e6eaf2',
      muted: cs.getPropertyValue('--muted').trim() || '#94a3b8',
      accent: cs.getPropertyValue('--accent').trim() || '#66e0a3'
    };
  }

  function updateChart() {
    const filtered = getFilteredTx();
    chart.update(filtered, Store.state.initialBalance, currentRange, Store.state.theme);
    rangeButtons.forEach(btn =>
      btn.classList.toggle('active', btn.dataset.range === currentRange)
    );
  }

  function renderPage(reset=false) {
    const filtered = getFilteredTx();
    if (reset) {
      tbody.innerHTML = '';
      page = 0;
      loading = false;
      if (io) io.observe(sentinel); 
    }
    if (loading) return;
    loading = true;

    const start = page * pageSize;
    filtered.slice(start, start + pageSize).forEach(tx => {
      const amt = sanitizeAmount(tx.Amount);
      const type = String(tx.Type || '').toLowerCase();
      const sign = type === 'income' ? '+' : '-';
      const cls  = type === 'income' ? 'income' : 'expense';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${tx.Date}</td>
        <td>${tx.Name}</td>
        <td class="amount ${cls}">${sign}$${Math.abs(amt).toFixed(2)}</td>
        <td>${tx.Category}</td>
      `;
      tr.__tx = tx;
      tbody.appendChild(tr);
    });

    page++;
    loading = false;

    if (page * pageSize >= filtered.length && io) {
      io.unobserve(sentinel);
    }
  }

  function openTxModal(tx) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';
    overlay.appendChild(modal);

    const title = `${tx.Name || '(No Name)'}`;
    const sub   = tx.Tag ? tx.Tag : (tx.Source || '');

    const basis = (tx.Tag && tx.Tag.trim()) || (tx.Name && tx.Name.trim()) || '';
    const basisLC = basis.toLowerCase();

    let totalExpense = 0, totalIncome = 0;
    let thisExpense = 0, thisIncome = 0;

    const byWeek = new Map();

    let typeE = false;

    for (const r of allData) {
      const type = String(r.Type || '').toLowerCase();
      const amt = Math.abs(sanitizeAmount(r.Amount));
      if (type === 'expense') totalExpense += amt;
      else if (type === 'income') totalIncome += amt;

      const isMatch =
        (r.Tag && String(r.Tag).toLowerCase() === basisLC) ||
        (!r.Tag && r.Name && String(r.Name).toLowerCase() === basisLC);

      if (isMatch) {
        if (type === 'expense') thisExpense += amt;
        else if (type === 'income') {thisIncome += amt; typeE = true}

        const wk = weekKey(r.Date);
        const ent = byWeek.get(wk) || { count: 0, spend: 0 };
        ent.count += 1;
        if (type === 'expense') ent.spend += amt; 
        byWeek.set(wk, ent);
      }
    }

    let fmtValue = typeE ? thisIncome : thisExpense; 
    let fmtDisplay = typeE ? 'Total earned to date' : 'Total spent to date'

    modal.innerHTML = `
      <div class="modal-header">
        <div>
          <div class="modal-title">${title}</div>
          <div class="modal-sub">${sub}</div>
        </div>
        <button class="modal-close" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <div class="merchant-visual">
          <div id="merchant-chart"></div>

          <div class="hpie-row">
            <div class="hpie-label">Expense share</div>
            <div class="hpie"><div class="hpie-fill expense" id="hp-exp"></div></div>
            <div class="hpie-pct" id="hp-exp-pct">0%</div>
          </div>

          <div class="hpie-row">
            <div class="hpie-label">Income share</div>
            <div class="hpie"><div class="hpie-fill income" id="hp-inc"></div></div>
            <div class="hpie-pct" id="hp-inc-pct">0%</div>
          </div>
        </div>

        <div class="info-panel">
          <div class="info-panel-grid">
            ${infoRow('Date', tx.Date)}
            ${infoRow('Type', tx.Type)}
            ${infoRow('Amount', String(tx.Amount))}
            ${infoRow('Category', tx.Category)}
            ${infoRow('Source', tx.Source)}
            ${infoRow('Name', tx.Name || '—')}
            ${infoRow('Tag', tx.Tag || '—')}
            ${infoRow('ID', (tx.ID == 0 ? 'N/A (404)' : tx.ID) || '—')}
            ${infoRow(fmtDisplay, fmtMoney(fmtValue))}   <!-- NEW -->
          </div>
        </div>
      </div>
    `;

    function infoRow(k,v){
      return `<div class="info-row"><div class="info-key">${k}</div><div class="info-val">${v ?? '—'}</div></div>`;
    }

    // Mount & open
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const btnClose = modal.querySelector('.modal-close');
    const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 180); document.body.style.overflow=''; };
    btnClose.addEventListener('click', close);
    overlay.addEventListener('click', (e)=>{ if(e.target === overlay) close(); });
    window.addEventListener('keydown', function esc(e){ if(e.key==='Escape') close(); }, { once: true });
    document.body.style.overflow='hidden';


    const weeks = Array.from(byWeek.keys()).sort();
    const counts = weeks.map(w => byWeek.get(w).count);
    const spends = weeks.map(w => byWeek.get(w).spend);

    const expPct = totalExpense > 0 ? Math.round((thisExpense / totalExpense) * 100) : 0;
    const incPct = totalIncome > 0 ? Math.round((thisIncome / totalIncome) * 100) : 0;

    const hpExp = modal.querySelector('#hp-exp');
    const hpInc = modal.querySelector('#hp-inc');
    const hpExpPct = modal.querySelector('#hp-exp-pct');
    const hpIncPct = modal.querySelector('#hp-inc-pct');

    hpExp.style.width = '0%';
    hpInc.style.width = '0%';
    hpExpPct.textContent = `${expPct}%`;
    hpIncPct.textContent = `${incPct}%`;

    requestAnimationFrame(() => {
      hpExp.style.width = `${expPct}%`;
      hpInc.style.width = `${incPct}%`;
    });

    const cs = getComputedStyle(document.documentElement);
    const muted = (Store.state.theme === 'dark') ? '#94a3b8' : '#6b7280';
    const accent= (Store.state.theme === 'dark') ? '#66e0a3' : '#22c55e';
    const grid  = (Store.state.theme === 'dark') ? '#242a37' : '#eaecef';

    const bg   = (Store.state.theme === 'dark') ? '#161a20' : '#f1f2f4';
    const text = (Store.state.theme === 'dark') ? '#e6eaf2' : '#15171a';

    const x = weeks.map(w => new Date(w));
    const bars = {
      x, y: spends,
      type: 'bar',
      marker: { color: 'rgba(127,127,127,0.18)' }, 
      hovertemplate: '%{x|%Y-%m-%d}<br>Spend: $%{y:.2f}<extra></extra>',
      name: 'Spend'
    };
    const line = {
      x, y: counts,
      type: 'scatter', mode: 'lines+markers',
      line: { width: 2, shape: 'spline', smoothing: 0.85, color: accent },
      marker: { size: 4, color: accent },
      yaxis: 'y2',
      hovertemplate: 'Count: %{y}<extra></extra>',
      name: 'Count'
    };
    const layout = {
      height: 240,
      margin: { l: 44, r: 44, t: 8, b: 32  },
      paper_bgcolor: bg, plot_bgcolor: bg,
      font: { color: text },
      barmode: 'overlay',
      xaxis: {
        type: 'date',
        tickformat: '%b %d, %Y', nticks: 4,
        gridcolor: grid,
        ticks: 'outside',
        ticklen: 6,
        tickpadding: 14,            
        tickcolor: bg, tickfont: { color: muted },   
        ticklabelposition: 'outside bottom',
        automargin: true,
      },
      yaxis: {
        title: 'Spend', titlefont: { size: 11, color: muted },
        gridcolor: grid
      },
      yaxis2: {
        overlaying: 'y', side: 'right',
        title: 'Count', titlefont: { size: 11, color: muted },
        showgrid: false
      },
      showlegend: false
    };
    const cfg = { displayModeBar: false, responsive: true };
    const chartDiv = modal.querySelector('#merchant-chart');
    window.Plotly.react(chartDiv, [bars, line], layout, cfg);
  }

  tbody.addEventListener('click', (e) => {
    if (Store.state.blurSensitive) return;
    const tr = e.target.closest('tr');
    if (!tr || !tr.__tx) return;
    openTxModal(tr.__tx);
  });

  rangeButtons.forEach(btn => btn.addEventListener('click', () => {
    currentRange = btn.dataset.range;
    updateChart();
  }));

  applyPrivacyUI();

  await loadData();
  ensureObserver();

  return {
    destroy() {
      window.removeEventListener('scroll', onScroll);
      if (io) { io.disconnect(); io = null; }
      unsub();
    }
  };
}
