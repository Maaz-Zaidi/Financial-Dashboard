// renderer/pages/settings.js
export async function init(root, Store) {
  root.innerHTML = `
    <div class="page">
      <h2 style="margin:16px 0 12px 0;">Settings</h2>

      <div class="card" style="padding:16px; display:grid; gap:20px;">

        <!-- Username -->
        <div style="display:grid; gap:6px;">
          <label for="username" style="color:var(--muted); font-size:13px;">Username</label>
          <div class="searchbar" style="padding:8px 10px;">
            <input id="username" class="search-input" placeholder="Your name" />
            <button id="saveUser" class="search-btn">Save</button>
          </div>
        </div>

        <!-- Initial balance -->
        <div style="display:grid; gap:6px;">
          <label for="initBal" style="color:var(--muted); font-size:13px;">Initial Balance</label>
          <div class="searchbar" style="padding:8px 10px;">
            <span style="opacity:.75">$</span>
            <input id="initBal" class="search-input" type="number" step="0.01" />
            <button id="saveBal" class="search-btn">Save</button>
          </div>
        </div>

        <!-- Theme + Privacy switches -->
        <div style="display:grid; gap:12px;">
          <div style="display:flex; align-items:center; justify-content:space-between;">
            <div>
              <div style="font-weight:600;">Theme</div>
              <div style="color:var(--muted); font-size:12px;">Light / Dark</div>
            </div>
            <label class="switch">
              <input id="themeSwitch" type="checkbox" />
              <span class="slider"></span>
            </label>
          </div>

          <div style="display:flex; align-items:center; justify-content:space-between;">
            <div>
              <div style="font-weight:600;">Blur transaction details</div>
              <div style="color:var(--muted); font-size:12px;">Hide sensitive info & disable row details</div>
            </div>
            <label class="switch">
              <input id="blurSwitch" type="checkbox" />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <!-- Ignores -->
        <div style="display:grid; gap:6px;">
          <label for="ignores" style="color:var(--muted); font-size:13px;">Ignore tags / keywords</label>
          <div class="searchbar" style="padding:8px 10px; display:block;">
            <textarea id="ignores" rows="5" class="search-input"
              placeholder="One keyword or phrase per line (case-insensitive)…"></textarea>
            <div style="display:flex; justify-content:flex-end; margin-top:8px;">
              <button id="saveIgnores" class="search-btn">Save</button>
            </div>
          </div>
          <div style="color:var(--muted); font-size:12px;">
            • Matches against <b>Tag</b> and <b>Name</b>.<br/>
            • App filters these rows and they’ll be skipped during CSV generation.
          </div>
        </div>

        <div id="status" style="color:var(--muted); font-size:12px; opacity:.65;"></div>
      </div>
    </div>
  `;

  const $ = s => root.querySelector(s);

  $('#username').value  = Store.state.username || '';
  $('#initBal').value   = Store.state.initialBalance;
  $('#themeSwitch').checked = (Store.state.theme === 'dark');  
  $('#blurSwitch').checked  = !!Store.state.blurSensitive;
  $('#ignores').value  = (Store.state.ignores || []).join('\n');

  // Actions
  $('#saveUser').addEventListener('click', () => {
    Store.setUsername($('#username').value.trim());
    flash('Username saved.');
  });
  $('#saveBal').addEventListener('click', () => {
    Store.setInitialBalance($('#initBal').value);
    flash('Initial balance updated.');
  });
  $('#themeSwitch').addEventListener('change', (e) => {
    Store.setTheme(e.target.checked ? 'dark' : 'light');
    flash(`Theme set to ${e.target.checked ? 'Dark' : 'Light'}.`);
  });
  $('#blurSwitch').addEventListener('change', (e) => {
    Store.setBlurSensitive(!!e.target.checked);
    flash(`Blur sensitive details ${e.target.checked ? 'enabled' : 'disabled'}.`);
  });
  $('#saveIgnores').addEventListener('click', () => {
    const list = $('#ignores').value
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
    Store.setIgnores(list);
    flash('Ignore keywords saved.');
  });

  function flash(msg){
    const s = $('#status');
    s.textContent = msg;
    s.style.opacity = '1';
    setTimeout(() => s.style.opacity = '.65', 1500);
  }

  return { destroy(){} };
}
