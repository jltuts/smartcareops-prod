import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { passwordHash } from '../src/demo-auth.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = resolve(root, '.demo-auth');
const names = ['patient1', 'patient2', 'patient3', 'doctor1', 'doctor2', 'doctor3', 'dispatcher1', 'dispatcher2', 'commandcenter1', 'commandcenter2', 'admin1'];
const displayNames = Object.freeze({
  patient1: 'John Doe', patient2: 'Ericka Smith', patient3: 'Donna Lim',
  doctor1: 'Marie Carter', doctor2: 'Alex Parks', doctor3: 'Bryan Lee',
  dispatcher1: 'Elmer Vance', dispatcher2: 'Clara Ashford',
  commandcenter1: 'Maya Linley', commandcenter2: 'Aster Dray', admin1: 'Gemini Master',
});
const accounts = [], credentials = ['SmartCareOps demo credentials', 'Fictional hackathon accounts. Store privately and rotate before sharing again.', ''];
for (const username of names) {
  const password = `${randomBytes(9).toString('base64url')}!${randomBytes(3).toString('hex')}`;
  const passwordSalt = randomBytes(16).toString('base64url');
  accounts.push({ username, uid: `demo-local-${username}`, displayName: displayNames[username], active: true, accountVersion: 1, passwordSalt, passwordHash: await passwordHash(password, passwordSalt) });
  credentials.push(`${username}: ${password}`);
}
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'secret.json'), JSON.stringify({ version: 1, signingKey: randomBytes(48).toString('base64url'), accounts }, null, 2), { mode: 0o600 });
await writeFile(resolve(output, 'judge-credentials.txt'), credentials.join('\n') + '\n', { mode: 0o600 });
console.log(JSON.stringify({ status: 'created', secretPath: resolve(output, 'secret.json'), credentialsPath: resolve(output, 'judge-credentials.txt'), accountCount: accounts.length }));
