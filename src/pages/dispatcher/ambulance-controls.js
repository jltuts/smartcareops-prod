import { apiFetch } from '../../auth/service.js';
import { ambulanceStatusLabels } from '../../../shared/ambulance.js';

const text = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };
const transitions = Object.freeze({
  assigned: ['Dispatch ambulance (simulation)', 'dispatch'],
  en_route: ['Record arrival at pickup', 'arrive-pickup'],
  at_pickup: ['Start simulated transport', 'start-transport'],
  transporting: ['Record arrival at hospital', 'arrive-hospital'],
  arrived_hospital: ['Complete simulated response', 'complete'],
});

export function mountAmbulanceControls(record, parent, onChanged) {
  const section = document.createElement('section'); section.id = 'dispatcher-ambulance'; parent.append(section);
  section.append(text('h3', 'Emergency response — fictional simulation'));
  section.append(text('p', 'Human-controlled demo actions only. No real hospital or emergency service is contacted.'));
  const destination = record.emergencyDestination;
  const destinationStatus = text('p', destination ? `${destination.hospitalName} — simulated acceptance recorded` : 'No hospital destination selected');
  destinationStatus.id = 'dispatcher-destination-status'; section.append(destinationStatus);
  const status = text('p', record.ambulance ? `${record.ambulance.unitId} — ${ambulanceStatusLabels[record.ambulance.status]}` : 'No ambulance assigned');
  status.id = 'dispatcher-ambulance-status'; section.append(status);
  const message = text('p', ''); message.id = 'ambulance-message'; message.setAttribute('role', 'status'); section.append(message);
  let disposed = false, controller, loadingController, hospitalController, generation = 0, busy = false;
  const controls = [];
  const disable = value => controls.forEach(control => { control.disabled = value; });
  async function command(path, validate = saved => saved.caseId === record.caseId) {
    if (busy) return;
    busy = true; disable(true); controller = new AbortController(); message.textContent = 'Saving simulated response state…';
    try {
      const response = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal });
      if (!response.ok) throw new Error('Unconfirmed');
      const saved = await response.json();
      if (disposed) return;
      if (!validate(saved)) throw new Error('Unconfirmed');
      onChanged(saved);
    } catch { if (!disposed) { message.textContent = 'Simulated operation could not be confirmed. Refresh the case, then retry.'; disable(false); } }
    finally { busy = false; }
  }
  if (record.emergency?.status === 'acknowledged' && !destination && !record.ambulance?.dispatchedAt) {
    const hospitalMessage = text('p', 'Loading eligible demo hospitals…'); hospitalMessage.id = 'hospital-message'; hospitalMessage.setAttribute('role', 'status'); section.append(hospitalMessage);
    const label = text('label', 'Eligible demo hospitals'); label.htmlFor = 'emergency-hospital';
    const select = document.createElement('select'); select.id = 'emergency-hospital';
    const accept = text('button', 'Record simulated hospital acceptance'); accept.type = 'button'; accept.className = 'dispatcher-primary-action';
    controls.push(select, accept); section.append(label, select, accept);
    select.disabled = accept.disabled = true;
    hospitalController = new AbortController();
    void apiFetch(`/api/dispatcher/cases/${record.caseId}/hospitals`, { cache: 'no-store', signal: hospitalController.signal }).then(async response => {
      if (!response.ok) throw new Error('Unavailable');
      const result = await response.json();
      if (disposed) return;
      for (const option of result.options || []) {
        const node = text('option', `${option.hospitalName} · ${(option.distanceMeters / 1000).toFixed(1)} km · ${option.emergencyBedsAvailable} demo beds`);
        node.value = option.hospitalId; select.append(node);
      }
      select.disabled = accept.disabled = !select.options.length;
      hospitalMessage.textContent = select.options.length ? 'Select a destination and record its simulated acceptance.' : 'No eligible demo hospital is available.';
    }).catch(() => { if (!disposed) hospitalMessage.textContent = 'Demo hospital options are unavailable. Refresh the case to retry.'; });
    accept.addEventListener('click', () => { if (select.value) void command(`/api/dispatcher/cases/${record.caseId}/hospitals/${encodeURIComponent(select.value)}/select`, saved => saved.caseId === record.caseId && saved.emergencyDestination?.hospitalId === select.value); });
  }
  if (record.ambulance) {
    section.append(text('p', `Assigned: ${new Date(record.ambulance.assignedAt).toLocaleString()}`));
    if (destination) section.append(text('p', `Destination: ${destination.hospitalName} · ${(destination.distanceMeters / 1000).toFixed(1)} km · about ${Math.ceil(destination.durationSeconds / 60)} minutes in this demo`));
    const next = transitions[record.ambulance.status];
    if (next) {
      const button = text('button', next[0]); button.type = 'button'; button.className = 'dispatcher-primary-action';
      if (record.ambulance.status === 'assigned' && !destination) button.disabled = true;
      controls.push(button); button.addEventListener('click', () => void command(`/api/cases/${record.caseId}/ambulance/${next[1]}`, saved => saved.caseId === record.caseId && !!saved.ambulance)); section.append(button);
    }
  } else if (record.workflowStatus === 'emergency_acknowledged') {
    const label = text('label', 'Available fictional ambulances'); label.htmlFor = 'ambulance-unit';
    const select = document.createElement('select'); select.id = 'ambulance-unit';
    const assign = text('button', 'Assign ambulance (simulation)'); assign.type = 'button'; assign.className = 'dispatcher-primary-action';
    const refresh = text('button', 'Refresh available units'); refresh.type = 'button'; controls.push(select, assign, refresh);
    section.append(label, select, assign, refresh);
    async function fleet() {
      if (busy) return;
      loadingController?.abort(); loadingController = new AbortController(); const current = ++generation;
      select.replaceChildren(); select.disabled = true; assign.disabled = true; message.textContent = 'Loading available fictional ambulances…';
      try {
        const response = await apiFetch('/api/ambulances', { cache: 'no-store', signal: loadingController.signal });
        if (!response.ok) throw new Error('Unavailable');
        const result = await response.json();
        if (disposed || current !== generation) return;
        for (const unit of result.units.filter(unit => unit.status === 'available')) {
          const option = text('option', `${unit.unitId} · ${unit.displayName} · ${unit.baseLabel}`); option.value = unit.unitId; select.append(option);
        }
        select.disabled = assign.disabled = !select.options.length;
        message.textContent = select.options.length ? 'Choose an available demo unit.' : 'No fictional ambulances are available.';
      } catch { if (!disposed && current === generation) message.textContent = 'Fleet unavailable. Refresh available units to retry.'; }
    }
    refresh.addEventListener('click', () => void fleet());
    assign.addEventListener('click', () => { if (select.value) void command(`/api/cases/${record.caseId}/ambulance/${encodeURIComponent(select.value)}/assign`, saved => saved.caseId === record.caseId && !!saved.ambulance); });
    void fleet();
  } else if (!record.ambulance) section.append(text('p', 'Dispatcher acknowledgement is required before assignment.'));
  return () => { disposed = true; controller?.abort(); loadingController?.abort(); hospitalController?.abort(); };
}
