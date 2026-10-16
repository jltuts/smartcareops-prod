export function createOperationsEventOrchestrator(service) {
  if (!service?.enroll || !service?.requestRun || !service?.tick || !service?.view) throw new Error('OPERATIONS_ORCHESTRATOR_CONFIGURATION_REQUIRED');
  let tail = Promise.resolve();
  const process = async (envelope, delivery = {}) => {
    const capacityChanged = envelope.eventType === 'hospital.capacity.changed' && envelope.subjectType === 'hospital';
    if (!capacityChanged) return { handled: false };
    if (service.recordTrigger) await service.recordTrigger({ outboxId: envelope.outboxId, eventType: envelope.eventType,
      eventFamily: envelope.eventFamily, subjectType: envelope.subjectType, occurredAt: envelope.occurredAt });
    const before = await service.view();
    if (before.meta.ready) return { handled: true };
    if (before.meta.lastError) {
      const attempt = Number.isSafeInteger(delivery.deliveryAttempt) && delivery.deliveryAttempt > 0 ? delivery.deliveryAttempt : 1;
      await service.requestRun(`event_${envelope.outboxId.slice(0, 24)}_${attempt}`);
    }
    await service.tick();
    const after = await service.view();
    if (!after.meta.ready) throw new Error('OPERATIONS_ORCHESTRATION_INCOMPLETE');
    return { handled: true };
  };
  return (envelope, delivery) => {
    const work = tail.then(() => process(envelope, delivery));
    tail = work.catch(() => {});
    return work;
  };
}
