import { digest, requireThat } from '../clinical/contracts.js';
import { distanceMeters } from '../resources/maps/simulation.js';
export const hospitalIds = ['HOSP-001', 'HOSP-002', 'HOSP-003'];
export const scope = Object.freeze({ scope: 'regional', workspaceId: 'REGION-DEMO-001', agentType: 'regional_outbreak_intelligence', simulation: true });
export const windowHours = 18;
export function validateReport(report) {
  requireThat(hospitalIds.includes(report.hospitalId) && report.simulation === true && Number.isFinite(Date.parse(report.observedAt)), 'INVALID_REGIONAL_REPORT');
  for (const key of ['active', 'respiratory', 'emergency', 'fever']) requireThat(key === 'fever' && report[key] === null || Number.isInteger(report[key]) && report[key] >= 0 && report[key] <= 100, 'INVALID_REGIONAL_REPORT');
  requireThat(['respiratory', 'emergency', 'fever'].every(key => report[key] === null || report[key] <= report.active), 'INVALID_REGIONAL_REPORT');
  return report;
}
export function evidenceFingerprint(state) {
  return digest({ reports: Object.values(state.reports).sort((a, b) => a.reportId.localeCompare(b.reportId)), anchor: state.meta?.windowEnd || null,
    pressure: state.pressureEvidence || null, catalog: state.resourceEnvironment?.resourceVersion || null, fleet: state.fleetEvidenceVersion });
}
export function summarizeWindows(reports, end) {
  const to = Date.parse(end), width = windowHours * 3600000;
  requireThat(Number.isFinite(to), 'REGIONAL_WINDOW_REQUIRED');
  const select = (hospitalId, start, stop) => reports.filter(item => item.hospitalId === hospitalId && Date.parse(item.observedAt) >= start && Date.parse(item.observedAt) < stop)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || b.reportId.localeCompare(a.reportId))[0] || null;
  reports.forEach(validateReport);
  return hospitalIds.map(hospitalId => ({ hospitalId, current: select(hospitalId, to - width, to), previous: select(hospitalId, to - 2 * width, to - width) }));
}
export function snapshot(state, now) {
  const version = state.meta.snapshotVersion + 1, snapshotId = `REG-SNAPSHOT-${version}`;
  const end = state.meta.windowEnd || new Date(now).toISOString();
  const samples = summarizeWindows(Object.values(state.reports), end);
  const hospitals = samples.map(sample => {
    const resource = state.resourceEnvironment.hospitals.find(item => item.hospitalId === sample.hospitalId);
    return { ...sample, capacity: structuredClone(resource.capacity), specialists: structuredClone(resource.specialists), location: structuredClone(resource.location), areaId: 'DEMO-AREA-001' };
  });
  const complete = samples.every(item => item.current && item.previous);
  const sum = (period, key) => complete && samples.every(item => item[period][key] !== null) ? samples.reduce((total, item) => total + item[period][key], 0) : null;
  const aggregate = { activeCases: sum('current', 'active'), respiratoryCases: sum('current', 'respiratory'), previousWindowRespiratoryCases: sum('previous', 'respiratory'),
    previousWindowActiveCases: sum('previous', 'active'), emergencyCases: sum('current', 'emergency'), feverCases: sum('current', 'fever'),
    hospitalsAffected: complete ? samples.filter(item => item.current.respiratory > 0).length : null,
    hospitalsIncreasing: complete ? samples.filter(item => item.current.respiratory > item.previous.respiratory).length : null,
    zeroMonitoredHospitals: hospitals.filter(item => item.capacity.monitoredBedsAvailable === 0).length };
  const pairs = hospitals.flatMap((a, i) => hospitals.slice(i + 1).map(b => ({ from: a.hospitalId, to: b.hospitalId, distanceMeters: distanceMeters(a.location, b.location) })));
  const geography = { evidenceId: `REG-GEO-${version}`, areaId: 'DEMO-AREA-001', pairs, proximityMeters: 10000, concentrated: pairs.every(pair => pair.distanceMeters <= 10000), simulation: true };
  const signals = [];
  if (complete && aggregate.activeCases > aggregate.previousWindowActiveCases) signals.push('case_volume_increase');
  if (complete && aggregate.hospitalsIncreasing >= 2) signals.push('multi_hospital_respiratory_increase');
  if (aggregate.zeroMonitoredHospitals > 0) signals.push('capacity_pressure');
  if (geography.concentrated && complete && aggregate.hospitalsAffected > 1) signals.push('geographic_concentration');
  const fleet = state.fleetEvidence ? { available: state.fleetEvidence.filter(item => item.status === 'available').length, reserved: state.fleetEvidence.filter(item => item.status !== 'available').length } : null;
  // A current reservation is not evidence of increasing demand over time.
  return { ...scope, snapshotId, snapshotVersion: version, observedAt: new Date(now).toISOString(), windowHours, windowEnd: end,
    previousWindowStart: new Date(Date.parse(end) - 36 * 3600000).toISOString(), currentWindowStart: new Date(Date.parse(end) - 18 * 3600000).toISOString(),
    windowMethod: 'latest aggregate census per hospital in each half-open window; not incident case arrivals', complete, hospitals, aggregate, geography, fleet,
    trendId: `REG-TREND-${version}`, signals, pressureSignal: state.pressureEvidence || null, evidenceFingerprint: evidenceFingerprint(state),
    resourceVersion: state.resourceEnvironment.resourceVersion, fleetEvidenceVersion: state.fleetEvidenceVersion,
    sourceRefs: samples.flatMap(item => [item.current?.reportId, item.previous?.reportId].filter(Boolean)) };
}
