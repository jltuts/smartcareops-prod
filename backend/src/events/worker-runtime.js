import { createServer } from 'node:http';
import { createPublisherWorker, createAuditSubscriptionWorker } from './workers.js';

const namePattern = /^[a-z][a-z0-9-]{2,254}$/;
const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function eventWorkerConfig(env = process.env) {
  if (env.M55_ENABLED !== 'true') throw new Error('M55_WORKER_DISABLED');
  if (!['publisher', 'audit'].includes(env.M55_WORKER_MODE)) throw new Error('M55_WORKER_MODE_INVALID');
  if (!namePattern.test(env.FIREBASE_PROJECT_ID || '')) throw new Error('M55_PROJECT_REQUIRED');
  const mode = env.M55_WORKER_MODE;
  const topicName = env.M55_TOPIC || '';
  const subscriptionName = env.M55_SUBSCRIPTION || '';
  if (mode === 'publisher' && !namePattern.test(topicName)) throw new Error('M55_TOPIC_REQUIRED');
  if (mode === 'audit' && !namePattern.test(subscriptionName)) throw new Error('M55_SUBSCRIPTION_REQUIRED');
  return Object.freeze({ mode, projectId: env.FIREBASE_PROJECT_ID, topicName, subscriptionName,
    port: positiveInteger(env.PORT, 8080), pollIntervalMs: Math.max(250, Math.min(60000, positiveInteger(env.M55_POLL_INTERVAL_MS, 1000))),
    batchSize: Math.max(1, Math.min(100, positiveInteger(env.M55_BATCH_SIZE, 20))) });
}

const closeServer = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const listen = (server, port) => new Promise((resolve, reject) => {
  const onError = error => { server.off('listening', onListening); reject(error); };
  const onListening = () => { server.off('error', onError); resolve(); };
  server.once('error', onError); server.once('listening', onListening); server.listen(port, '0.0.0.0');
});

export function createEventWorkerRuntime({ config, outboxStore, auditStore, publish, subscription,
  close = async () => {}, logger = console, createHttpServer = createServer } = {}) {
  let ready = false, stopping = false, timer = null, active = null, auditWorker = null;
  const report = (stage, error) => logger.error('[event-worker]', JSON.stringify({ mode: config.mode, stage,
    error: typeof error?.code === 'string' ? error.code : error?.name || 'Error' }));
  const publisher = config.mode === 'publisher' ? createPublisherWorker({ store: outboxStore, publish, batchSize: config.batchSize }) : null;
  const tick = () => {
    if (stopping || active || !publisher) return active;
    active = publisher.tick().then(result => {
      if (result.failed > 0) logger.error('[event-worker]', JSON.stringify({ mode: config.mode, stage: 'publish_batch', ...result }));
      return result;
    }).catch(error => report('publish_cycle', error)).finally(() => { active = null; });
    return active;
  };
  const server = createHttpServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method !== 'GET' || !['/healthz', '/readyz'].includes(path)) { response.writeHead(404).end(); return; }
    const healthy = path === '/healthz' || ready;
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ status: healthy ? 'ok' : 'starting', mode: config.mode }));
  });
  return Object.freeze({
    get ready() { return ready; },
    async start() {
      if (ready) return false;
      stopping = false;
      await listen(server, config.port);
      if (config.mode === 'publisher') { timer = setInterval(tick, config.pollIntervalMs); timer.unref(); void tick(); }
      else {
        auditWorker = createAuditSubscriptionWorker({ subscription, store: auditStore, onError: error => report('audit_subscription', error) });
        auditWorker.start();
      }
      ready = true;
      return true;
    },
    async stop() {
      if (stopping) return false;
      stopping = true; ready = false;
      if (timer) { clearInterval(timer); timer = null; }
      auditWorker?.stop();
      await active;
      if (server.listening) await closeServer(server);
      await close();
      return true;
    },
  });
}
