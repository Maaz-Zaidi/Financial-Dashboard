import { createBalanceChart } from '../chart.js';

export async function init(root, Store) {
  root.innerHTML = `
    <div class="page">
    <!--<h2 style="margin:16px 0 6px 0;">Reports</h2>-->
      <div class="chart-toolbar">
        <div class="range-group">
          <button class="range-btn active" data-range="all">All time</button>
          <button class="range-btn" data-range="6m">Past 6 Months</button>
          <button class="range-btn" data-range="1m">Recent Month</button>
        </div>
      </div>
      <div id="balance-chart"></div>
      <div class="card" style="padding:16px; margin-top:12px; color:var(--muted);">
        (stuff stuff later)
      </div>
    </div>
  `;

  const btns = root.querySelectorAll('.range-btn');
  const chart = createBalanceChart('balance-chart');

  const csvText = await window.api.invoke('load-csv');
  const parsed = Papa.parse(csvText, {
    header: true, skipEmptyLines: true,
    transformHeader: h => (h || '').trim(),
    transform: v => (typeof v === 'string' ? v.trim() : v)
  });
  const rows = parsed.data.filter(r => r && r.Date && !isNaN(Date.parse(r.Date)));

  let range = 'all';
  function draw() {
    chart.update(rows, Store.state.initialBalance, range);
  }
  btns.forEach(b => b.addEventListener('click', () => {
    range = b.dataset.range;
    btns.forEach(bb => bb.classList.toggle('active', bb===b));
    draw();
  }));

  draw();

  let to=null;
  const onScroll = () => {
    chart.setInteractionEnabled(false);
    clearTimeout(to);
    to = setTimeout(()=>chart.setInteractionEnabled(true),120);
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  const unsub = Store.subscribe(draw);
  return {
    destroy() { window.removeEventListener('scroll', onScroll); unsub(); }
  };
}
