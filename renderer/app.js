const appEl     = document.getElementById('app');
const navItems  = [...document.querySelectorAll('.nav-item')];
const underline = document.querySelector('.nav-underline');
const toTopBtn  = document.getElementById('toTop');

const LS_KEY = 'finDashStore';

const defaultState = {
  theme: 'dark',
  initialBalance: 5000,
  username: '',
  blurSensitive: false,
  ignores: [] 
};

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...defaultState, ...JSON.parse(raw) };
  } catch {}
  const s = { ...defaultState };
  const oldInit  = localStorage.getItem('initialBalance');
  const oldTheme = localStorage.getItem('theme');
  if (oldInit !== null)  s.initialBalance = Number(oldInit) || defaultState.initialBalance;
  if (oldTheme)          s.theme = oldTheme === 'light' ? 'light' : 'dark';
  return s;
}
function saveState(s) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

const Store = (() => {
  let state = loadState();
  const listeners = new Set();

  function notify() {
    saveState(state);
    listeners.forEach(fn => { try { fn(state); } catch {} });
  }

  document.documentElement.dataset.theme = state.theme;
  document.body.dataset.theme = state.theme;

  return {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    setTheme(t) {
      state = { ...state, theme: t === 'light' ? 'light' : 'dark' };
      document.documentElement.dataset.theme = state.theme;
      document.body.dataset.theme = state.theme;
      notify();
    },

    setInitialBalance(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      state = { ...state, initialBalance: n };
      notify();
    },

    setUsername(name) {
      state = { ...state, username: (name || '').trim() };
      notify();
    },

    setBlurSensitive(on) {
      state = { ...state, blurSensitive: !!on };
      notify();
    },

    setIgnores(list) {
      const arr = Array.isArray(list) ? list.map(s => String(s).trim()).filter(Boolean) : [];
      state = { ...state, ignores: arr };
      notify();
      try { window.api?.invoke?.('write-ignores', arr.join('\n')); } catch {}
    }
  };
})();

let current = null;

function setActiveNav(route) {
  navItems.forEach(b => b.classList.toggle('active', b.dataset.route === route));
  // move underline after layout ticks
  requestAnimationFrame(moveUnderline);
}

async function navigate(route) {
  setActiveNav(route);

  if (current?.destroy) { try { current.destroy(); } catch {} }
  appEl.innerHTML = '';

  if (route === 'main') {
    const mod = await import('./pages/main.js');
    current = await mod.init(appEl, Store);
  } else if (route === 'reports') {
    const mod = await import('./pages/reports.js');
    current = await mod.init(appEl, Store);
  } else if (route === 'settings') {
    const mod = await import('./pages/settings.js');
    current = await mod.init(appEl, Store);
  } else {
    const mod = await import('./pages/main.js');
    current = await mod.init(appEl, Store);
  }
}

function moveUnderline() {
  const active = document.querySelector('.nav-item.active');
  if (!active || !underline) return;
  const parent = active.parentElement;
  const rect = active.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  underline.style.width = rect.width + 'px';
  underline.style.transform = `translateX(${rect.left - parentRect.left}px)`;
}

navItems.forEach(btn =>
  btn.addEventListener('click', () => navigate(btn.dataset.route))
);

function toggleToTop(){
  const show = window.scrollY > 300;
  toTopBtn?.classList.toggle('show', show);
}
window.addEventListener('scroll', toggleToTop, { passive:true });
toTopBtn?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
toggleToTop();

window.addEventListener('load', () => {
  moveUnderline();
  navigate('main');
});
window.addEventListener('resize', moveUnderline);
