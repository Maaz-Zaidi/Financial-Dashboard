const appEl = document.getElementById('app');
const navItems = [...document.querySelectorAll('.nav-item')];
const underline = document.querySelector('.nav-underline');

const Store = (() => {
  const state = {
    initialBalance: Number(localStorage.getItem('initialBalance') || '5000'),
    theme: localStorage.getItem('theme') || 'dark',
    listeners: new Set()
  };

  document.body.setAttribute('data-theme', state.theme);
  document.documentElement.setAttribute('data-theme', state.theme);

  function setInitialBalance(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    state.initialBalance = n;
    localStorage.setItem('initialBalance', String(n));
    emit();
  }
  function setTheme(theme) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    localStorage.setItem('theme', state.theme);
    document.body.setAttribute('data-theme', state.theme);
    document.documentElement.setAttribute('data-theme', state.theme);
    console.log('being set?')
    emit();
  }

  function subscribe(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }
  function emit() { state.listeners.forEach(fn => fn(state)); }

  return { state, setInitialBalance, setTheme, subscribe };
})();

let current = null;
async function navigate(route) {
  // update nav visuals
  navItems.forEach(b => b.classList.toggle('active', b.dataset.route === route));
  moveUnderline();

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
  if (!active) return;
  const parent = active.parentElement;
  const rect = active.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  underline.style.width = rect.width + 'px';
  underline.style.transform = `translateX(${rect.left - parentRect.left}px)`;
}

navItems.forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.route)));

window.addEventListener('load', () => {
  moveUnderline();
  navigate('main');
});

const toTopBtn = document.getElementById('toTop');
function toggleToTop(){
  const show = window.scrollY > 300;
  toTopBtn.classList.toggle('show', show);
}
window.addEventListener('scroll', toggleToTop, { passive:true });
toTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
toggleToTop(); 

window.addEventListener('resize', moveUnderline);
