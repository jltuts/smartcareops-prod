(() => {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const routeShell = ({
    '/': 'home',
    '/manual': 'manual',
    '/patient': 'patient',
    '/doctor': 'doctor',
    '/dispatcher': 'dispatcher',
    '/command-center': 'command-center',
    '/profile': 'profile',
    '/about': 'about',
    '/admin': 'admin',
  })[path] || 'home';
  document.documentElement.dataset.pageShell = routeShell;
})();
