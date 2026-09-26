export function renderRolePage(portal) {
  return `<section class="role-page" aria-labelledby="page-heading">
    <a class="back-link" href="/" data-link>← Back to home</a>
    <p class="eyebrow">${portal.label}</p>
    <h1 id="page-heading" tabindex="-1">${portal.title}</h1>
    <p class="role-subtitle">${portal.subtitle}</p>
    <div class="placeholder-panel"><span class="badge">Coming soon</span>
      <h2>A foundation for connected care</h2>
      <p>This portal is being prepared for a future release.</p>
    </div>
  </section>`;
}
