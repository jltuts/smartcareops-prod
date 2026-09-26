import { createHash } from 'node:crypto';
export const handoffTool = 'submit_hospital_case';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class HospitalError extends Error { constructor(code = 'HOSPITAL_UNAVAILABLE') { super('Hospital action requires clinical review.'); this.code = code; } }
export const check = (ok, code = 'INVALID_HOSPITAL_REQUEST') => { if (!ok) throw new HospitalError(code); };
export const validKey = key => typeof key === 'string' && /^handoff_[a-f0-9]{64}$/.test(key);
export function validateHospitalArguments(args) {
  check(args && typeof args === 'object' && Object.keys(args).length === 1 && /^HOSP-00[1-3]$/.test(args.hospitalId));
}
export function verifyReceipt(receipt, request) {
  check(receipt?.verified === true && /^DEMO-[A-F0-9]{8}$/.test(receipt.receiptId) && receipt.caseId === request.caseId && receipt.hospitalId === request.hospitalId && receipt.idempotencyKey === request.idempotencyKey && receipt.payloadDigest === hash(request.payload), 'INVALID_HOSPITAL_RECEIPT');
  return { receiptId: receipt.receiptId, caseId: receipt.caseId, hospitalId: receipt.hospitalId, idempotencyKey: receipt.idempotencyKey, payloadDigest: receipt.payloadDigest, verified: true };
}
