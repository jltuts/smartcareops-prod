import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createManagedShadowHttpHandler } from './http.js';
import { createManagedClinicalShadowService } from './service.js';
import { createManagedApplicationService } from './application-service.js';
import { createManagedPolicyRetriever, createRuntimeMetadataTokenProvider } from './managed-policy.js';

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT_INVALID');

const logger = {
  error: value => console.error(value),
  info: value => console.log(value),
};
const service = createManagedClinicalShadowService({ recordTelemetry: async event => logger.info(JSON.stringify({ component: 'm60-managed-shadow', ...event })) });
const fixture = JSON.parse(await readFile(new URL('./policy/ingestion-fixture.json', import.meta.url), 'utf8'));
const receipt = JSON.parse(await readFile(new URL('./policy/managed-ingestion-receipt.json', import.meta.url), 'utf8'));
const accessToken = createRuntimeMetadataTokenProvider();
const retrievePolicy = createManagedPolicyRetriever({ fixture, receipt, accessToken });
const applicationService = createManagedApplicationService({ retrievePolicy,
  recordTelemetry: async event => logger.info(JSON.stringify({ component: 'm60-managed-application', ...event })) });
const server = createServer(createManagedShadowHttpHandler({ service, applicationService, logger }));
server.listen(port, '0.0.0.0', () => logger.info(JSON.stringify({ component: 'm60-managed-shadow', status: 'listening', port })));
