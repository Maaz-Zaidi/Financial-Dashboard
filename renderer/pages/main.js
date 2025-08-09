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
    });
  }

  function getFilteredTx() {
    const q = searchQuery;
    let rows = allData.filter(r => r && r.Date && !isNaN(Date.parse(r.Date)));

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
      tbody.appendChild(tr);
    });

    page++;
    loading = false;

    if (page * pageSize >= filtered.length && io) {
      io.unobserve(sentinel);
    }
  }

  rangeButtons.forEach(btn => btn.addEventListener('click', () => {
    currentRange = btn.dataset.range;
    updateChart();
  }));

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
