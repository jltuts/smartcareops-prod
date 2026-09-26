import { apiFetch } from '../../auth/service.js';
import './profile.css';

const fields = ['firstName', 'middleName', 'lastName', 'birthday', 'addressLine1', 'addressLine2', 'cityMunicipality', 'provinceState', 'postalCode', 'country'];
export const renderProfile = () => `<section class="role-page profile-page" aria-labelledby="page-heading">
  <a class="back-link" href="/" data-link>← Back to home</a><p class="eyebrow">Account settings</p><h1 id="page-heading" tabindex="-1">My Profile</h1>
  <p class="role-subtitle">Manage the trusted identity and profile information associated with your account.</p>
  <p id="profile-message" role="status" aria-live="polite">Loading your profile…</p>
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
    <button class="profile-save" type="submit">Save changes</button>
  </form>
</section>`;

const roleLabel = role => ({ patient: 'Patient', doctor: 'Doctor', dispatcher: 'Dispatcher', 'command-center': 'Command Center' }[role] || role);
export function mountProfile(outlet) {
  const form = outlet.querySelector('#profile-form'), message = outlet.querySelector('#profile-message'); let disposed = false, controller = new AbortController();
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
    for (const field of fields) form.elements[field].value = profile[field] || '';
    form.elements.birthday.max = new Date().toISOString().slice(0, 10);
    outlet.querySelector('#profile-display-context').textContent = profile.firstName && profile.lastName ? `Current profile name: ${profile.displayName}` : `Google account name: ${profile.displayName || 'Not provided'}. Enter your structured name below; it will not be guessed from this value.`;
    outlet.querySelector('#profile-email').textContent = profile.email || 'Not provided'; outlet.querySelector('#profile-uid').textContent = profile.uid;
    outlet.querySelector('#profile-roles').textContent = (profile.roles || []).map(roleLabel).join(' · ') || 'Patient'; outlet.querySelector('#profile-status').textContent = profile.status === 'active' ? 'Active' : profile.status;
    form.hidden = false;
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
      setProfile(result.profile); message.textContent = 'Profile updated successfully.';
    } catch (error) { message.textContent = error.message || 'Your profile could not be updated. Review the fields and try again.'; }
    finally { button.disabled = false; }
  };
  const updateAddressErrors = () => { if (form.querySelector('[aria-invalid="true"]')) showFieldErrors(addressErrors()); };
  form.addEventListener('input', updateAddressErrors); form.addEventListener('submit', submit); void load();
  return () => { disposed = true; controller.abort(); form.removeEventListener('input', updateAddressErrors); form.removeEventListener('submit', submit); };
}
