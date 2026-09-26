import { createApiServer } from '../src/server.js';
import { createConfiguredCaseStore } from '../src/cases/firestore.js';
import { configuredRegionalStore } from '../src/regional/storage.js';
import { createRegionalService } from '../src/regional/service.js';
if (!process.send || process.env.M11_ENABLED !== 'true' || process.env.APP_ENV !== 'development') process.exit(2);
let options = { clinicalEnabled: false, operationsEnabled: false, regionalEnabled: true };
if (process.env.M11_READ_ONLY === 'true') {
  const caseStore = createConfiguredCaseStore(), service = createRegionalService({ store: configuredRegionalStore(process.env, caseStore), caseStore });
  options = { caseStore, regionalService: { view: service.view, tick: async () => {}, close: service.close } };
}
const api = createApiServer(options);
api.server.listen(0, '127.0.0.1', () => process.send({ port: api.server.address().port }));
process.on('message', async message => { if (message === 'stop') { await api.shutdown(); process.exit(0); } });
