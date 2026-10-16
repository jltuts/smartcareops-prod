import { apiFetch, authState } from '../../auth/service.js';
import '../patient/patient.css';
import './profile.css';

const fields = ['firstName', 'middleName', 'lastName', 'birthday', 'addressLine1', 'addressLine2', 'cityMunicipality', 'provinceState', 'postalCode', 'country'];
const iconPaths = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V10Z"/><path d="M9 21v-7h6v7"/>',
  cases: '<path d="M8 4h8l3 3v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2Z"/><path d="M8 4v4h8V4M9 13h6M9 17h6"/>',
  transport: '<path d="M4 16V9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7H4ZM7 7l2-3h6l2 3M4 16v2h2m14-2v2h-2"/><circle cx="8" cy="17" r="1"/><circle cx="16" cy="17" r="1"/>',
  messages: '<path d="M4 5h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8l-5 3V6a1 1 0 0 1 1-1Z"/><path d="M7 9h10M7 13h7"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  support: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="m5.6 5.6 4.3 4.3m4.2 4.2 4.3 4.3m0-12.8-4.3 4.3m-4.2 4.2-4.3 4.3"/>',
};
const icon = name => `<svg class="patient-nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${iconPaths[name]}</svg>`;
export const renderProfile = () => `<section class="role-page profile-page" aria-labelledby="page-heading">
  <div class="patient-page-help"><a class="patient-help-link" href="/manual#patient" data-link>${icon('support')}Need help?</a></div>
  <div class="patient-shell"><aside class="patient-sidebar" aria-label="Patient navigation"><nav><a href="/patient" data-link>${icon('home')}Home</a><a href="/patient#cases" data-link>${icon('cases')}My Cases</a><a href="/patient#transport" data-link>${icon('transport')}Transport</a><a href="/patient#messages" data-link>${icon('messages')}Messages</a><a class="active" href="/profile" aria-current="page" data-link>${icon('profile')}Profile</a></nav></aside>
  <div class="patient-main profile-main"><div class="profile-heading"><div><p class="eyebrow">Patient Portal</p><h1 id="page-heading" tabindex="-1">Your profile</h1><p class="role-subtitle">Keep your information up to date.</p></div><time id="profile-today"></time></div>
  <p id="profile-message" role="status" aria-live="polite">Loading your profile…</p>
  <div id="profile-view" hidden>
    <section class="profile-identity-card" aria-label="Patient identity"><span class="profile-photo" id="profile-photo" aria-hidden="true">${icon('profile')}</span><div><strong id="profile-identity-name">Name not provided</strong><span id="profile-identity-role">Patient</span></div></section>
    <div class="profile-detail-grid"><section class="profile-detail-card" aria-labelledby="profile-personal-heading"><h2 id="profile-personal-heading">Personal information</h2><dl><div><dt>Full name</dt><dd id="profile-full-name">Not provided</dd></div><div><dt>Birthday</dt><dd id="profile-birthday">Not provided</dd></div></dl></section><section class="profile-detail-card" aria-labelledby="profile-contact-heading"><h2 id="profile-contact-heading">Contact details</h2><dl><div><dt>Email</dt><dd id="profile-contact-email">Not provided</dd></div><div><dt>Address</dt><dd id="profile-address">Not provided</dd></div></dl></section></div>
    <button id="edit-profile" class="profile-edit" type="button">Edit profile</button>
    <a class="profile-support-card" href="/manual#patient" data-link><span class="profile-support-icon">${icon('support')}</span><span><strong>Need help with your account?</strong><small>Read the patient guide</small></span><span aria-hidden="true">→</span></a>
  </div>
  <form id="profile-form" hidden>
    <fieldset><legend>Personal Information</legend><p id="profile-display-context" class="profile-context"></p>
      <label>First name<input name="firstName" required maxlength="100" autocomplete="given-name"></label>
      <label>Middle name<input name="middleName" maxlength="100" autocomplete="additional-name"></label>
      <label>Last name<input name="lastName" required maxlength="100" autocomplete="family-name"></label>
      <label>Birthday<input name="birthday" type="date" min="1900-01-01" autocomplete="bday"></label>
    </fieldset>
    <fieldset><legend>Address</legend><p class="profile-context">Your saved profile address is not used as your current emergency or case location.</p>
      <label>Address line 1<input name="addressLine1" maxlength="200" autocomplete="address-line1" aria-describedby="profile-error-addressLine1"><span class="profile-field-error" id="profile-error-addressLine1" hidden></span></label>
      <label>Address line 2<input name="addressLine2" maxlength="200" autocomplete="address-line2"></label>
      <label>City / Municipality<input name="cityMunicipality" maxlength="120" autocomplete="address-level2" aria-describedby="profile-error-cityMunicipality"><span class="profile-field-error" id="profile-error-cityMunicipality" hidden></span></label>
      <label>Province / State<input name="provinceState" maxlength="120" autocomplete="address-level1" aria-describedby="profile-error-provinceState"><span class="profile-field-error" id="profile-error-provinceState" hidden></span></label>
      <label>Postal code<input name="postalCode" maxlength="32" autocomplete="postal-code"></label>
      <label>Country<input name="country" maxlength="100" autocomplete="country-name" aria-describedby="profile-error-country"><span class="profile-field-error" id="profile-error-country" hidden></span></label>
    </fieldset>
    <fieldset class="profile-account"><legend>Account</legend><dl><div><dt>Email</dt><dd id="profile-email"></dd></div><div><dt>User ID</dt><dd id="profile-uid"></dd></div><div><dt>Roles</dt><dd id="profile-roles"></dd></div><div><dt>Status</dt><dd id="profile-status"></dd></div></dl><p class="profile-context">These fields are managed by SmartCareOps and cannot be edited here.</p></fieldset>
    <div class="profile-form-actions"><button class="profile-save" type="submit">Save changes</button><button id="cancel-profile" class="profile-cancel" type="button">Cancel</button></div>
  </form>
  </div></div><nav class="patient-mobile-nav" aria-label="Patient mobile navigation"><a href="/patient" data-link>${icon('home')}Home</a><a href="/patient#cases" data-link>${icon('cases')}My Cases</a><a href="/patient#messages" data-link>${icon('messages')}Messages</a><a href="/profile" aria-current="page" data-link>${icon('profile')}Profile</a></nav>
</section>`;

const roleLabel = role => ({ patient: 'Patient', doctor: 'Doctor', dispatcher: 'Dispatcher', 'command-center': 'Command Center' }[role] || role);
export function mountProfile(outlet) {
  const form = outlet.querySelector('#profile-form'), message = outlet.querySelector('#profile-message'), view = outlet.querySelector('#profile-view');
  let disposed = false, currentProfile, controller = new AbortController();
  outlet.querySelector('#profile-today').textContent = new Intl.DateTimeFormat(navigator.language, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());
  const photoUrl = authState().user?.photoURL;
  if (photoUrl && /^https:\/\//.test(photoUrl)) {
    const photo = document.createElement('img'); photo.src = photoUrl; photo.alt = ''; photo.referrerPolicy = 'no-referrer';
    outlet.querySelector('#profile-photo').replaceChildren(photo);
  }
  const edit = () => { view.hidden = true; form.hidden = false; message.textContent = ''; form.elements.firstName.focus(); };
  const cancel = () => { if (currentProfile) setProfile(currentProfile); form.hidden = true; view.hidden = false; message.textContent = ''; outlet.querySelector('#edit-profile').focus(); };
  outlet.querySelector('#edit-profile').addEventListener('click', edit);
  outlet.querySelector('#cancel-profile').addEventListener('click', cancel);
  const addressFields = ['addressLine1', 'addressLine2', 'cityMunicipality', 'provinceState', 'postalCode', 'country'];
  const addressErrors = () => {
    if (!addressFields.some(field => form.elements[field].value.trim())) return {};
    const errors = {};
    if (!form.elements.addressLine1.value.trim()) errors.addressLine1 = 'Address line 1 is required when entering an address.';
    if (!form.elements.cityMunicipality.value.trim()) errors.cityMunicipality = 'City / Municipality is required when entering an address.';
    if (!form.elements.provinceState.value.trim()) errors.provinceState = 'Province / State is required when entering an address.';
    if (!form.elements.country.value.trim()) errors.country = 'Country is required when entering an address.';
    return errors;
  };
  const showFieldErrors = errors => {
    for (const field of ['addressLine1', 'cityMunicipality', 'provinceState', 'country']) {
      const input = form.elements[field], error = outlet.querySelector(`#profile-error-${field}`), text = errors[field] || '';
      error.textContent = text; error.hidden = !text;
      if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
  };
  const setProfile = profile => {
    currentProfile = profile;
    for (const field of fields) form.elements[field].value = profile[field] || '';
    showFieldErrors({}); form.elements.birthday.removeAttribute('aria-invalid');
    form.elements.birthday.max = new Date().toISOString().slice(0, 10);
    outlet.querySelector('#profile-display-context').textContent = profile.firstName && profile.lastName ? `Current profile name: ${profile.displayName}` : `Google account name: ${profile.displayName || 'Not provided'}. Enter your structured name below; it will not be guessed from this value.`;
    const structuredName = [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(' ');
    const displayName = structuredName || profile.displayName || 'Name not provided';
    const address = [profile.addressLine1, profile.addressLine2, profile.cityMunicipality, profile.provinceState, profile.postalCode, profile.country].filter(Boolean).join(', ');
    outlet.querySelector('#profile-identity-name').textContent = displayName;
    outlet.querySelector('#profile-full-name').textContent = displayName;
    outlet.querySelector('#profile-contact-email').textContent = profile.email || 'Not provided';
    outlet.querySelector('#profile-address').textContent = address || 'Not provided';
    outlet.querySelector('#profile-birthday').textContent = profile.birthday ? new Intl.DateTimeFormat(navigator.language, { dateStyle: 'long' }).format(new Date(`${profile.birthday}T12:00:00`)) : 'Not provided';
    outlet.querySelector('#profile-identity-role').textContent = (profile.roles || []).includes('patient') ? 'Patient' : roleLabel((profile.roles || [])[0] || 'patient');
    outlet.querySelector('#profile-email').textContent = profile.email || 'Not provided'; outlet.querySelector('#profile-uid').textContent = profile.uid || 'Not provided';
    outlet.querySelector('#profile-roles').textContent = (profile.roles || []).map(roleLabel).join(' · ') || 'Patient'; outlet.querySelector('#profile-status').textContent = profile.status === 'active' ? 'Active' : profile.status;
    view.hidden = false;
  };
  const load = async () => {
    try { const response = await apiFetch('/api/profile', { cache: 'no-store', signal: controller.signal }); if (!response.ok) throw new Error(); setProfile((await response.json()).profile); message.textContent = ''; }
    catch { if (!disposed) message.textContent = 'Your profile could not be loaded. Refresh to try again.'; }
  };
  const submit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(fields.map(field => [field, form.elements[field].value]));
    const errors = addressErrors(); showFieldErrors(errors);
    if (Object.keys(errors).length) {
      message.textContent = '';
      form.elements[Object.keys(errors)[0]].focus();
      return;
    }
    const button = form.querySelector('button[type="submit"]'); button.disabled = true; message.textContent = 'Saving your profile…';
    try {
      const response = await apiFetch('/api/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const result = await response.json();
      if (!response.ok) {
        if (result.code === 'INCOMPLETE_ADDRESS') {
          const serverAddressErrors = addressErrors(); showFieldErrors(serverAddressErrors);
          message.textContent = '';
          form.elements[Object.keys(serverAddressErrors)[0]]?.focus();
          return;
        }
        if (result.code === 'INVALID_BIRTHDAY') {
          const input = form.elements.birthday; input.setAttribute('aria-invalid', 'true'); input.focus();
          message.textContent = 'Birthday must be a valid date in the expected format.';
          return;
        }
        throw new Error(result.message);
      }
      setProfile(result.profile); form.hidden = true; message.textContent = 'Profile updated successfully.';
    } catch (error) { message.textContent = error.message || 'Your profile could not be updated. Review the fields and try again.'; }
    finally { button.disabled = false; }
  };
  const updateAddressErrors = () => { if (form.querySelector('[aria-invalid="true"]')) showFieldErrors(addressErrors()); };
  form.addEventListener('input', updateAddressErrors); form.addEventListener('submit', submit); void load();
  return () => { disposed = true; controller.abort(); form.removeEventListener('input', updateAddressErrors); form.removeEventListener('submit', submit); outlet.querySelector('#edit-profile').removeEventListener('click', edit); outlet.querySelector('#cancel-profile').removeEventListener('click', cancel); };
}
