// Opt-in fictional DEV verifier: deliberately never starts the Clinical Agent.
import { createApiServer } from '../src/server.js';
import { createConfiguredCaseStore } from '../src/cases/firestore.js';
import { configuredOperationsStore } from '../src/operations/storage.js';
import { createOperationsService } from '../src/operations/service.js';
if (!process.send || process.env.M10_ENABLED !== 'true' || process.env.APP_ENV !== 'development') process.exit(2);
let options = { operationsEnabled: true, clinicalEnabled: false };
if (process.env.M10_READ_ONLY === 'true') {
  const caseStore = createConfiguredCaseStore(), service = createOperationsService({ store: configuredOperationsStore(process.env, caseStore), caseStore });
  options = { caseStore, clinicalEnabled: false, operationsService: { view: service.view, tick: async () => {}, close: service.close } };
}
const api = createApiServer(options);
api.server.listen(0, '127.0.0.1', () => process.send({ port: api.server.address().port }));
process.on('message', async message => { if (message === 'stop') { await api.shutdown(); process.exit(0); } });
