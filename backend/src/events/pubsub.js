import { PubSub } from '@google-cloud/pubsub';
import { validateEventEnvelope, eventAttributes } from './contracts.js';

export function createPubSubPublisher({ projectId, topicName, client = new PubSub({ projectId }) }) {
  if (typeof projectId !== 'string' || !projectId || typeof topicName !== 'string' || !topicName) throw new Error('PUBSUB_CONFIGURATION_REQUIRED');
  const topic = client.topic(topicName);
  return async envelope => {
    envelope = validateEventEnvelope(envelope);
    return topic.publishMessage({ data: Buffer.from(JSON.stringify(envelope)), attributes: eventAttributes(envelope) });
  };
}

export function decodePubSubMessage(message) {
  let value;
  try { value = JSON.parse(Buffer.from(message?.data || '').toString('utf8')); }
  catch { throw new Error('INVALID_PUBSUB_MESSAGE'); }
  return { envelope: validateEventEnvelope(value), messageId: typeof message?.id === 'string' && message.id ? message.id : 'unknown' };
}
