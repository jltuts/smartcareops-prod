import './operational-map.css';

const hospitalCoordinates = Object.freeze({
  'HOSP-001': { lat: 14.615, lng: 121.015 },
  'HOSP-002': { lat: 14.625, lng: 121.005 },
  'HOSP-003': { lat: 14.655, lng: 121.040 },
});
const districtCoordinates = Object.freeze({
  'Central District': { lat: 14.600, lng: 121.000 },
  'East District': hospitalCoordinates['HOSP-002'], 'South District': hospitalCoordinates['HOSP-003'],
  'HOSP-001': hospitalCoordinates['HOSP-001'], 'HOSP-002': hospitalCoordinates['HOSP-002'], 'HOSP-003': hospitalCoordinates['HOSP-003'],
});
const ambulanceDefaults = Object.freeze([
  { id: 'AMB-01', location: 'Central District', status: 'available' },
  { id: 'AMB-02', location: 'East District', status: 'available' },
  { id: 'AMB-03', location: 'South District', status: 'available' },
]);
const mapCenter = Object.freeze({ lat: 14.6275, lng: 121.0200 });
export const defaultPatientPickup = Object.freeze({ id: 'patient', label: 'Fictional demo pickup', position: { lat: 14.600, lng: 121.000 } });
const mapStyles = [
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#eef4f1' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#d9edf3' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#d5dfda' }] },
];
const instances = new WeakMap();
let loaderPromise;

const browserKey = () => import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY || '';
export function loadGoogleMaps(key = browserKey()) {
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  if (loaderPromise) return loaderPromise;
  if (!key) return Promise.reject(new Error('MAPS_BROWSER_KEY_MISSING'));
  loaderPromise = new Promise((resolve, reject) => {
    const callback = '__smartcareopsGoogleMapsReady';
    window[callback] = () => { delete window[callback]; resolve(window.google.maps); };
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=${callback}`;
    script.async = true; script.defer = true; script.dataset.smartcareopsMaps = 'true';
    script.onerror = () => { delete window[callback]; loaderPromise = undefined; reject(new Error('MAPS_JAVASCRIPT_API_UNAVAILABLE')); };
    document.head.append(script);
  });
  return loaderPromise;
}

const coordinatesForHospital = id => hospitalCoordinates[id];
const coordinatesForAmbulance = unit => districtCoordinates[unit.location] || districtCoordinates[unit.assignment?.destination] || districtCoordinates['Central District'];
export const defaultMapHospitals = () => [
  { id: 'HOSP-001', name: 'Northstar General', operationalState: 'normal' },
  { id: 'HOSP-002', name: 'Riverside Medical', operationalState: 'normal' },
  { id: 'HOSP-003', name: 'Harbor Community Hospital', operationalState: 'normal' },
];
export const defaultMapAmbulances = () => ambulanceDefaults.map(unit => ({ ...unit, assignment: null }));

export function operationalMapMarkup({ id, title, description, mode = 'operations', legend = ['hospital', 'ambulance', 'cluster'] }) {
  const legendLabels = { hospital: 'Hospital', ambulance: 'Ambulance', cluster: 'Possible cluster', patient: 'Pickup' };
  return `<section class="operational-map" id="${id}" aria-labelledby="${id}-title">
    <header class="operational-map-header"><div><p class="eyebrow">Google Maps · seeded demo geography</p><h3 id="${id}-title">${title}</h3><p>${description}</p></div>
      <div class="map-legend" aria-label="Map legend">${legend.map(kind => `<span><i class="legend-dot ${kind}"></i>${legendLabels[kind]}</span>`).join('')}</div>
    </header>
    <div class="operational-map-stage" data-map-mode="${mode}"><div class="google-map-canvas" role="img" aria-label="Google Map of the fictional SmartCareOps demo region"></div><span class="map-demo-label">FICTIONAL DEMO NETWORK</span></div>
    <div class="map-entity-list" aria-label="Mapped operational entities"></div>
    <footer><p class="map-status">Loading Google Maps…</p></footer>
  </section>`;
}

const icon = (kind, state) => ({
  path: kind === 'hospital' ? 'M0,-16 C9,-16 15,-10 15,-1 C15,9 0,18 0,18 C0,18 -15,9 -15,-1 C-15,-10 -9,-16 0,-16 Z' : kind === 'patient' ? 'M0,-12 C7,-12 12,-7 12,0 C12,7 7,12 0,12 C-7,12 -12,7 -12,0 C-12,-7 -7,-12 0,-12 Z' : 'M0,-12 L12,0 L0,12 L-12,0 Z',
  fillColor: state === 'critical' ? '#b93336' : ['pressured', 'degraded', 'dispatched', 'transporting', 'en_route', 'assigned'].includes(state) ? '#c56a2b' : kind === 'ambulance' ? '#236ea0' : kind === 'patient' ? '#137f89' : '#176c61',
  fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3, scale: 1,
});
const addEntity = (list, kind, id, label, state) => { const item = document.createElement('span'); item.dataset.mapMarker = kind; item.dataset.entityId = id; item.className = `map-entity map-entity-${kind} state-${state}`; item.textContent = label; list.append(item); };

async function drawGoogleMap(root, data) {
  const maps = await loadGoogleMaps(), canvas = root.querySelector('.google-map-canvas'), list = root.querySelector('.map-entity-list');
  let instance = instances.get(root);
  if (!instance) { instance = { map: new maps.Map(canvas, { center: mapCenter, zoom: 13, styles: mapStyles, mapTypeControl: false, streetViewControl: false, fullscreenControl: true, clickableIcons: false }), overlays: [] }; instances.set(root, instance); }
  instance.overlays.forEach(overlay => overlay.setMap?.(null)); instance.overlays = []; list.replaceChildren();
  const bounds = new maps.LatLngBounds();
  if (data.pickup?.position) {
    const pickup = data.pickup;
    instance.overlays.push(new maps.Marker({ map: instance.map, position: pickup.position, title: pickup.label, label: { text: 'P', color: '#ffffff', fontSize: '9px', fontWeight: '800' }, icon: icon('patient', 'pickup'), zIndex: 35 }));
    addEntity(list, 'patient', pickup.id || 'patient', pickup.label || 'Fictional demo pickup', 'pickup'); bounds.extend(pickup.position);
  }
  for (const hospital of data.hospitals) {
    const id = hospital.id || hospital.hospitalId, position = coordinatesForHospital(id); if (!position) continue;
    const state = hospital.operationalState || hospital.state || 'normal', title = `${hospital.name || id} · ${state}`;
    instance.overlays.push(new maps.Marker({ map: instance.map, position, title, label: { text: '+', color: '#ffffff', fontWeight: '800' }, icon: icon('hospital', state), zIndex: 20 }));
    addEntity(list, 'hospital', id, `${id} · ${hospital.name || id} · ${state}`, state); bounds.extend(position);
  }
  for (const unit of data.ambulances) {
    const id = unit.id || unit.unitId, position = coordinatesForAmbulance(unit), state = unit.status || 'available';
    instance.overlays.push(new maps.Marker({ map: instance.map, position, title: `${id} · ${state} fictional ambulance`, label: { text: 'A', color: '#ffffff', fontSize: '9px', fontWeight: '800' }, icon: icon('ambulance', state), zIndex: 30 }));
    addEntity(list, 'ambulance', id, `${id} · ${state}`, state); bounds.extend(position);
    const destination = unit.assignment?.destination, destinationPosition = coordinatesForHospital(destination);
    if (destinationPosition) { instance.overlays.push(new maps.Polyline({ map: instance.map, path: [position, destinationPosition], geodesic: false, strokeColor: '#236ea0', strokeOpacity: .9, strokeWeight: 3, icons: [{ icon: { path: maps.SymbolPath.FORWARD_CLOSED_ARROW }, offset: '100%' }] })); bounds.extend(destinationPosition); }
  }
  if (data.cluster?.active) {
    const severity = data.cluster.severity || 'watch', clusterCenter = { lat: 14.635, lng: 121.026 };
    instance.overlays.push(new maps.Circle({ map: instance.map, center: clusterCenter, radius: 3200, fillColor: severity === 'critical' ? '#b93336' : '#d47b30', fillOpacity: .12, strokeColor: severity === 'critical' ? '#b93336' : '#d47b30', strokeOpacity: .9, strokeWeight: 2 }));
    const entity = document.createElement('span'); entity.dataset.mapCluster = 'true'; entity.className = `map-entity map-entity-cluster severity-${severity}`; entity.textContent = `${data.cluster.region || 'REGION-DEMO-001'} · possible synthetic cluster · ${severity}`; list.append(entity); bounds.extend(clusterCenter);
  }
  if (!bounds.isEmpty?.()) instance.map.fitBounds(bounds, 42);
  canvas.dataset.mapReady = 'true';
}

export function renderOperationalMap(root, { hospitals = defaultMapHospitals(), ambulances = defaultMapAmbulances(), pickup = null, cluster = null, status = null } = {}) {
  if (!root) return;
  root.querySelector('.map-status').textContent = 'Loading Google Maps…';
  void drawGoogleMap(root, { hospitals, ambulances, pickup, cluster }).then(() => { root.querySelector('.map-status').textContent = status || 'Seeded simulation coordinates · no live location or routing data'; }).catch(error => {
    root.querySelector('.google-map-canvas').dataset.mapReady = 'false';
    root.querySelector('.map-status').textContent = error.message === 'MAPS_BROWSER_KEY_MISSING' ? 'Google Maps is not configured. Add the restricted public browser key to enable this view.' : 'Google Maps could not be loaded. Operational data remains available in the adjacent panels.';
  });
}
