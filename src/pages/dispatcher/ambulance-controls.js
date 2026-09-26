import { apiFetch } from '../../auth/service.js';
import { ambulanceStatusLabels } from '../../../shared/ambulance.js';

const text = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };
export function mountAmbulanceControls(record, parent, onChanged) {
  const section = document.createElement('section'); section.id = 'dispatcher-ambulance'; parent.append(section);
  section.append(text('h3', 'Ambulance — fictional simulation'));
  section.append(text('p', 'Demo units only. No real emergency service is contacted.'));
  const status = text('p', record.ambulance ? `${record.ambulance.unitId} — ${ambulanceStatusLabels[record.ambulance.status]}` : 'No ambulance assigned'); status.id = 'dispatcher-ambulance-status'; section.append(status);
  const message = text('p', ''); message.id = 'ambulance-message'; message.setAttribute('role', 'status'); section.append(message);
  let disposed = false, controller, loadingController, generation = 0, busy = false;
  const controls = [];
  const disable = value => controls.forEach(control => { control.disabled = value; });
  async function command(path) {
    if (busy) return;
    busy = true; disable(true); controller = new AbortController(); message.textContent = 'Saving simulated ambulance state…';
    try {
      const response = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal });
      if (!response.ok) throw new Error('Unconfirmed');
      const saved = await response.json();
      if (disposed) return;
      if (saved.caseId !== record.caseId || !saved.ambulance) throw new Error('Unconfirmed');
      onChanged(saved);
    } catch { if (!disposed) { message.textContent = 'Simulated operation could not be confirmed. Refresh the case or available units, then retry.'; disable(false); } }
    finally { busy = false; }
  }
  if (record.ambulance) {
    section.append(text('p', `Assigned: ${new Date(record.ambulance.assignedAt).toLocaleString()}`));
    if (record.ambulance.dispatchedAt) section.append(text('p', `Simulated dispatch: ${new Date(record.ambulance.dispatchedAt).toLocaleString()}`));
    if (record.workflowStatus === 'ambulance_assigned') {
      const dispatch = text('button', 'Dispatch ambulance (simulation)'); dispatch.type = 'button'; controls.push(dispatch);
      dispatch.addEventListener('click', () => void command(`/api/cases/${record.caseId}/ambulance/dispatch`)); section.append(dispatch);
    }
  } else if (record.workflowStatus === 'emergency_acknowledged') {
    const label = text('label', 'Available fictional ambulances'); label.htmlFor = 'ambulance-unit';
    const select = document.createElement('select'); select.id = 'ambulance-unit';
    const assign = text('button', 'Assign ambulance (simulation)'); assign.type = 'button';
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
    assign.addEventListener('click', () => { if (select.value) void command(`/api/cases/${record.caseId}/ambulance/${encodeURIComponent(select.value)}/assign`); });
    void fleet();
  } else section.append(text('p', 'Dispatcher acknowledgement is required before assignment.'));
  return () => { disposed = true; controller?.abort(); loadingController?.abort(); };
}
