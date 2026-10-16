import './about.css';
import { renderPublicNav } from './home/index.js';

const icon = name => {
  const paths = {
    clarity: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5M10 12h6M10 16h6"/>',
    people: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3.5 20v-2.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V20M15 14h1.5a4 4 0 0 1 4 4v2"/>',
    continuity: '<path d="M8.5 8.5 6.8 6.8a4 4 0 0 0-5.6 5.7l2.2 2.2a4 4 0 0 0 5.7 0l6-6a4 4 0 0 1 5.7 0l2 2a4 4 0 0 1-5.7 5.7l-1.7-1.7"/>',
    person: '<circle cx="12" cy="7" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
    demo: '<path d="M9 3h6M10 3v5l-5 9a2.5 2.5 0 0 0 2.2 4h9.6A2.5 2.5 0 0 0 19 17l-5-9V3M8 15h8"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
};

export const renderAbout = () => `<article class="role-page public-notice about-page" aria-labelledby="page-heading">
  ${renderPublicNav('about')}

  <header class="about-hero">
    <div class="about-hero-copy">
      <p class="about-kicker">About SmartCareOps</p>
      <h1 id="page-heading" tabindex="-1">A clearer path through care.</h1>
      <p>SmartCareOps helps Patients and care teams stay informed, coordinated, and in control.</p>
    </div>
    <div class="about-people-mark" aria-label="SmartCareOps keeps people connected">
      <span class="about-person about-person-top">${icon('person')}</span>
      <span class="about-person about-person-left">${icon('person')}</span>
      <span class="about-person about-person-right">${icon('person')}</span>
      <span class="about-people-ring" aria-hidden="true"></span>
      <span class="about-brand-mark" aria-hidden="true"><i></i><i></i></span>
      <small>People make care stronger</small>
    </div>
  </header>

  <section class="about-values" aria-labelledby="about-values-heading">
    <p class="about-kicker" id="about-values-heading">What we stand for</p>
    <div class="about-value-grid">
      <article>${icon('clarity')}<div><h2>Clarity</h2><p>The right information, clearly presented.</p></div></article>
      <article>${icon('people')}<div><h2>Human judgment</h2><p>People remain responsible for care decisions.</p></div></article>
      <article>${icon('continuity')}<div><h2>Continuity</h2><p>Updates and decisions stay connected.</p></div></article>
    </div>
  </section>

  <section class="about-people" aria-labelledby="about-people-heading">
    <div class="about-people-copy">
      <h2 id="about-people-heading">Built around people</h2>
      <p>Technology supports the conversation. Patients, clinicians, and operators remain at the center.</p>
    </div>
    <img src="/images/about-people.jpg" alt="Clinician listening to an older Patient">
    <p class="about-people-message" aria-hidden="true">Better conversations.<br>Brighter days.</p>
  </section>

  <section class="about-demo" aria-labelledby="about-demo-heading">
    <span class="about-demo-icon">${icon('demo')}</span>
    <div>
      <h2 id="about-demo-heading">Fictional demonstration</h2>
      <p>SmartCareOps uses simulated information and does not provide medical or emergency services.</p>
    </div>
    <nav aria-label="Google policies">
      <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google Privacy Policy <span aria-hidden="true">↗</span></a>
      <a href="https://cloud.google.com/maps-platform/terms" target="_blank" rel="noopener noreferrer">Google Maps Platform Terms <span aria-hidden="true">↗</span></a>
    </nav>
  </section>

  <details class="about-disclosures">
    <summary>Demo and data details</summary>
    <div class="about-disclosure-grid">
      <section aria-label="Account and conversation data"><h2>Account and conversation</h2><p>Sign-in uses the Google account flow provided by Firebase. SmartCareOps does not ask you to enter a Google password in this app. When you start a voice conversation, microphone audio and conversation text are sent to Google Gemini for the fictional demo interaction.</p></section>
      <section aria-label="Patient-submitted evidence images"><h2>Patient-submitted evidence images</h2><p>Evidence images use private Google Cloud Storage and remain associated with the Patient's case. The Patient and an authorized reviewing Doctor can view the case evidence. Google Cloud Storage encrypts stored data by default. Encryption does not replace SmartCareOps access checks.</p></section>
      <section aria-label="Demonstration maps"><h2>Demonstration maps</h2><p>Google Maps JavaScript API may display seeded demonstration geography. The demo uses fictional coordinates and does not use device GPS or provide live tracking or live travel estimates.</p></section>
    </div>
  </details>

  <nav class="about-actions" aria-label="Explore SmartCareOps">
    <a href="/patient" data-link>Start Patient Intake <span aria-hidden="true">→</span></a>
    <a href="/#portals" data-link>Explore the portals <span aria-hidden="true">→</span></a>
  </nav>
</article>`;
