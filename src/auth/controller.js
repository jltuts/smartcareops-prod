export const AuthStatus = Object.freeze({
  AUTH_LOADING: 'AUTH_LOADING',
  SIGNED_OUT: 'SIGNED_OUT',
  SIGNED_IN: 'SIGNED_IN',
});

// Firebase owns session persistence and token refresh. This controller never stores or logs tokens.
export function createAuthController(adapter) {
  let state = { status: AuthStatus.AUTH_LOADING, user: null, error: null };
  const listeners = new Set();
  const publish = next => { state = next; for (const listener of listeners) listener(state); };
  adapter.observe(
    user => publish({ status: user ? AuthStatus.SIGNED_IN : AuthStatus.SIGNED_OUT, user, error: null }),
    () => publish({ status: AuthStatus.SIGNED_OUT, user: null, error: 'Sign-in is unavailable. Please try again.' }),
  );
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    async signIn() {
      try { await adapter.signIn(); }
      catch { publish({ ...state, error: 'Sign-in did not complete. Please try again.' }); }
    },
    async signOut() {
      try { await adapter.signOut(); }
      catch { publish({ ...state, error: 'Sign-out did not complete. Please try again.' }); }
    },
    async getIdToken() {
      if (!state.user) throw new Error('Sign in to continue.');
      return state.user.getIdToken();
    },
  };
}
