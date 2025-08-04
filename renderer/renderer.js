const tableContainer = document.getElementById('table-container');
const tbody = document.querySelector('#tx-table tbody');
const searchInput = document.getElementById('search');
let allData = [];
let page = 0;
const pageSize = 50;

async function loadData() {
  try {
    const csvText = await window.api.invoke('load-csv');
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    allData = parsed.data;
    console.log('Loaded rows:', allData.length);
    renderPage(true);
  } catch (err) {
    console.error('Failed loading CSV:', err);
  }
}

function renderPage(reset = false) {
  if (reset) {
    tbody.innerHTML = '';
    page = 0;
  }

  const filtered = filteredData();
  const start = page * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  slice.forEach(tx => {
    const tr = document.createElement('tr');
    const amt = parseFloat(tx.Amount) || 0;
    const type = tx.Type.toLowerCase();
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

function filteredData() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return allData;
  return allData.filter(tx =>
    ['Date','Name','Amount','Category'].some(key =>
      String(tx[key] || '').toLowerCase().includes(q)
    )
  );
}

searchInput.addEventListener('input', () => renderPage(true));
tableContainer.addEventListener('scroll', () => {
  if (tableContainer.scrollTop + tableContainer.clientHeight >= tableContainer.scrollHeight - 10) {
    renderPage();
  }
});

// initialize
loadData();