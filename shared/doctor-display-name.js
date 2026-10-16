// Shared browser/server rule for the requested and verified Doctor display name.
// A period may end a word (such as Dr. or an initial), never form markup or a URL.
const token = String.raw`\p{L}[\p{L}\p{M}]*(?:['’\-]\p{L}[\p{L}\p{M}]*)*\.?`;
const doctorDisplayNamePattern = new RegExp(`^${token}(?: ${token})*$`, 'u');

export const doctorDisplayNameGuidance = 'Use 1–100 characters: letters (including accents), spaces, apostrophes, hyphens, and periods at word ends, for example Dr. Louie.';

export function normalizeDoctorDisplayName(value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const name = value.normalize('NFC').trim().replace(/ +/g, ' ');
  return name.length >= 1 && name.length <= 100 && doctorDisplayNamePattern.test(name) ? name : null;
}
