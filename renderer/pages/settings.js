export async function init(root, Store) {
  root.innerHTML = `
    <div class="page">
      <!--<h2 style="margin:16px 0 12px 0;">Settings</h2>-->
      <h2 style="margin:16px 0 12px 0;"></h2>
      <div class="card" style="padding:16px; display:grid; gap:16px;">
        <div style="display:grid; gap:6px;">
          <label for="initBal" style="color:var(--muted); font-size:13px;">Initial Balance</label>
          <div class="searchbar" style="padding:8px 10px;">
            <span style="opacity:.75">$</span>
            <input id="initBal" class="search-input" type="number" step="0.01" />
            <button id="saveBal" class="search-btn">Save</button>
          </div>
        </div>

        <div style="display:grid; gap:6px;">
          <label style="color:var(--muted); font-size:13px;">Theme</label>
          <div style="display:flex; gap:8px;">
            <button id="toDark"  class="search-btn">Dark</button>
            <button id="toLight" class="search-btn">Light</button>
          </div>
        </div>

        <div id="status" style="color:var(--muted); font-size:12px;"></div>
      </div>
    </div>
  `;

  const $ = sel => root.querySelector(sel);
  $('#initBal').value = Store.state.initialBalance;

  $('#saveBal').addEventListener('click', () => {
    Store.setInitialBalance($('#initBal').value);
    flash('Initial balance updated.');
  });
  $('#toDark').addEventListener('click', () => { Store.setTheme('dark'); flash('Theme set to Dark.'); });
  $('#toLight').addEventListener('click', () => { Store.setTheme('light'); flash('Theme set to Light.'); });

  function flash(msg) {
    const s = $('#status');
    s.textContent = msg;
    s.style.opacity = '1';
    setTimeout(()=> s.style.opacity='0.65', 1500);
  }

  return { destroy(){} };
}
