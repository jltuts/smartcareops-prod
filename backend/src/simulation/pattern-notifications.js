import { check, hash } from '../notifications/contracts.js';

const definitions = Object.freeze({
  command_center: Object.freeze({
    recipientId: 'DEMO-COMMAND-CENTER',
    messageSummary: 'A possible synthetic respiratory cluster is active for operational review. This is an awareness signal, not a diagnosis, confirmed outbreak, or emergency.',
  }),
  doctor: Object.freeze({
    recipientId: 'DEMO-DOCTOR-REVIEW',
    messageSummary: 'A possible synthetic respiratory cluster is available for awareness. No clinical action is requested; this is not a diagnosis, confirmed outbreak, or emergency.',
  }),
  dispatcher: Object.freeze({
    recipientId: 'DEMO-DISPATCHER-001',
    messageSummary: 'A possible synthetic respiratory cluster is available for awareness. No acknowledgement, routing, or dispatch is requested; this is not a confirmed outbreak or emergency.',
  }),
});
const subject = 'Possible synthetic respiratory cluster';

const noticeId = (alertId, recipientType) => `NOTIF-${hash({ source: 'm18-pattern', alertId, recipientType }).slice(0, 32)}`;

export function syncPatternNotifications(previous, alert, timestamp) {
  const notifications = structuredClone(previous?.notifications || {});
  if (!alert) {
    const activeAlertId = previous?.alert?.alertId;
    for (const notification of Object.values(notifications)) {
      if (notification.alertId !== activeAlertId || notification.status === 'cleared') continue;
      Object.assign(notification, { status: 'cleared', updatedAt: timestamp, resolvedAt: timestamp });
    }
    return notifications;
  }
  for (const [recipientType, definition] of Object.entries(definitions)) {
    const notificationId = noticeId(alert.alertId, recipientType);
    const current = notifications[notificationId];
    notifications[notificationId] = {
      notificationId,
      scope: 'pattern',
      subjectId: alert.alertId,
      agentType: 'Pattern Intelligence',
      recipientType,
      recipientId: definition.recipientId,
      subject,
      messageSummary: definition.messageSummary,
      sourcePlanId: alert.alertId,
      sourceRevisionId: alert.alertId,
      sourceActionId: 'review_pattern_alert',
      status: recipientType === 'command_center' && alert.acknowledged ? 'acknowledged' : 'active',
      deliveryMode: 'in_app',
      simulation: true,
      alertId: alert.alertId,
      severity: alert.severity,
      createdAt: current?.createdAt || alert.generatedAt,
      updatedAt: timestamp,
      resolvedAt: null,
      receiptId: null,
    };
  }
  return notifications;
}

export function validatePatternNotification(notification) {
  const definition = definitions[notification?.recipientType];
  check(Boolean(definition) && notification.subject === subject && notification.messageSummary === definition.messageSummary, 'UNSAFE_NOTIFICATION_MESSAGE');
  check(notification.recipientId === definition.recipientId && notification.deliveryMode === 'in_app' && notification.simulation === true, 'NOTIFICATION_RECIPIENT_NOT_ALLOWED');
  check(notification.scope === 'pattern' && notification.sourceRevisionId === notification.alertId && ['active', 'acknowledged', 'cleared'].includes(notification.status), 'INVALID_NOTIFICATION');
  return notification;
}
