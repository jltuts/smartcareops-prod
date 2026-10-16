import { Firestore } from '@google-cloud/firestore';
import { environmentConfig } from './environment.js';
import { specialtyCodes } from '../../shared/routing.js';
import { normalizeDoctorDisplayName } from '../../shared/doctor-display-name.js';

const allowedRoles = new Set(['patient', 'doctor', 'dispatcher', 'command-center', 'command_center']);
const cleanText = (value, max) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
export const editableProfileFields = Object.freeze(['firstName', 'middleName', 'lastName', 'birthday', 'addressLine1', 'addressLine2', 'cityMunicipality', 'provinceState', 'postalCode', 'country']);

export class ProfileValidationError extends Error {
  constructor(code = 'INVALID_PROFILE') { super(code); this.code = code; }
}

const namePattern = /^[\p{L}\p{M}][\p{L}\p{M} '\u2019-]*$/u;
const noControls = value => !/[\p{Cc}\p{Cf}]/u.test(value);
const requiredName = (value, key) => {
  const clean = cleanText(value, 100);
  if (!clean || !namePattern.test(clean)) throw new ProfileValidationError(`${key.toUpperCase()}_REQUIRED`);
  return clean;
};
const optionalName = value => {
  if (value === '' || value == null) return null;
  const clean = cleanText(value, 100);
  if (!clean || !namePattern.test(clean)) throw new ProfileValidationError('INVALID_MIDDLE_NAME');
  return clean;
};
const profileText = (value, max, key) => {
  if (value === '' || value == null) return null;
  const clean = cleanText(value, max);
  if (!clean || !noControls(clean)) throw new ProfileValidationError(`INVALID_${key.toUpperCase()}`);
  return clean;
};
const doctorApplicationValue = input => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['displayName', 'specialty'].includes(key))) throw new ProfileValidationError('INVALID_DOCTOR_APPLICATION');
  const displayName = normalizeDoctorDisplayName(input.displayName);
  if (!displayName) throw new ProfileValidationError('INVALID_DOCTOR_DISPLAY_NAME');
  if (!specialtyCodes.includes(input.specialty)) throw new ProfileValidationError('INVALID_SPECIALTY');
  return Object.freeze({ displayName, specialty: input.specialty });
};
const birthdayValue = value => {
  if (value === '' || value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ProfileValidationError('INVALID_BIRTHDAY');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value || value < '1900-01-01' || value > new Date().toISOString().slice(0, 10)) throw new ProfileValidationError('INVALID_BIRTHDAY');
  return value;
};

export function validateProfilePatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !editableProfileFields.includes(key))) throw new ProfileValidationError();
  const firstName = requiredName(input.firstName, 'firstName'), middleName = optionalName(input.middleName), lastName = requiredName(input.lastName, 'lastName');
  const address = {
    addressLine1: profileText(input.addressLine1, 200, 'addressLine1'), addressLine2: profileText(input.addressLine2, 200, 'addressLine2'),
    cityMunicipality: profileText(input.cityMunicipality, 120, 'cityMunicipality'), provinceState: profileText(input.provinceState, 120, 'provinceState'),
    postalCode: profileText(input.postalCode, 32, 'postalCode'), country: profileText(input.country, 100, 'country'),
  };
  if (Object.values(address).some(Boolean) && (!address.addressLine1 || !address.cityMunicipality || !address.provinceState || !address.country)) throw new ProfileValidationError('INCOMPLETE_ADDRESS');
  return Object.freeze({ firstName, middleName, lastName, displayName: [firstName, middleName, lastName].filter(Boolean).join(' '), birthday: birthdayValue(input.birthday), ...address });
}

function normalized(record) {
  if (!record || typeof record.uid !== 'string' || !['active', 'inactive', 'disabled'].includes(record.status)) return null;
  const specialties = verifiedDoctorSpecialties(record), verifiedDoctor = specialties.length > 0;
  const primarySpecialty = specialties.includes(record.specialty) ? record.specialty : specialties[0];
  const primaryVerification = verificationMap(record)[primarySpecialty];
  return Object.freeze({
    uid: record.uid,
    email: cleanText(record.email, 320),
    displayName: cleanText(record.displayName, 200),
    ...(verifiedDoctor ? { specialty: primarySpecialty, specialties: Object.freeze(specialties) } : {}),
    ...(record.doctorApplication && ['pending', 'approved', 'rejected'].includes(record.doctorApplication.status) && specialtyCodes.includes(record.doctorApplication.specialty) ? { doctorApplication: Object.freeze({
      status: record.doctorApplication.status, displayName: cleanText(record.doctorApplication.displayName, 100), specialty: record.doctorApplication.specialty,
      submittedAt: record.doctorApplication.submittedAt,
      version: Number.isSafeInteger(record.doctorApplication.version) ? record.doctorApplication.version : 1,
      ...(record.doctorApplication.reviewedAt ? { reviewedAt: record.doctorApplication.reviewedAt } : {}),
      ...(record.doctorApplication.reviewReceipt ? { reviewReceipt: Object.freeze({ ...record.doctorApplication.reviewReceipt }) } : {}),
    }) } : {}),
    ...(record.patientApplication && ['pending', 'approved', 'rejected'].includes(record.patientApplication.status) ? { patientApplication: Object.freeze({
      status: record.patientApplication.status, submittedAt: record.patientApplication.submittedAt,
      version: Number.isSafeInteger(record.patientApplication.version) ? record.patientApplication.version : 1,
      ...(record.patientApplication.reviewedAt ? { reviewedAt: record.patientApplication.reviewedAt } : {}),
      ...(record.patientApplication.reviewReceipt ? { reviewReceipt: Object.freeze({ ...record.patientApplication.reviewReceipt }) } : {}),
    }) } : {}),
    ...(verifiedDoctor ? { doctorVerification: Object.freeze({
      status: 'verified', specialty: primarySpecialty, displayName: cleanText(primaryVerification.displayName, 100), verifiedAt: primaryVerification.verifiedAt,
    }), doctorVerifications: Object.freeze(specialties.map(specialty => Object.freeze({
      status: 'verified', specialty, displayName: cleanText(verificationMap(record)[specialty].displayName, 100), verifiedAt: verificationMap(record)[specialty].verifiedAt,
    }))) } : {}),
    ...(cleanText(record.firstName, 100) ? { firstName: cleanText(record.firstName, 100) } : {}),
    ...(cleanText(record.middleName, 100) ? { middleName: cleanText(record.middleName, 100) } : {}),
    ...(cleanText(record.lastName, 100) ? { lastName: cleanText(record.lastName, 100) } : {}),
    ...Object.fromEntries(['birthday', 'addressLine1', 'addressLine2', 'cityMunicipality', 'provinceState', 'postalCode', 'country'].filter(key => cleanText(record[key], 200)).map(key => [key, cleanText(record[key], 200)])),
    roles: Object.freeze([...new Set(Array.isArray(record.roles) ? record.roles.filter(role => allowedRoles.has(role) && (role !== 'doctor' || verifiedDoctor)) : [])]),
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function newProfile(identity, now) {
  const at = new Date(now()).toISOString();
  const firstName = cleanText(identity.given_name, 100), lastName = cleanText(identity.family_name, 100);
  return { uid: identity.uid, email: cleanText(identity.email, 320), displayName: cleanText(identity.name, 200),
    ...(firstName ? { firstName } : {}), ...(lastName ? { lastName } : {}), roles: ['patient'], status: 'active', createdAt: at, updatedAt: at };
}

const safePatientIdentity = profile => {
  if (profile?.status !== 'active') return null;
  const fields = Object.fromEntries(['displayName', 'firstName', 'middleName', 'lastName'].filter(key => profile[key]).map(key => [key, profile[key]]));
  return Object.keys(fields).length ? Object.freeze(fields) : null;
};

const validDoctorVerification = (verification, specialty = verification?.specialty) => verification?.status === 'verified' && specialtyCodes.includes(specialty) &&
  verification.specialty === specialty && typeof verification.displayName === 'string' && !!verification.displayName.trim() &&
  typeof verification.verifiedAt === 'string' && !Number.isNaN(Date.parse(verification.verifiedAt)) &&
  typeof verification.verifiedBy === 'string' && !!verification.verifiedBy.trim();
const verificationMap = profile => {
  const values = {};
  if (profile?.doctorVerifications && typeof profile.doctorVerifications === 'object' && !Array.isArray(profile.doctorVerifications)) {
    for (const [specialty, verification] of Object.entries(profile.doctorVerifications)) {
      const blocked = profile.doctorApplication?.specialty === specialty && profile.doctorApplication?.status !== 'approved';
      if (!blocked && validDoctorVerification(verification, specialty)) values[specialty] = verification;
    }
  }
  const legacy = profile?.doctorVerification, application = profile?.doctorApplication;
  const legacyBlocked = application && application.status !== 'approved' && (!application.specialty || application.specialty === legacy?.specialty);
  if (!legacyBlocked && profile?.specialty === legacy?.specialty && validDoctorVerification(legacy)) values[legacy.specialty] ||= legacy;
  return values;
};
const verifiedDoctorSpecialties = profile => profile?.status === 'active' && profile.roles?.includes('doctor') ? specialtyCodes.filter(code => verificationMap(profile)[code]) : [];
const approvedDoctor = profile => verifiedDoctorSpecialties(profile).length > 0;
const approvedDoctorFields = profile => ({ uid: profile.uid, email: cleanText(profile.email, 320),
  displayName: verificationMap(profile)[verifiedDoctorSpecialties(profile)[0]].displayName,
  specialty: verifiedDoctorSpecialties(profile)[0], specialties: verifiedDoctorSpecialties(profile),
  status: 'approved', approvedAt: Math.max(...verifiedDoctorSpecialties(profile).map(specialty => Date.parse(verificationMap(profile)[specialty].verifiedAt))) ?
    new Date(Math.max(...verifiedDoctorSpecialties(profile).map(specialty => Date.parse(verificationMap(profile)[specialty].verifiedAt)))).toISOString() : null });
const newestApprovedFirst = (a, b) => b.approvedAt.localeCompare(a.approvedAt) || a.uid.localeCompare(b.uid);
const validateSpecialtyRemoval = ({ specialty, reviewedBy, expectedSpecialties, idempotencyKey }) => {
  if (!specialtyCodes.includes(specialty) || typeof reviewedBy !== 'string' || !reviewedBy.trim() || reviewedBy.length > 200 ||
      !Array.isArray(expectedSpecialties) || expectedSpecialties.some(value => !specialtyCodes.includes(value)) || new Set(expectedSpecialties).size !== expectedSpecialties.length ||
      typeof idempotencyKey !== 'string' || !idempotencyKey) throw new ProfileValidationError('INVALID_DOCTOR_SPECIALTY_REMOVAL');
};
const sameSpecialties = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const removedDoctorSpecialtyProfile = (profile, specialty, receipt, at) => {
  const verifications = { ...verificationMap(profile) }; delete verifications[specialty];
  const remainingSpecialties = specialtyCodes.filter(code => verifications[code]);
  const next = { ...profile, doctorVerifications: verifications,
    doctorSpecialtyRemovalReceipts: { ...(profile.doctorSpecialtyRemovalReceipts || {}), [specialty]: receipt }, updatedAt: at };
  if (remainingSpecialties.length) {
    next.specialty = remainingSpecialties[0]; next.doctorVerification = verifications[remainingSpecialties[0]];
  } else {
    delete next.specialty; delete next.doctorVerification; next.roles = (profile.roles || []).filter(role => role !== 'doctor');
  }
  return { next, remainingSpecialties };
};

export function createMemoryUserProfileStore(records = new Map(), { now = Date.now, patientAccessMode = 'approved_only' } = {}) {
  let patientAccessPolicy = { mode: patientAccessMode, version: 1, updatedAt: null, receipt: null };
  const adminRateLimits = new Map();
  const submit = async (uid, input) => {
    const value = doctorApplicationValue(input), existing = records.get(uid);
    if (!existing || existing.status !== 'active') throw new ProfileValidationError('PROFILE_NOT_ACTIVE');
    if (verifiedDoctorSpecialties(existing).includes(value.specialty)) throw new ProfileValidationError('DOCTOR_ACCESS_ALREADY_GRANTED');
    if (existing.doctorApplication?.status === 'pending' && existing.doctorApplication.displayName === value.displayName && existing.doctorApplication.specialty === value.specialty) return normalized(structuredClone(existing));
    const at = new Date(now()).toISOString();
    const next = { ...existing, doctorApplication: { ...value, status: 'pending', submittedAt: at, version: (existing.doctorApplication?.version || 0) + 1 }, updatedAt: at };
    records.set(uid, next); return normalized(structuredClone(next));
  };
  const approve = async (uid, { displayName, specialty, verifiedBy }) => {
    const profile = records.get(uid);
    if (!profile || !specialtyCodes.includes(specialty) || typeof verifiedBy !== 'string' || !verifiedBy.trim() || verifiedBy.length > 200) throw new ProfileValidationError('INVALID_DOCTOR_VERIFICATION');
    const verifiedName = normalizeDoctorDisplayName(displayName);
    if (!verifiedName) throw new ProfileValidationError('INVALID_DOCTOR_DISPLAY_NAME');
    if (verifiedDoctorSpecialties(profile).includes(specialty) && verificationMap(profile)[specialty].displayName === verifiedName) return normalized(structuredClone(profile));
    if (profile.doctorApplication?.status !== 'pending' && !profile.roles?.includes('doctor')) throw new ProfileValidationError('DOCTOR_APPLICATION_NOT_PENDING');
    const at = new Date(now()).toISOString(), verification = { status: 'verified', specialty, displayName: verifiedName, verifiedAt: at, verifiedBy: verifiedBy.trim() };
    const alreadyDoctor = approvedDoctor(profile), next = { ...profile, displayName: verifiedName, specialty: alreadyDoctor ? profile.specialty : specialty,
      doctorVerification: alreadyDoctor ? profile.doctorVerification : verification,
      doctorVerifications: { ...verificationMap(profile), [specialty]: verification },
      ...(profile.doctorApplication?.status === 'pending' ? { doctorApplication: { ...profile.doctorApplication, status: 'approved' } } : {}),
      roles: [...new Set([...(profile.roles || []), 'doctor'])], updatedAt: at };
    records.set(uid, next); return normalized(structuredClone(next));
  };
  const pendingDoctorApplications = () => [...records.values()]
    .filter(profile => profile.status === 'active' && profile.doctorApplication?.status === 'pending')
    .map(profile => ({ uid: profile.uid, email: cleanText(profile.email, 320), doctorApplication: structuredClone(profile.doctorApplication) }))
    .sort((a, b) => String(a.doctorApplication.submittedAt).localeCompare(String(b.doctorApplication.submittedAt)) || a.uid.localeCompare(b.uid));
  const page = (values, options) => {
    if (!options) return values;
    const limit = options.limit, cursorIndex = options.cursor ? values.findIndex(value => value.uid === options.cursor) : -1;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || options.cursor && cursorIndex < 0) throw new ProfileValidationError('INVALID_ADMIN_QUERY');
    const start = options.cursor ? cursorIndex + 1 : 0;
    const pageRecords = values.slice(start, start + limit), nextCursor = start + limit < values.length ? pageRecords.at(-1)?.uid || null : null;
    return { records: pageRecords, nextCursor };
  };
  const listPendingDoctorApplications = async options => page(pendingDoctorApplications(), options);
  const listApprovedDoctors = async options => page([...records.values()].filter(approvedDoctor).map(approvedDoctorFields).sort(newestApprovedFirst), options);
  const reviewDoctorApplication = async (uid, { decision, reviewedBy, independentlyVerified = false, expectedVersion, idempotencyKey } = {}) => {
    const profile = records.get(uid);
    const prior = profile?.doctorApplication?.reviewReceipt;
    if (prior && idempotencyKey && prior.idempotencyKey === idempotencyKey && prior.decision === decision) return normalized(structuredClone(profile));
    if (!profile || profile.status !== 'active' || profile.doctorApplication?.status !== 'pending') throw new ProfileValidationError(prior && idempotencyKey ? 'DOCTOR_APPLICATION_CONFLICT' : 'DOCTOR_APPLICATION_NOT_PENDING');
    if (!['approved', 'rejected'].includes(decision) || typeof reviewedBy !== 'string' || !reviewedBy.trim() || reviewedBy.length > 200 || (decision === 'approved' && independentlyVerified !== true)) throw new ProfileValidationError('INVALID_DOCTOR_REVIEW');
    if (expectedVersion !== undefined && expectedVersion !== (profile.doctorApplication.version || 1)) throw new ProfileValidationError('DOCTOR_APPLICATION_STALE');
    const version = profile.doctorApplication.version || 1, at = new Date(now()).toISOString();
    const receipt = { receiptId: `doctor-${uid}-${version}-${decision}`, idempotencyKey, decision, applicationVersion: version, reviewedAt: at };
    const application = { ...profile.doctorApplication, version, status: decision, reviewedAt: at, reviewedBy: reviewedBy.trim(), reviewReceipt: receipt };
    const verification = { status: 'verified', specialty: application.specialty, displayName: application.displayName, verifiedAt: at, verifiedBy: reviewedBy.trim() };
    const alreadyDoctor = approvedDoctor(profile);
    const next = decision === 'approved'
      ? { ...profile, displayName: application.displayName, specialty: alreadyDoctor ? profile.specialty : application.specialty,
        doctorVerification: alreadyDoctor ? profile.doctorVerification : verification,
        doctorVerifications: { ...verificationMap(profile), [application.specialty]: verification },
        doctorApplication: application, roles: [...new Set([...(profile.roles || []), 'doctor'])], updatedAt: at }
      : { ...profile, doctorApplication: application, updatedAt: at };
    records.set(uid, next); return normalized(structuredClone(next));
  };
  const removeDoctorSpecialty = async (uid, input = {}) => {
    validateSpecialtyRemoval(input); const { specialty, reviewedBy, expectedSpecialties, idempotencyKey } = input;
    const profile = records.get(uid), prior = profile?.doctorSpecialtyRemovalReceipts?.[specialty];
    if (prior?.idempotencyKey === idempotencyKey) return { profile: normalized(structuredClone(profile)), receipt: structuredClone(prior) };
    if (!profile || profile.status !== 'active' || !verifiedDoctorSpecialties(profile).includes(specialty)) throw new ProfileValidationError('DOCTOR_SPECIALTY_NOT_VERIFIED');
    const current = verifiedDoctorSpecialties(profile);
    if (!sameSpecialties(current, expectedSpecialties)) throw new ProfileValidationError('DOCTOR_SPECIALTY_STALE');
    const removedAt = new Date(now()).toISOString(), remainingSpecialties = current.filter(value => value !== specialty);
    const receipt = { receiptId: `doctor-specialty-${uid}-${specialty}-${Date.parse(removedAt)}`, idempotencyKey, specialty,
      removedAt, removedBy: reviewedBy.trim(), remainingSpecialties };
    const result = removedDoctorSpecialtyProfile(profile, specialty, receipt, removedAt);
    records.set(uid, result.next); return { profile: normalized(structuredClone(result.next)), receipt: structuredClone(receipt) };
  };
  const submitPatientApplication = async uid => {
    const profile = records.get(uid); if (!profile || profile.status !== 'active') throw new ProfileValidationError('PROFILE_NOT_ACTIVE');
    if (profile.patientApplication?.status === 'approved' || profile.patientApplication?.status === 'pending') return normalized(structuredClone(profile));
    const at = new Date(now()).toISOString();
    const next = { ...profile, patientApplication: { status: 'pending', submittedAt: at, version: (profile.patientApplication?.version || 0) + 1 }, updatedAt: at };
    records.set(uid, next); return normalized(structuredClone(next));
  };
  const pendingPatientApplications = () => [...records.values()]
    .filter(profile => profile.status === 'active' && profile.patientApplication?.status === 'pending')
    .map(profile => ({ uid: profile.uid, email: cleanText(profile.email, 320), displayName: cleanText(profile.displayName, 200), patientApplication: structuredClone(profile.patientApplication) }))
    .sort((a, b) => String(a.patientApplication.submittedAt).localeCompare(String(b.patientApplication.submittedAt)) || a.uid.localeCompare(b.uid));
  const listPendingPatientApplications = async options => page(pendingPatientApplications(), options);
  const reviewPatientApplication = async (uid, { decision, reviewedBy, expectedVersion, idempotencyKey } = {}) => {
    const profile = records.get(uid);
    const prior = profile?.patientApplication?.reviewReceipt;
    if (prior && idempotencyKey && prior.idempotencyKey === idempotencyKey && prior.decision === decision) return normalized(structuredClone(profile));
    if (!profile || profile.status !== 'active' || profile.patientApplication?.status !== 'pending') throw new ProfileValidationError(prior && idempotencyKey ? 'PATIENT_APPLICATION_CONFLICT' : 'PATIENT_APPLICATION_NOT_PENDING');
    if (!['approved', 'rejected'].includes(decision) || typeof reviewedBy !== 'string' || !reviewedBy.trim() || reviewedBy.length > 200) throw new ProfileValidationError('INVALID_PATIENT_REVIEW');
    if (expectedVersion !== undefined && expectedVersion !== (profile.patientApplication.version || 1)) throw new ProfileValidationError('PATIENT_APPLICATION_STALE');
    const version = profile.patientApplication.version || 1, at = new Date(now()).toISOString();
    const receipt = { receiptId: `patient-${uid}-${version}-${decision}`, idempotencyKey, decision, applicationVersion: version, reviewedAt: at };
    const application = { ...profile.patientApplication, version, status: decision, reviewedAt: at, reviewedBy: reviewedBy.trim(), reviewReceipt: receipt };
    const next = { ...profile, patientApplication: application, roles: decision === 'approved' ? [...new Set([...(profile.roles || []), 'patient'])] : (profile.roles || []).filter(role => role !== 'patient'), updatedAt: at };
    records.set(uid, next); return normalized(structuredClone(next));
  };
  return {
    async provisionPatient(identity) {
      if (!records.has(identity.uid)) records.set(identity.uid, newProfile(identity, now));
      return normalized(structuredClone(records.get(identity.uid)));
    },
    async getPatientIdentity(uid) { return safePatientIdentity(normalized(structuredClone(records.get(uid)))); },
    async getOwnProfile(uid) { return normalized(structuredClone(records.get(uid))); },
    submitDoctorApplication: submit,
    approveDoctorApplication: approve,
    listPendingDoctorApplications,
    listApprovedDoctors,
    reviewDoctorApplication,
    removeDoctorSpecialty,
    async getPatientAccessMode() { return patientAccessPolicy.mode; },
    async getPatientAccessPolicy() { return structuredClone(patientAccessPolicy); },
    async setPatientAccessMode(mode, { reviewedBy, expectedVersion, idempotencyKey, confirmed } = {}) {
      if (!['open', 'approved_only'].includes(mode) || !reviewedBy || confirmed === false) throw new ProfileValidationError('INVALID_PATIENT_ACCESS_MODE');
      if (idempotencyKey && patientAccessPolicy.receipt?.idempotencyKey === idempotencyKey && patientAccessPolicy.receipt.mode === mode) return structuredClone(patientAccessPolicy);
      if (expectedVersion !== undefined && expectedVersion !== patientAccessPolicy.version) throw new ProfileValidationError('PATIENT_ACCESS_POLICY_STALE');
      const updatedAt = new Date(now()).toISOString(), version = patientAccessPolicy.version + 1;
      patientAccessPolicy = { mode, version, updatedAt, receipt: { receiptId: `patient-access-${version}`, idempotencyKey, mode, previousVersion: patientAccessPolicy.version, updatedAt } };
      return structuredClone(patientAccessPolicy);
    },
    submitPatientApplication,
    listPendingPatientApplications,
    reviewPatientApplication,
    async consumeAdminRateLimit(uid, { limit, windowMs }) {
      const current = now(), state = adminRateLimits.get(uid);
      if (!state || current - state.windowStartedAt >= windowMs) { adminRateLimits.set(uid, { windowStartedAt: current, count: 1 }); return true; }
      if (state.count >= limit) return false;
      state.count += 1; return true;
    },
    async listVerifiedSpecialties() { return new Set([...records.values()].flatMap(verifiedDoctorSpecialties)); },
    async updateOwnProfile(uid, input) {
      const existing = records.get(uid); if (!existing) return null;
      const patch = validateProfilePatch(input), updatedAt = new Date(now()).toISOString();
      const next = { ...existing, ...patch, updatedAt }; records.set(uid, next); return normalized(structuredClone(next));
    },
    async close() {},
  };
}

export function createFirestoreUserProfileStore(db, { now = Date.now } = {}) {
  const collection = db.collection('userProfiles');
  const accessSettings = db.collection('adminSettings').doc('patientAccess');
  const accessAudit = key => db.collection('adminAudit').doc(`patient-access-${key}`);
  const adminRateLimit = uid => db.collection('adminRateLimits').doc(uid);
  const submitDoctorApplication = async (uid, input) => {
    const value = doctorApplicationValue(input), ref = collection.doc(uid);
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref); if (!snapshot.exists || snapshot.data().status !== 'active') throw new ProfileValidationError('PROFILE_NOT_ACTIVE');
      const profile = snapshot.data();
      if (verifiedDoctorSpecialties(profile).includes(value.specialty)) throw new ProfileValidationError('DOCTOR_ACCESS_ALREADY_GRANTED');
      if (profile.doctorApplication?.status === 'pending' && profile.doctorApplication.displayName === value.displayName && profile.doctorApplication.specialty === value.specialty) return normalized(profile);
      const at = new Date(now()).toISOString(), next = { ...profile, doctorApplication: { ...value, status: 'pending', submittedAt: at, version: (profile.doctorApplication?.version || 0) + 1 }, updatedAt: at };
      transaction.set(ref, next); return normalized(next);
    });
  };
  const approveDoctorApplication = async (uid, { displayName, specialty, verifiedBy }) => {
    if (!specialtyCodes.includes(specialty) || typeof verifiedBy !== 'string' || !verifiedBy.trim() || verifiedBy.length > 200) throw new ProfileValidationError('INVALID_DOCTOR_VERIFICATION');
    const verifiedName = normalizeDoctorDisplayName(displayName), ref = collection.doc(uid);
    if (!verifiedName) throw new ProfileValidationError('INVALID_DOCTOR_DISPLAY_NAME');
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref); if (!snapshot.exists) throw new ProfileValidationError('PROFILE_NOT_FOUND');
      const profile = snapshot.data();
      if (verifiedDoctorSpecialties(profile).includes(specialty) && verificationMap(profile)[specialty].displayName === verifiedName) return normalized(profile);
      if (profile.status !== 'active' || profile.doctorApplication?.status !== 'pending' && !profile.roles?.includes('doctor')) throw new ProfileValidationError('DOCTOR_APPLICATION_NOT_PENDING');
      const at = new Date(now()).toISOString(), verification = { status: 'verified', specialty, displayName: verifiedName, verifiedAt: at, verifiedBy: verifiedBy.trim() };
      const alreadyDoctor = approvedDoctor(profile), next = { ...profile, displayName: verifiedName, specialty: alreadyDoctor ? profile.specialty : specialty,
        doctorVerification: alreadyDoctor ? profile.doctorVerification : verification,
        doctorVerifications: { ...verificationMap(profile), [specialty]: verification },
        ...(profile.doctorApplication?.status === 'pending' ? { doctorApplication: { ...profile.doctorApplication, status: 'approved' } } : {}),
        roles: [...new Set([...(profile.roles || []), 'doctor'])], updatedAt: at };
      transaction.set(ref, next); return normalized(next);
    });
  };
  const paginate = (values, options) => {
    if (!options) return values;
    const cursorIndex = options.cursor ? values.findIndex(value => value.uid === options.cursor) : -1;
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50 || options.cursor && cursorIndex < 0) throw new ProfileValidationError('INVALID_ADMIN_QUERY');
    const start = options.cursor ? cursorIndex + 1 : 0;
    const records = values.slice(start, start + options.limit);
    return { records, nextCursor: start + options.limit < values.length ? records.at(-1)?.uid || null : null };
  };
  const listPendingDoctorApplications = async options => {
    const snapshot = await collection.where('doctorApplication.status', '==', 'pending').get();
    const values = snapshot.docs.map(item => item.data()).filter(profile => profile.status === 'active' && profile.doctorApplication?.status === 'pending')
      .map(profile => ({ uid: profile.uid, email: cleanText(profile.email, 320), doctorApplication: structuredClone(profile.doctorApplication) }))
      .sort((a, b) => String(a.doctorApplication.submittedAt).localeCompare(String(b.doctorApplication.submittedAt)) || a.uid.localeCompare(b.uid));
    return paginate(values, options);
  };
  const listApprovedDoctors = async options => {
    const snapshot = await collection.where('roles', 'array-contains', 'doctor').get();
    const values = snapshot.docs.map(item => item.data()).filter(approvedDoctor).map(approvedDoctorFields).sort(newestApprovedFirst);
    return paginate(values, options);
  };
  const reviewDoctorApplication = async (uid, { decision, reviewedBy, independentlyVerified = false, expectedVersion, idempotencyKey } = {}) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !['approved', 'rejected'].includes(decision) || typeof reviewedBy !== 'string' || !reviewedBy.trim() || reviewedBy.length > 200 || (decision === 'approved' && independentlyVerified !== true)) throw new ProfileValidationError('INVALID_DOCTOR_REVIEW');
    const ref = collection.doc(uid);
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref); if (!snapshot.exists) throw new ProfileValidationError('DOCTOR_APPLICATION_NOT_PENDING');
      const profile = snapshot.data(), pending = profile.doctorApplication, prior = pending?.reviewReceipt;
      if (prior && idempotencyKey && prior.idempotencyKey === idempotencyKey && prior.decision === decision) return normalized(profile);
      if (profile.status !== 'active' || pending?.status !== 'pending' || !specialtyCodes.includes(pending.specialty)) throw new ProfileValidationError(prior && idempotencyKey ? 'DOCTOR_APPLICATION_CONFLICT' : 'DOCTOR_APPLICATION_NOT_PENDING');
      const version = pending.version || 1;
      if (expectedVersion !== undefined && expectedVersion !== version) throw new ProfileValidationError('DOCTOR_APPLICATION_STALE');
      const at = new Date(now()).toISOString(), receipt = { receiptId: `doctor-${uid}-${version}-${decision}`, idempotencyKey, decision, applicationVersion: version, reviewedAt: at };
      const application = { ...pending, version, status: decision, reviewedAt: at, reviewedBy: reviewedBy.trim(), reviewReceipt: receipt };
      const verification = { status: 'verified', specialty: pending.specialty, displayName: pending.displayName, verifiedAt: at, verifiedBy: reviewedBy.trim() };
      const alreadyDoctor = approvedDoctor(profile);
      const next = decision === 'approved'
        ? { ...profile, displayName: pending.displayName, specialty: alreadyDoctor ? profile.specialty : pending.specialty,
          doctorVerification: alreadyDoctor ? profile.doctorVerification : verification,
          doctorVerifications: { ...verificationMap(profile), [pending.specialty]: verification },
          doctorApplication: application, roles: [...new Set([...(profile.roles || []), 'doctor'])], updatedAt: at }
        : { ...profile, doctorApplication: application, updatedAt: at };
      transaction.set(ref, next); return normalized(next);
    });
  };
  const removeDoctorSpecialty = async (uid, input = {}) => {
    validateSpecialtyRemoval(input); const { specialty, reviewedBy, expectedSpecialties, idempotencyKey } = input;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new ProfileValidationError('INVALID_DOCTOR_SPECIALTY_REMOVAL');
    const ref = collection.doc(uid);
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new ProfileValidationError('DOCTOR_SPECIALTY_NOT_VERIFIED');
      const profile = snapshot.data(), prior = profile.doctorSpecialtyRemovalReceipts?.[specialty];
      if (prior?.idempotencyKey === idempotencyKey) return { profile: normalized(profile), receipt: structuredClone(prior) };
      const current = verifiedDoctorSpecialties(profile);
      if (profile.status !== 'active' || !current.includes(specialty)) throw new ProfileValidationError('DOCTOR_SPECIALTY_NOT_VERIFIED');
      if (!sameSpecialties(current, expectedSpecialties)) throw new ProfileValidationError('DOCTOR_SPECIALTY_STALE');
      const removedAt = new Date(now()).toISOString(), remainingSpecialties = current.filter(value => value !== specialty);
      const receipt = { receiptId: `doctor-specialty-${uid}-${specialty}-${Date.parse(removedAt)}`, idempotencyKey, specialty,
        removedAt, removedBy: reviewedBy.trim(), remainingSpecialties };
      const result = removedDoctorSpecialtyProfile(profile, specialty, receipt, removedAt);
      transaction.set(ref, result.next); return { profile: normalized(result.next), receipt };
    });
  };
  const submitPatientApplication = async uid => {
    const ref = collection.doc(uid);
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref); if (!snapshot.exists || snapshot.data().status !== 'active') throw new ProfileValidationError('PROFILE_NOT_ACTIVE');
      const profile = snapshot.data();
      if (profile.patientApplication?.status === 'approved' || profile.patientApplication?.status === 'pending') return normalized(profile);
      const at = new Date(now()).toISOString(), next = { ...profile, patientApplication: { status: 'pending', submittedAt: at, version: (profile.patientApplication?.version || 0) + 1 }, updatedAt: at };
      transaction.set(ref, next); return normalized(next);
    });
  };
  const listPendingPatientApplications = async options => {
    const snapshot = await collection.where('patientApplication.status', '==', 'pending').get();
    const values = snapshot.docs.map(item => item.data()).filter(profile => profile.status === 'active' && profile.patientApplication?.status === 'pending')
      .map(profile => ({ uid: profile.uid, email: cleanText(profile.email, 320), displayName: cleanText(profile.displayName, 200), patientApplication: structuredClone(profile.patientApplication) }))
      .sort((a, b) => String(a.patientApplication.submittedAt).localeCompare(String(b.patientApplication.submittedAt)) || a.uid.localeCompare(b.uid));
    return paginate(values, options);
  };
  const reviewPatientApplication = async (uid, { decision, reviewedBy, expectedVersion, idempotencyKey } = {}) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !['approved', 'rejected'].includes(decision) || typeof reviewedBy !== 'string' || !reviewedBy.trim() || reviewedBy.length > 200) throw new ProfileValidationError('INVALID_PATIENT_REVIEW');
    const ref = collection.doc(uid);
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref); if (!snapshot.exists) throw new ProfileValidationError('PATIENT_APPLICATION_NOT_PENDING');
      const profile = snapshot.data(), pending = profile.patientApplication, prior = pending?.reviewReceipt;
      if (prior && idempotencyKey && prior.idempotencyKey === idempotencyKey && prior.decision === decision) return normalized(profile);
      if (profile.status !== 'active' || pending?.status !== 'pending') throw new ProfileValidationError(prior && idempotencyKey ? 'PATIENT_APPLICATION_CONFLICT' : 'PATIENT_APPLICATION_NOT_PENDING');
      const version = pending.version || 1;
      if (expectedVersion !== undefined && expectedVersion !== version) throw new ProfileValidationError('PATIENT_APPLICATION_STALE');
      const at = new Date(now()).toISOString(), receipt = { receiptId: `patient-${uid}-${version}-${decision}`, idempotencyKey, decision, applicationVersion: version, reviewedAt: at };
      const application = { ...pending, version, status: decision, reviewedAt: at, reviewedBy: reviewedBy.trim(), reviewReceipt: receipt };
      const roles = decision === 'approved' ? [...new Set([...(profile.roles || []), 'patient'])] : (profile.roles || []).filter(role => role !== 'patient');
      const next = { ...profile, patientApplication: application, roles, updatedAt: at };
      transaction.set(ref, next); return normalized(next);
    });
  };
  const getPatientAccessPolicy = async () => {
    const snapshot = await accessSettings.get();
    const value = snapshot.exists ? snapshot.data() : {};
    return { mode: value.mode === 'open' ? 'open' : 'approved_only', version: Number.isSafeInteger(value.version) ? value.version : 1,
      updatedAt: value.updatedAt || null, receipt: value.receipt || null };
  };
  const getPatientAccessMode = async () => (await getPatientAccessPolicy()).mode;
  const setPatientAccessMode = async (mode, { reviewedBy, expectedVersion, idempotencyKey, confirmed } = {}) => {
    if (!['open', 'approved_only'].includes(mode) || typeof reviewedBy !== 'string' || !reviewedBy.trim() || confirmed === false) throw new ProfileValidationError('INVALID_PATIENT_ACCESS_MODE');
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(accessSettings), current = snapshot.exists ? snapshot.data() : {};
      const version = Number.isSafeInteger(current.version) ? current.version : 1;
      if (idempotencyKey && current.receipt?.idempotencyKey === idempotencyKey && current.receipt.mode === mode) return { mode: current.mode, version, updatedAt: current.updatedAt, receipt: current.receipt };
      if (expectedVersion !== undefined && expectedVersion !== version) throw new ProfileValidationError('PATIENT_ACCESS_POLICY_STALE');
      const updatedAt = new Date(now()).toISOString(), nextVersion = version + 1;
      const receipt = { receiptId: `patient-access-${nextVersion}`, idempotencyKey, mode, previousVersion: version, updatedAt };
      transaction.set(accessSettings, { mode, version: nextVersion, updatedAt, updatedBy: reviewedBy.trim(), receipt });
      if (idempotencyKey) transaction.set(accessAudit(idempotencyKey), { type: 'patient_access_policy', initiatedBy: reviewedBy.trim(), ...receipt });
      return { mode, version: nextVersion, updatedAt, receipt };
    });
  };
  return {
    provisionPatient(identity) {
      const ref = collection.doc(identity.uid);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) {
          const profile = newProfile(identity, now);
          transaction.create(ref, profile);
          return normalized(profile);
        }
        return normalized(snapshot.data());
      });
    },
    async getPatientIdentity(uid) {
      const snapshot = await collection.doc(uid).get();
      return snapshot.exists ? safePatientIdentity(normalized(snapshot.data())) : null;
    },
    async getOwnProfile(uid) {
      const snapshot = await collection.doc(uid).get(); return snapshot.exists ? normalized(snapshot.data()) : null;
    },
    submitDoctorApplication,
    approveDoctorApplication,
    listPendingDoctorApplications,
    listApprovedDoctors,
    reviewDoctorApplication,
    removeDoctorSpecialty,
    getPatientAccessMode,
    getPatientAccessPolicy,
    setPatientAccessMode,
    submitPatientApplication,
    listPendingPatientApplications,
    reviewPatientApplication,
    consumeAdminRateLimit(uid, { limit, windowMs }) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1000) throw new ProfileValidationError('INVALID_ADMIN_RATE_LIMIT');
      return db.runTransaction(async transaction => {
        const ref = adminRateLimit(uid), snapshot = await transaction.get(ref), current = now(), value = snapshot.exists ? snapshot.data() : null;
        if (!value || !Number.isFinite(value.windowStartedAt) || current - value.windowStartedAt >= windowMs) { transaction.set(ref, { windowStartedAt: current, count: 1 }); return true; }
        if (!Number.isSafeInteger(value.count) || value.count >= limit) return false;
        transaction.set(ref, { windowStartedAt: value.windowStartedAt, count: value.count + 1 }); return true;
      });
    },
    async listVerifiedSpecialties() {
      const snapshot = await collection.where('roles', 'array-contains', 'doctor').get();
      return new Set(snapshot.docs.map(item => item.data()).flatMap(verifiedDoctorSpecialties));
    },
    updateOwnProfile(uid, input) {
      const patch = validateProfilePatch(input), ref = collection.doc(uid);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref); if (!snapshot.exists) return null;
        const next = { ...snapshot.data(), ...patch, updatedAt: new Date(now()).toISOString() };
        transaction.set(ref, next); return normalized(next);
      });
    },
    close: () => db.terminate(),
  };
}

export function createConfiguredUserProfileStore(env = process.env) {
  const config = environmentConfig(env);
  if (env.CASE_STORE === 'memory' || !config.projectId) return createMemoryUserProfileStore();
  return createFirestoreUserProfileStore(new Firestore({ projectId: config.projectId, databaseId: config.database }));
}
