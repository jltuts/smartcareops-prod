import { portals } from '../../config/portals.js';

export function renderHome() {
  return `<section class="hero" aria-labelledby="page-heading">
    <p class="eyebrow">Connected care starts here</p>
    <h1 id="page-heading" tabindex="-1">SmartCareOps</h1>
    <p class="tagline">From first contact to the right care.</p>
    <p class="intro">A shared starting point for patients, clinicians, response teams, and healthcare operations.</p>
    <p class="journey">First contact <span>→</span> Intake <span>→</span> Triage <span>→</span> Routing <span>→</span> Response <span>→</span> Care</p>
  </section>
  <section class="portal-section" aria-labelledby="portal-heading">
    <div class="section-heading"><h2 id="portal-heading">Choose your portal</h2><p>Four roles. One care journey.</p></div>
    <div class="portal-grid">${portals.map(portal => `<a class="portal-card" href="${portal.path}" data-link>
      <span class="eyebrow">${portal.label}</span>
      <h3>${portal.title} <span aria-hidden="true">↗</span></h3>
      <p>${portal.subtitle}</p>
      <span class="card-action">Explore portal <span aria-hidden="true">→</span></span>
    </a>`).join('')}</div>
    <p class="scope-note">Secure access keeps each portal aligned with its care-team responsibilities.</p>
  </section>`;
}
