import { Firestore } from '@google-cloud/firestore';
import { environmentConfig } from './environment.js';

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
  return Object.freeze({
    uid: record.uid,
    email: cleanText(record.email, 320),
    displayName: cleanText(record.displayName, 200),
    ...(cleanText(record.firstName, 100) ? { firstName: cleanText(record.firstName, 100) } : {}),
    ...(cleanText(record.middleName, 100) ? { middleName: cleanText(record.middleName, 100) } : {}),
    ...(cleanText(record.lastName, 100) ? { lastName: cleanText(record.lastName, 100) } : {}),
    ...Object.fromEntries(['birthday', 'addressLine1', 'addressLine2', 'cityMunicipality', 'provinceState', 'postalCode', 'country'].filter(key => cleanText(record[key], 200)).map(key => [key, cleanText(record[key], 200)])),
    roles: Object.freeze([...new Set(Array.isArray(record.roles) ? record.roles.filter(role => allowedRoles.has(role)) : [])]),
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

export function createMemoryUserProfileStore(records = new Map(), { now = Date.now } = {}) {
  return {
    async provisionPatient(identity) {
      if (!records.has(identity.uid)) records.set(identity.uid, newProfile(identity, now));
      return normalized(structuredClone(records.get(identity.uid)));
    },
    async getPatientIdentity(uid) { return safePatientIdentity(normalized(structuredClone(records.get(uid)))); },
    async getOwnProfile(uid) { return normalized(structuredClone(records.get(uid))); },
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
