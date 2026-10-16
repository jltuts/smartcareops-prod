import { mountHomeMotion } from './motion.js';
import { brandMarkup } from '../../components/brand.js';
import './home.css';

const portals = [
  { path: '/patient', role: 'Patient', title: 'Start and follow your care.', description: 'Voice or chat intake, case status, appointments, and transport updates.', className: 'patient' },
  { path: '/doctor', role: 'Doctor', title: 'Review and decide.', description: 'Patient-reported evidence, AI-supported analysis, observations, and clinical decisions.', className: 'doctor' },
  { path: '/dispatcher', role: 'Dispatcher', title: 'Coordinate emergency response.', description: 'Emergency cases, simulated destinations, ambulances, and response progress.', className: 'dispatcher' },
  { path: '/command-center', role: 'Command Center', title: 'See the wider system.', description: 'Network pressure, response activity, forecasts, patterns, and CareTwin.', className: 'command' },
];
const journey = [['01', 'First contact', 'The patient begins a voice or chat intake and describes a concern in their own words.'], ['02', 'Preserve the facts', 'SmartCareOps records patient-reported answers and any explicitly shared evidence separately from AI interpretation.'], ['03', 'Select the pathway', 'A routine case goes toward Doctor review; a supported emergency stops routine questions and enters the Dispatcher pathway.'], ['04', 'Support the right team', 'AI can organize case information for clinical review. Separate hospital-capacity signals can support network planning.'], ['05', 'Human decision', 'Doctors, Dispatchers, and authorized operators make consequential decisions within their own roles.'], ['06', 'Record the outcome', 'Each authorized action and status is saved so the appropriate people can follow what happened next.']];
const closingPoints = ['Voice and chat intake', 'Coordinated care', 'Human decision authority'];

function publicNavCurrent() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/portals') return ['portals', 'page'];
  if (path === '/') {
    const sections = { '#portals': 'portals', '#intelligence': 'howitworks', '#about': 'about' };
    return [sections[window.location.hash] || 'home', 'location'];
  }
  return [path.slice(1), 'page'];
}

export function renderPublicNav(current = 'home', showPortalAction = true) {
  const home = current === 'home';
  const [active, currentType] = publicNavCurrent();
  const items = [
    ['Home', home ? '#home' : '/', !home],
    ['Portals', home ? '#portals' : '/#portals', !home],
    ['How It Works', '/howitworks', true],
    ['Technology', '/technology', true],
    ['About', '/about', true],
  ];
  return `<nav class="landing-nav" aria-label="Primary navigation"><div class="landing-nav-links">${items.map(([label, href, routeLink]) => `<a href="${href}"${routeLink ? ' data-link' : ''}${label.toLowerCase().replaceAll(' ', '') === active ? ` aria-current="${currentType}"` : ''}>${label}</a>`).join('')}</div>${showPortalAction ? '<a class="landing-nav-cta" href="/patient" data-link>Patient Portal <span aria-hidden="true">↗</span></a>' : ''}</nav>`;
}

export function mountPublicNav(outlet) {
  const nav = outlet.querySelector('.landing-nav');
  document.querySelector('.site-header .smartcareops-brand').after(nav);
  const updateCurrent = () => {
    const [active, currentType] = publicNavCurrent();
    nav.querySelectorAll('.landing-nav-links a').forEach(link => {
      if (link.textContent.toLowerCase().replaceAll(' ', '') === active) link.setAttribute('aria-current', currentType);
      else link.removeAttribute('aria-current');
    });
  };
  window.addEventListener('hashchange', updateCurrent);
  window.addEventListener('popstate', updateCurrent);
  return () => {
    window.removeEventListener('hashchange', updateCurrent);
    window.removeEventListener('popstate', updateCurrent);
    nav.remove();
  };
}

export function mountPublicPage(outlet) {
  document.body.classList.add('landing-active');
  const disposeNav = mountPublicNav(outlet);
  return () => { disposeNav(); document.body.classList.remove('landing-active'); };
}

function portalIcon(name) {
  const icons = {
    patient: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4.8 21a7.2 7.2 0 0 1 14.4 0"/>',
    doctor: '<path d="M6 3v5a6 6 0 0 0 12 0V3"/><path d="M4 3h4M16 3h4M12 14v2a4 4 0 0 0 8 0v-1"/><circle cx="20" cy="12" r="2"/>',
    dispatcher: '<path d="M3 7h11v10H3zM14 10h3l4 4v3h-7z"/><path d="M7 10v4M5 12h4"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
    command: '<path d="M5 20v-6h4v6M10 20V9h4v11M15 20V4h4v16M3 20h18"/>',
  };
  return `<span class="landing-portal-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${icons[name]}</svg></span>`;
}

function renderHowItWorksSection() {
  return `<section class="landing-section landing-intelligence" id="intelligence" aria-labelledby="intelligence-heading">
    <div class="landing-section-intro landing-section-intro-split"><div><p class="landing-kicker">How SmartCareOps Works</p><h2 id="intelligence-heading">From facts to coordinated action.</h2></div><div class="landing-intro-action"><p>Patients can start with voice or chat. The recorded facts determine the care pathway; separate hospital-capacity events inform network operations. Consequential actions remain with authorized people.</p><a class="landing-walkthrough-link" href="/manual" data-link>See User Manual <span aria-hidden="true">→</span></a></div></div>
    <div class="landing-care-journey"><div class="landing-journey-track"><div class="landing-journey-line" aria-hidden="true"><i></i></div>${journey.map(([number, title, copy]) => `<article class="landing-journey-step"><span>${number}</span><div><h3>${title}</h3><p>${copy}</p></div></article>`).join('')}</div></div>
    <div class="landing-intelligence-stack" aria-label="Distinct SmartCareOps pathways">
      <article><span>01 · Normal care</span><div><p>Patient case</p><h3>Doctor review.</h3><small>A completed routine intake is routed for an authorized Doctor to review. An appointment is optional.</small></div><b aria-hidden="true">CARE</b></article>
      <article><span>02 · Emergency</span><div><p>Human-controlled response</p><h3>Dispatcher pathway.</h3><small>A supported emergency stops routine intake. A Dispatcher acknowledges the saved case and records each fictional response step.</small></div><b aria-hidden="true">RESPONSE</b></article>
      <article><span>03 · Network signal</span><div><p>Hospital Operations</p><h3>Capacity assessment.</h3><small>A separate fictional hospital-capacity event can start a bounded Operations session. Routine intake alone does not activate it.</small></div><b aria-hidden="true">NETWORK</b></article>
    </div>
  </section>`;
}

export function renderHowItWorks() {
  return `<div class="landing-page">${renderPublicNav('howitworks')}<h1 id="page-heading" class="landing-visually-hidden" tabindex="-1">How SmartCareOps Works</h1>${renderHowItWorksSection()}</div>`;
}

export const mountHowItWorks = mountPublicPage;

export function renderHome() {
  return `<div class="landing-page">
    ${renderPublicNav()}
    <section class="landing-hero" id="home" aria-labelledby="page-heading"><div class="landing-hero-glow landing-orbit" aria-hidden="true"></div><div class="landing-hero-copy"><p class="landing-kicker">One connected care journey</p><h1 id="page-heading" tabindex="-1"><span class="landing-visually-hidden">SmartCareOps</span><span aria-hidden="true"><span class="landing-hero-line">From first contact</span><span class="landing-hero-line">to better outcomes.</span></span></h1><p class="landing-hero-statement"><strong>AI that doesn’t just assess.</strong><br>It coordinates care.</p><p class="landing-hero-intro">SmartCareOps connects patients, clinicians, responders, hospitals, and system-wide intelligence into one coordinated care journey.</p><div class="landing-hero-actions"><a class="landing-button landing-button-primary" href="/patient" data-link>Start Patient Intake <span aria-hidden="true">→</span></a><a class="landing-button landing-button-light" href="/howitworks" data-link>See how it works <span aria-hidden="true">→</span></a></div><dl class="landing-proof" aria-label="Platform principles"><div><dt>4</dt><dd>connected portals</dd></div><div><dt>1</dt><dd>shared care journey</dd></div><div><dt>Human</dt><dd>decision authority</dd></div></dl></div><div class="landing-hero-visual" aria-label="Patient, Doctor, Dispatcher, and Command Center coordinated by SmartCareOps"><div class="landing-network-ring ring-one" aria-hidden="true"></div><div class="landing-network-ring ring-two" aria-hidden="true"></div><svg class="landing-hero-connectors" viewBox="0 0 100 100" aria-hidden="true"><path class="connector-patient-doctor" d="M23 28 C40 16 61 16 78 28"/><path class="connector-doctor-response" d="M79 32 C87 46 85 61 77 73"/><path class="connector-response-network" d="M70 79 C53 88 35 87 20 75"/></svg><div class="landing-network-core"><span class="landing-brand-mark" aria-hidden="true"><i></i><i></i></span><strong>SmartCareOps</strong><small>Coordinated intelligence</small></div><div class="landing-network-node node-patient"><span>01</span><strong>Patient</strong><small>First contact<br>Intake received</small></div><div class="landing-network-node node-doctor"><span>02</span><strong>Doctor</strong><small>Clinical review<br>Decision ready</small></div><div class="landing-network-node node-response"><span>03</span><strong>Dispatcher</strong><small>Emergency response<br>Route coordinated</small></div><div class="landing-network-node node-network"><span>04</span><strong>Command Center</strong><small>Monitor hospitals<br>Network intelligence</small></div><div class="landing-care-card landing-care-card-status"><span>CARE JOURNEY</span><strong class="landing-story-status">Connected</strong><i></i><small>Every step remains visible</small></div><div class="landing-care-card landing-care-card-signal"><span>NETWORK SIGNAL</span><strong>Stable</strong><small>Operations in view</small></div></div><a class="landing-scroll-cue" href="#portals"><span>Scroll to explore</span><i aria-hidden="true"></i></a></section>
    <section class="landing-section landing-portals" id="portals" aria-labelledby="portals-heading"><div class="landing-section-intro"><p class="landing-kicker">Four roles. One connected system.</p><h2 id="portals-heading">Choose your workspace.</h2><p>Each workspace supports a different part of the care journey.</p></div><div class="landing-portal-grid">${portals.map(portal => `<a class="landing-portal-card portal-card landing-portal-${portal.className}" href="${portal.path}" data-link>${portalIcon(portal.className)}<div class="landing-portal-copy"><p>${portal.role}</p><h3>${portal.title}</h3><span>${portal.description}</span></div><strong class="landing-portal-link">Enter ${portal.role} Portal <span aria-hidden="true">→</span></strong></a>`).join('')}</div><p class="landing-portal-access">Access depends on your approved role.</p></section>
    ${renderHowItWorksSection()}
    <section class="landing-final" id="about" aria-labelledby="final-heading"><div class="landing-final-orbit" aria-hidden="true"></div><div class="landing-tech-strip" aria-label="SmartCareOps care principles">${closingPoints.map(item => `<span>${item}</span>`).join('')}</div><p class="landing-kicker">Connected care, clear responsibility</p><h2 id="final-heading">Care stays connected.<br class="landing-final-desktop-break"> Decisions stay accountable.</h2><p>Across patient intake, clinical review, emergency response, and network planning, SmartCareOps keeps the right information visible to the right team.<br class="landing-final-desktop-break"> Authorized people make every consequential decision.</p><div class="landing-hero-actions"><a class="landing-button landing-button-light" href="/patient" data-link>Start Patient Intake <span aria-hidden="true">→</span></a><a class="landing-button landing-button-ghost" href="/technology" data-link>Explore the technology <span aria-hidden="true">→</span></a></div></section><footer class="landing-footer">${brandMarkup({ href: '#home', className: 'landing-brand', routeLink: false })}<p>Connected care operations</p><a href="/about" data-link>About &amp; demo notice</a></footer>
  </div>`;
}

export function mountHome(outlet) {
  const disposePublicPage = mountPublicPage(outlet);
  const disposeMotion = mountHomeMotion(outlet);
  return () => { disposeMotion(); disposePublicPage(); };
}
