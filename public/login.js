const LOGIN_FAILURE = 'The username or password is incorrect.';

// This server-rendered flag only selects available UI controls. Authentication
// and permissions are always enforced by the backend.
export function supportsChatgptSignIn(document = globalThis.document) {
  return document?.querySelector('meta[name="openreconcile-auth-mode"]')?.content !== 'password';
}

// Keep model links useful after sign-in without accepting a redirect destination.
export function signInReturnUrl(href, showSignIn = false) {
  const current = new URL(href, 'https://workspace.invalid');
  const next = new URL('/', current.origin);
  const view = current.searchParams.get('view'), model = current.searchParams.get('model');
  if (['editing', 'published'].includes(view)) next.searchParams.set('view', view);
  if (model && /^[A-Za-z0-9_-]{1,100}$/.test(model)) next.searchParams.set('model', model);
  if (showSignIn) next.searchParams.set('signin', '1');
  return `${next.pathname}${next.search}`;
}

export function setupLogin({ document = globalThis.document, location = globalThis.location, request } = {}) {
  const externalSignIn = document.querySelector('#signin-link');
  if (externalSignIn) externalSignIn.hidden = !supportsChatgptSignIn(document);
  const externalDivider = document.querySelector('.auth-divider');
  if (externalDivider) externalDivider.hidden = !supportsChatgptSignIn(document);
  const form = document.querySelector('#login-form');
  // Older embedded pages can show the authentication screen before updating
  // their markup. They must still be able to use the existing SSO entry point.
  if (!form?.addEventListener || !form.elements) return;
  const username = form.elements.username, password = form.elements.password;
  const submit = document.querySelector('#login-submit');
  const status = document.querySelector('#login-status'), error = document.querySelector('#login-error');
  let pending = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || !form.reportValidity()) return;
    pending = true;
    error.hidden = true; error.textContent = '';
    status.textContent = 'Signing in…'; form.setAttribute('aria-busy', 'true');
    const credentials = { username: username.value.trim(), password: password.value };
    submit.disabled = true; username.disabled = true; password.disabled = true;
    let signedIn = false;
    try {
      await request('/api/auth/login', 'POST', credentials);
      signedIn = true;
      status.textContent = 'Signed in. Opening your workspace…';
    } catch (failure) {
      status.textContent = '';
      error.textContent = [400, 401, 403].includes(failure.status) ? LOGIN_FAILURE
        : failure.status === 429 ? 'Too many sign-in attempts. Wait a few minutes and try again.'
        : 'Sign-in is temporarily unavailable. Try again.';
      error.hidden = false;
    } finally {
      // Passwords live only in this form and this request, never in storage.
      password.value = ''; credentials.password = '';
      if (!signedIn) {
        pending = false; submit.disabled = false; username.disabled = false; password.disabled = false;
        form.setAttribute('aria-busy', 'false'); password.focus();
      }
    }
    if (signedIn) location.replace(signInReturnUrl(location.href));
  });
}

export function setupSignOut(session, { document = globalThis.document, location = globalThis.location, request } = {}) {
  const link = document.querySelector('#signout-link');
  if (!link || session.signOutUrl !== '/api/auth/logout') return;
  link.href = '/api/auth/logout';
  let pending = false;
  link.onclick = async event => {
    event.preventDefault();
    if (pending) return;
    pending = true; link.setAttribute?.('aria-disabled', 'true');
    try {
      await request('/api/auth/logout', 'POST', {});
      location.replace(signInReturnUrl(location.href, true));
    } catch {
      pending = false; link.removeAttribute?.('aria-disabled');
      const status = document.querySelector('#toast');
      if (status) { status.textContent = 'Sign-out could not be completed. Try again.'; status.classList.remove('hidden'); }
    }
  };
}
