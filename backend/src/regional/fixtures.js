import { requireThat } from '../clinical/contracts.js';
import { hospitalIds, validateReport } from './snapshot.js';
// One explicit fictional incident: six aggregate census reports, no raw people.
export function seedReports(windowEnd, hospitalSnapshot) {
  requireThat(hospitalSnapshot?.simulation === true && hospitalSnapshot.hospitalId === 'HOSP-001', 'M10_SNAPSHOT_REQUIRED', 409);
  const end = Date.parse(windowEnd);
  requireThat(Number.isFinite(end), 'REGIONAL_WINDOW_REQUIRED');
  return Object.fromEntries(hospitalIds.flatMap((hospitalId, index) => ['previous', 'current'].map(period => {
    const current = period === 'current', reportId = `REG-DEMO-${hospitalId}-${period}`;
    const counts = index === 0 && current ? { active: hospitalSnapshot.counts.active, respiratory: hospitalSnapshot.counts.respiratory, emergency: hospitalSnapshot.counts.emergency, fever: null } :
      current ? { active: 3, respiratory: 2, emergency: index === 1 ? 1 : 0, fever: 1 } : { active: 2, respiratory: 1, emergency: 0, fever: 0 };
    const report = validateReport({ reportId, hospitalId, ...counts, observedAt: new Date(end - (current ? 1 : 19) * 3600000).toISOString(), simulation: true,
      source: index === 0 && current ? 'M10_aggregate_projection' : 'explicit_fictional_census_fixture', sourceRefs: index === 0 && current ? [hospitalSnapshot.snapshotId] : ['m11-demo-incident-v1'],
      missingDomains: index === 0 && current ? ['fever_not_recorded_in_M10'] : [] });
    return [reportId, report];
  })));
}
