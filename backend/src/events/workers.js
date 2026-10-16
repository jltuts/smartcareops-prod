import { createOutboxPublisher, createAuditConsumer } from './outbox.js';
import { decodePubSubMessage } from './pubsub.js';

export function createPublisherWorker({ store, publish, batchSize = 20 }) {
  const publisher = createOutboxPublisher({ store, publish, batchSize });
  return Object.freeze({ tick: () => publisher.drain() });
}

export function createAuditSubscriptionWorker({ subscription, store, onError = () => {} }) {
  const consume = createAuditConsumer(store);
  let started = false;
  const report = error => { try { onError(error); } catch {} };
  const onMessage = async message => {
    try {
      await consume(decodePubSubMessage(message));
      message.ack();
    } catch (error) {
      report(error);
      message.nack();
    }
  };
  const onSubscriptionError = error => report(error);
  return Object.freeze({
    start() {
      if (started) return false;
      started = true;
      subscription.on('message', onMessage);
      subscription.on('error', onSubscriptionError);
      return true;
    },
    stop() {
      if (!started) return false;
      started = false;
      subscription.removeListener('message', onMessage);
      subscription.removeListener('error', onSubscriptionError);
      return true;
    },
  });
}
