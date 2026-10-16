import { createHash } from 'node:crypto';

export function createFirestoreCaseNoticeStore(db, { collection = 'caseNotices' } = {}) {
  const notices = db.collection(collection);
  return {
    async record(notice) {
      const ref = notices.doc(notice.notificationId);
      const fingerprint = createHash('sha256').update(JSON.stringify(notice)).digest('hex');
      return db.runTransaction(async transaction => {
        const previous = await transaction.get(ref);
        if (previous.exists) {
          if (previous.data().fingerprint !== fingerprint) throw new Error('CASE_NOTICE_CONFLICT');
          return false;
        }
        transaction.create(ref, { ...notice, fingerprint });
        return true;
      });
    },
    async list({ recipientType, recipientUid, canAccessCase, limit = 50 }) {
      const snapshot = await notices.orderBy('createdAt', 'desc').limit(200).get();
      const selected = [];
      for (const doc of snapshot.docs) {
        const notice = doc.data();
        if (notice.recipientType !== recipientType || recipientType === 'patient' && notice.recipientUid !== recipientUid) continue;
        if (!await canAccessCase(notice.caseId, notice)) continue;
        const { fingerprint, recipientUid: hiddenUid, specialty, ...publicNotice } = notice;
        selected.push(publicNotice);
        if (selected.length >= limit) break;
      }
      return selected;
    },
  };
}
