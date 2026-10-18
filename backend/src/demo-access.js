const doctors = Object.freeze({
  doctor1: { specialties: Object.freeze(['general_medicine', 'neurology']) },
  doctor2: { specialties: Object.freeze(['orthopedics']) },
  doctor3: { specialties: Object.freeze(['cardiology']) },
});
const roleFor = username => username.startsWith('patient') ? 'patient'
  : username.startsWith('dispatcher') ? 'dispatcher'
    : username.startsWith('commandcenter') ? 'command-center'
      : username === 'admin1' ? 'admin' : null;

export function createMemoryDemoAccessStore() {
  return {
    async resolve(account) {
      const doctor = doctors[account.username];
      if (doctor) return { roles: ['doctor'], specialties: [...doctor.specialties] };
      return { roles: [roleFor(account.username)].filter(Boolean), specialties: [] };
    },
  };
}

export function createConfiguredDemoAccessStore() {
  return createMemoryDemoAccessStore();
}
