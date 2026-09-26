const clean = value => typeof value === 'string' && value.trim() ? value.trim() : null;

export function patientDisplayName(identity = {}, fallback = {}) {
  const firstName = clean(identity.firstName), lastName = clean(identity.lastName);
  if (firstName && lastName) {
    const middleName = clean(identity.middleName);
    const middleInitial = middleName ? [...middleName][0] : null;
    return `${lastName}, ${firstName}${middleInitial ? ` ${middleInitial.toUpperCase()}.` : ''}`;
  }
  return clean(identity.displayName) || clean(fallback.name) || clean(fallback.displayName) || clean(fallback.preferredName) || 'Name not reported';
}

export function patientSearchText(patient = {}) {
  return ['firstName', 'middleName', 'lastName', 'displayName', 'name', 'preferredName'].map(key => clean(patient[key])).filter(Boolean).concat(patientDisplayName(patient)).join(' ').toLocaleLowerCase();
}
