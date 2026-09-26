"""Offline tracked-worktree and reachable-Git-blob scan; never print matched values.
Run from the repository root. Pattern scan, not proof of absence of every secret.
"""
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path.cwd()
GIT = ['git', '-c', 'safe.directory=' + ROOT.as_posix()]
rules = {
    'google-api-key': rb'AIza[0-9A-Za-z_-]{35}',
    'aws-access-key': rb'(?:AKIA|ASIA)[A-Z0-9]{16}',
    'github-token': rb'(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{70,255})',
    'private-key': rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'service-account-private-key': rb'"private_key"\s*:\s*"[^"\r\n]{20,}',
    'frontend-secret-variable': rb'(?im)^VITE_[A-Z_]*(?:SECRET|PASSWORD|PRIVATE_KEY|ACCESS_TOKEN|GEMINI_API_KEY)[A-Z_]*\s*=\s*["\x27]?[A-Za-z0-9_/-]{16,}',
}
patterns = {name: re.compile(pattern) for name, pattern in rules.items()}
findings = []
def scan(data, source):
    for name, pattern in patterns.items():
        if pattern.search(data): findings.append({'source': source, 'rule': name})

tracked = subprocess.check_output(GIT + ['ls-files', '-z']).decode().split('\0')
for name in filter(None, tracked):
    path = ROOT / name
    if path.is_file(): scan(path.read_bytes(), 'worktree:' + name)
objects = subprocess.check_output(GIT + ['rev-list', '--objects', '--all']).decode().splitlines()
process = subprocess.Popen(GIT + ['cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
blobs = 0
for entry in objects:
    oid = entry.split(' ', 1)[0]
    process.stdin.write((oid + '\n').encode()); process.stdin.flush()
    header = process.stdout.readline().split()
    if len(header) != 3: raise RuntimeError('Unable to scan Git object')
    size = int(header[2]); data = process.stdout.read(size); process.stdout.read(1)
    if header[1] == b'blob':
        blobs += 1
        scan(data, 'history:' + oid)
process.stdin.close(); process.wait()
# Include new implementation files not yet tracked, excluding ignored local data.
untracked = subprocess.check_output(GIT + ['ls-files', '--others', '--exclude-standard', '-z']).decode().split('\0')
for name in filter(None, untracked):
    path = ROOT / name
    if path.is_file() and path.suffix in ['.js', '.json', '.md', '.py', '.tf', '.hcl', '.tfvars', '.tftpl', '.yaml', '.yml', '.example']: scan(path.read_bytes(), 'new-file:' + name)
print(json.dumps({'trackedFiles': len(list(filter(None, tracked))), 'reachableBlobs': blobs, 'findings': findings}, indent=2))
raise SystemExit(1 if findings else 0)
