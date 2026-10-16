import { renderPublicNav, mountPublicPage } from './home/index.js';
import './technology.css';

const asset = name => `/images/technology/${name}`;
const groups = [
  { id: 'google-ai', title: 'Google AI', summary: 'Two Google AI services support real-time conversation and bounded analysis.', icon: asset('gemini.png'), items: [
    ['Gemini Live API', 'Runs the Patient’s real-time voice conversation through a short-lived browser session.', asset('gemini.png'), true, null, ['gemini-3.8-live · voice intake']],
    ['Gemini API', 'Supports structured clinical and operational analysis; SmartCareOps validates results before use.', asset('gemini.png'), false, null, ['gemini-3.6-flash · structured analysis and IDP', 'gemini-3.8-flash · computer use']],
  ] },
  { id: 'managed-agent-governance', title: 'Managed agent governance', summary: 'A grounded Clinical Review Agent for bounded fictional demonstrations.', icon: asset('gemini.png'), items: [
    ['Gemini Enterprise Agent Platform', 'Runs the Clinical Review Agent for named fictional demo cases within a set demo window. SmartCareOps validates the schema and evidence, the Doctor remains the decision-maker, and the existing clinical model is the automatic fallback.', asset('gemini.png'), false, 'Bounded fictional demo', ['gemini-3.6-flash · clinical review agent']],
    ['Vertex AI RAG Engine', 'Provides the grounding foundation for an approved fictional policy corpus. The corpus contains safety and evidence policies only—no Patient data or treatment guidance.', null, false, 'Grounding foundation'],
    ['Model Armor', 'Inspects the pilot for prompt injection, sensitive data, and harmful content. Blocking and application integration remain disabled.', null, false, 'Inspect only'],
  ] },
  { id: 'smartcareops-capabilities', title: 'SmartCareOps capabilities', summary: 'Application workflows built by SmartCareOps and powered by Gemini.', icon: null, items: [
    ['Intelligent Data Processing (IDP)', 'In the Doctor Portal, Doctors upload laboratory reports and Gemini extracts structured values. Doctors compare the original, correct any values, and verify the results before requesting a review-only assessment.', asset('gemini.png'), false, null, ['gemini-3.6-flash · laboratory report extraction']],
  ] },
  { id: 'application-platform', title: 'Web and compute', summary: 'Authenticated entry points and independently deployed services.', icon: asset('cloud-run.svg'), items: [
    ['Firebase Authentication', 'Signs users in; SmartCareOps applies its own portal-role checks.', asset('firebase-authentication.svg')],
    ['Firebase Hosting', 'Delivers the web application and its client-side routes.', asset('firebase-hosting.svg')],
    ['Cloud Run', 'Hosts the Node.js API, isolated Live service, and event workers.', asset('cloud-run.svg')],
    ['API Gateway', 'Exposes only the configured API routes; backend authorization still applies.', asset('api-gateway.svg')],
  ] },
  { id: 'data-events', title: 'Data and events', summary: 'Authoritative records, private evidence, and asynchronous metadata delivery.', icon: asset('firestore.svg'), items: [
    ['Firestore', 'Stores cases, operational state, audit receipts, and the transactional event outbox.', asset('firestore.svg')],
    ['Pub/Sub', 'Delivers metadata-only outbox events to the audit and Operations consumers.', null],
    ['Cloud Storage', 'Stores Patient-submitted evidence images privately.', asset('cloud-storage.svg')],
  ] },
  { id: 'supporting-platform', title: 'Security and supporting platform', summary: 'Bounded credentials, service access, demo geography, and image delivery.', icon: asset('secret-manager.svg'), items: [
    ['Secret Manager', 'Holds server-side credentials used by authorized services.', asset('secret-manager.svg')],
    ['Identity and Access Management', 'Scopes Cloud Run service and Pub/Sub delivery permissions.', asset('iam.svg')],
    ['Google Maps Platform', 'Displays fictional hospital geography and route context.', asset('google-maps.png')],
    ['Artifact Registry', 'Holds immutable backend container images.', asset('artifact-registry.svg')],
  ] },
];

const stack = [
  ['Frontend', 'HTML5, CSS3, Vanilla JavaScript, Vite, Firebase JS SDK, and browser Web Audio / AudioWorklet APIs. GSAP and Lenis support selected page motion.'],
  ['Backend', 'Node.js services with the Google Gen AI SDK, Firebase Admin SDK, and Google Cloud clients for Firestore, Pub/Sub, and Storage.'],
  ['Terraform', 'Uses infrastructure as code (IaC) to provision Google Cloud resources and deploy reviewed Cloud Run image and configuration updates.'],
  ['GitHub', 'Hosts the SmartCareOps source repository for versioned collaboration.'],
  ['Deployment', 'Docker builds and pushes backend images to Artifact Registry; Terraform deploys their immutable digests to Cloud Run. Firebase CLI deploys the frontend to Hosting.'],
  ['Verification', 'Node.js built-in tests cover backend behavior. Playwright checks browser flows at desktop and mobile viewport sizes.'],
];

function technologyIcon(src, live = false) {
  if (!src) return '<span class="technology-icon technology-icon-event" aria-hidden="true"><i></i><i></i><i></i></span>';
  return `<span class="technology-icon${live ? ' technology-icon-live' : ''}" aria-hidden="true"><img src="${src}" alt="">${live ? '<i></i><i></i><i></i>' : ''}</span>`;
}

function technologyGroup({ id, title, summary, icon, items }) {
  return `<section class="technology-group" id="${id}" aria-labelledby="${id}-heading">
    <header class="technology-group-header">${technologyIcon(icon)}<div><h2 id="${id}-heading">${title}</h2><p>${summary}</p></div></header>
    <div class="technology-cards">${items.map(([name, description, productIcon, live, status, models]) => `<article class="technology-card">${technologyIcon(productIcon, live)}<div>${status ? `<span class="technology-status">${status}</span>` : ''}<h3>${name}</h3><p>${description}</p>${models ? `<div class="technology-models" aria-label="Models">${models.map(model => `<span>${model}</span>`).join('')}</div>` : ''}</div></article>`).join('')}</div>
  </section>`;
}

export function renderTechnology() {
  return `<div class="landing-page technology-page">
    ${renderPublicNav('technology')}
    <main class="technology-content">
      <header class="technology-hero">
        <div><h1 id="page-heading" tabindex="-1">Built with Google AI and Google Cloud.</h1><p>Explore the services and development stack that power SmartCareOps: Gemini for voice and analysis, a governed agent pilot for grounded review, and Google Cloud for the application, records, events, security, and deployment.</p></div>
        <nav class="technology-hero-links" aria-label="Technology categories"><a href="#google-ai">Google AI and models <span aria-hidden="true">↗</span></a><a href="#managed-agent-governance">Managed agent pilot <span aria-hidden="true">↗</span></a><a href="#smartcareops-capabilities">SmartCareOps capabilities <span aria-hidden="true">↗</span></a><a href="#application-platform">Web and compute <span aria-hidden="true">↗</span></a><a href="#data-events">Data and events <span aria-hidden="true">↗</span></a><a href="#technology-stack">Application stack <span aria-hidden="true">↗</span></a></nav>
      </header>
      <div class="technology-groups">${groups.map(technologyGroup).join('')}</div>
      <section class="technology-stack" id="technology-stack" aria-labelledby="technology-stack-heading"><div class="technology-stack-intro"><h2 id="technology-stack-heading">Application stack</h2><p>Beyond the managed services, SmartCareOps uses a lean web and Node.js stack with automated checks and reviewed infrastructure configuration.</p></div><dl>${stack.map(([label, detail]) => `<div><dt>${label}</dt><dd>${detail}</dd></div>`).join('')}</dl></section>
      <p class="technology-boundaries">This is a fictional demonstration. Gemini supports conversation and analysis; authorized people retain clinical and operational decision authority. <a href="/howitworks" data-link>See how SmartCareOps works <span aria-hidden="true">→</span></a></p>
      <div class="technology-actions"><a class="landing-button landing-button-primary" href="/patient" data-link>Start Patient Intake <span aria-hidden="true">→</span></a><a class="landing-button technology-manual-link" href="/manual" data-link>Read the User Manual <span aria-hidden="true">→</span></a></div>
    </main>
  </div>`;
}

export const mountTechnology = mountPublicPage;
