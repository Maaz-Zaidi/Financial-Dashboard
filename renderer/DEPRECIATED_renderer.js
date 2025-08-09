import { createBalanceChart } from './chart.js';

const tableContainer = document.getElementById('table-container');
const tbody = document.querySelector('#tx-table tbody');
const searchInput = document.getElementById('search');
const rangeButtons = document.querySelectorAll('.range-btn');

let currentRange = 'all';
let initial_balance = 53589.79;

let allData = [];
let page = 0;
const pageSize = 50;

const balanceChart = createBalanceChart('balance-chart');

let scrollTO = null;
window.addEventListener('scroll', () => {
  balanceChart.setInteractionEnabled(false);
  clearTimeout(scrollTO);
  scrollTO = setTimeout(() => balanceChart.setInteractionEnabled(true), 120);
}, { passive: true });


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

function updateChart() {
  const filtered = getFilteredTx();
  balanceChart.update(filtered, initial_balance, currentRange);
  rangeButtons.forEach(btn =>
    btn.classList.toggle('active', btn.dataset.range === currentRange)
  );
}

function renderPage(reset = false) {
  if (reset) {
    tbody.innerHTML = '';
    page = 0;
  }
  const filtered = getFilteredTx();
  const start = page * pageSize;

  filtered.slice(start, start + pageSize).forEach(tx => {
    const amt = sanitizeAmount(tx.Amount);        
    const type = String(tx.Type || '').toLowerCase();
    const sign = type === 'income' ? '+' : '-';
    const cls = type === 'income' ? 'income' : 'expense';
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
