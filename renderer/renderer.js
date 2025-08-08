import { createBalanceChart } from './chart.js';

const tableContainer = document.getElementById('table-container');
const tbody = document.querySelector('#tx-table tbody');
const searchInput = document.getElementById('search');
const rangeButtons = document.querySelectorAll('.range-btn');
const chartEl = document.getElementById('balance-chart');
let currentRange = 'all';


let initial_balance = 53589.79;
let allData = [];
let page = 0;
const pageSize = 50;

const balanceChart = createBalanceChart('balance-chart');

async function loadData() {
  try {
    const csvText = await window.api.invoke('load-csv');
    const parsed = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: h => (h || '').trim(),
      transform: v => (typeof v === 'string' ? v.trim() : v)
    });

    allData = parsed.data.filter(r => r && r.Date && !isNaN(Date.parse(r.Date)));
    console.log('Loaded rows:', allData.length);

    updateChart();    
    renderPage(true);  
  } catch (err) {
    console.error('Failed loading CSV:', err);
  }
}


function getFilteredTx() {
  const q = searchInput.value.trim().toLowerCase();
  let rows = allData.filter(r => r && r.Date && !isNaN(Date.parse(r.Date)));
  if (q) {
    rows = rows.filter(tx =>
      ['Date','Name','Amount','Category','Type','Tag','Source','ID']
        .some(k => String(tx[k] ?? '').toLowerCase().includes(q))
    );
  }
  rows.sort((a, b) => new Date(b.Date) - new Date(a.Date));
  return rows;
}


function sanitizeAmount(val) {
  const num = Number(String(val ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(num) ? num : 0;
}

function buildSeries(transactions, initial = initial_balance) {
  const sorted = transactions
    .filter(t => t && t.Date && !isNaN(Date.parse(t.Date)))
    .slice()
    .sort((a, b) => new Date(a.Date) - new Date(b.Date));

  let bal = initial;
  const x = [];
  const y = [];
  for (const tx of sorted) {
    const amt = sanitizeAmount(tx.Amount);
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
  let min = Math.min(...series.y), max = Math.max(...series.y);
  if (min === max) {
    const pad = Math.max(1, Math.abs(max) * 0.05);
    return [min - pad, max + pad];
  }
  const pad = (max - min) * 0.08;
  return [min - pad, max + pad];
}

function drawChart(series, rangeKey) {
  const sliced = sliceByRange(series, rangeKey);
  if (!sliced.x.length) {
    if (chartEl) window.Plotly.purge(chartEl);
    return;
  }
  const yrange = calcYRange(sliced);

  const trace = {
    x: xi,
    y: yi,
    mode: 'lines',
    name: '',            
    showlegend: false,     
    line: { color: '#4caf50', width: 2 },
    fill: 'tozeroy',
    fillcolor: 'rgba(76,175,80,0.2)',
    hovertemplate: '%{x|%Y-%m-%d} · $%{y:.2f}<extra></extra>'
  };


  const layout = {
    margin: { l: 40, r: 20, t: 20, b: 40 },
    xaxis: {
      showgrid: false,
      rangeslider: { visible: false },
      hoverformat: '%Y-%m-%d'   
    },
    yaxis: { showgrid: true },
    showlegend: false
  };


  const config = {
    responsive: true,
    scrollZoom: true,     
    displayModeBar: false 
  };

  window.Plotly.react(chartEl, [trace], layout, config);
}

function updateChart() {
  const filtered = getFilteredTx();
  balanceChart.update(filtered, initial_balance, currentRange);
  rangeButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.range === currentRange));
}



function renderPage(reset = false) {
  if (reset) {
    tbody.innerHTML = '';
    page = 0;
  }
  const filtered = getFilteredTx();
  const start = page * pageSize;
  filtered.slice(start, start + pageSize).forEach(tx => {
    const tr = document.createElement('tr');
    const amt = parseFloat(tx.Amount) || 0;
    const type = String(tx.Type || '').toLowerCase();
    const sign = type === 'income' ? '+' : '-';
    const cls = type === 'income' ? 'income' : 'expense';
    tr.innerHTML = `
      <td>${tx.Date}</td>
      <td>${tx.Name}</td>
      <td class="amount ${cls}">${sign}$${Math.abs(amt).toFixed(2)}</td>
      <td>${tx.Category}</td>
    `;
    tbody.appendChild(tr);
  });
  page++;
}

searchInput.addEventListener('input', () => {
  renderPage(true);
  updateChart();
});

window.addEventListener('scroll', () => {
  const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 10;
  if (nearBottom) renderPage();
});


rangeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    currentRange = btn.dataset.range; 
    updateChart();                    
  });
});


loadData();
