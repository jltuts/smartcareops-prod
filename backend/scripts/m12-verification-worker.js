import { createApiServer } from '../src/server.js';
if (!process.send || process.env.M12_ENABLED !== 'true' || process.env.APP_ENV !== 'development') process.exit(2);
const phase = process.env.M12_PHASE;
const api = createApiServer({ clinicalEnabled: phase === 'clinical', operationsEnabled: phase === 'hospital', regionalEnabled: phase === 'regional', notificationsEnabled: true });
api.server.listen(0, '127.0.0.1', () => process.send({ port: api.server.address().port }));
process.on('message', async message => { if (message === 'stop') { await api.shutdown(); process.exit(0); } });
