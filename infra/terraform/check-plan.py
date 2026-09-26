"""Fail closed on destructive or out-of-scope actions in a saved DEV plan JSON.
Usage: terraform show -json dev-review.tfplan > dev-review.plan.json
       python check-plan.py dev-review.plan.json
This supplements human review; it does not authorize apply.
"""
import json
import sys
from collections import Counter
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
failures, counts, imports = [], Counter(), 0
database_seen = False
for resource in plan.get('resource_changes', []):
    if resource.get('mode') == 'data':
        continue
    address, kind, change = resource['address'], resource['type'], resource['change']
    actions, after = change['actions'], change.get('after') or {}
    counts['/'.join(actions)] += 1
    imports += bool(change.get('importing'))
    if 'delete' in actions:
        failures.append(f'{address}: delete/replacement requires a separate review')
    if kind in {'google_project', 'google_secret_manager_secret_version', 'google_service_account_key',
                'google_project_iam_policy', 'google_project_iam_binding'}:
        failures.append(f'{address}: forbidden resource type')
    if kind == 'google_firestore_database':
        database_seen = True
        if 'create' in actions:
            failures.append(f'{address}: existing Firestore must be imported, never created')
        expected = {'name': '(default)', 'project': 'gen-lang-client-0710663107',
                    'location_id': 'asia-southeast1', 'type': 'FIRESTORE_NATIVE',
                    'database_edition': 'STANDARD', 'delete_protection_state': 'DELETE_PROTECTION_ENABLED',
                    'deletion_policy': 'PREVENT'}
        for key, value in expected.items():
            if after.get(key) != value:
                failures.append(f'{address}: unexpected {key}')
        before = change.get('before') or {}
        for key, value in before.items():
            if key not in {'delete_protection_state', 'deletion_policy'} and key in after and after[key] != value:
                failures.append(f'{address}: unexpected update to {key}')
    if kind == 'google_project_service' and (after.get('disable_on_destroy') is True or after.get('deletion_policy') != 'ABANDON'):
        failures.append(f'{address}: service must survive destroy')
    public_member = after.get('member') in {'allUsers', 'allAuthenticatedUsers'}
    allowed_live_public = (
        address == 'google_cloud_run_v2_service_iam_member.live_public_invoker[0]' and
        kind == 'google_cloud_run_v2_service_iam_member' and
        actions == ['create'] and after.get('name') == 'smartcareops-live' and
        after.get('role') == 'roles/run.invoker' and after.get('member') == 'allUsers'
    )
    if after.get('role') in {'roles/owner', 'roles/editor'} or public_member and not allowed_live_public:
        failures.append(f'{address}: excessive IAM grant')
if not database_seen:
    failures.append('Missing Firestore adoption from plan; do not use a targeted plan to bypass review')
print(json.dumps({'imports': imports, 'actions': dict(counts), 'failures': failures}, indent=2))
raise SystemExit(bool(failures))
