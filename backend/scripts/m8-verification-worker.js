// Separate backend process used only by the opt-in DEV verifier.
import { createApiServer } from '../src/server.js';
if (!process.send || process.env.M8_ENABLED !== 'true' || process.env.APP_ENV !== 'development') process.exit(2);
const api = createApiServer({ clinicalEnabled: true });
api.server.listen(0, '127.0.0.1', () => process.send({ port: api.server.address().port }));
process.on('message', async message => { if (message === 'stop') { await api.shutdown(); process.exit(0); } });
