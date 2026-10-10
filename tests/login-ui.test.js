import test from 'node:test';
import assert from 'node:assert/strict';
import { setupLogin, setupSignOut, signInReturnUrl, supportsChatgptSignIn } from '../public/login.js';
import { connectWorkspace } from '../public/workspace-api.js';

test('self-hosted login hides the unavailable external sign-in while hosted login preserves it', () => {
  for (const mode of ['password', 'hosted']) {
    const link = { hidden: false };
    const divider = { hidden: false };
    const document = { querySelector: selector => selector === '#signin-link' ? link : selector === '.auth-divider' ? divider : selector === 'meta[name="openreconcile-auth-mode"]' ? { content: mode } : null };
    setupLogin({ document });
    assert.equal(link.hidden, mode === 'password');
    assert.equal(divider.hidden, mode === 'password');
    assert.equal(supportsChatgptSignIn(document), mode !== 'password');
  }
  assert.equal(supportsChatgptSignIn({ querySelector: () => null }), true);
});

function loginFixture(request) {
  let handler;
  const username = { value: '  test-user  ', disabled: false };
  const password = { value: 'test-password', disabled: false, focus() { this.focused = true; } };
  const submit = { disabled: false }, status = { textContent: '' }, error = { hidden: true, textContent: '' };
  const attributes = {};
  const form = { elements: { username, password }, reportValidity: () => true,
    addEventListener(type, action) { assert.equal(type, 'submit'); handler = action; }, setAttribute(key, value) { attributes[key] = value; } };
  const nodes = { '#login-form': form, '#login-submit': submit, '#login-status': status, '#login-error': error };
  const destinations = [], location = { href: 'https://app.example/?view=published&model=model-1&signin=1', replace(value) { destinations.push(value); } };
  setupLogin({ document: { querySelector: key => nodes[key] }, location, request });
  return { username, password, submit, status, error, attributes, destinations, submitForm() { return handler({ preventDefault() {} }); } };
}

test('sign-in return URLs retain model navigation and cannot redirect away from the workspace', () => {
  assert.equal(signInReturnUrl('https://app.example/?view=editing&model=model-1&signin=1'), '/?view=editing&model=model-1');
  assert.equal(signInReturnUrl('https://app.example/?view=published&model=model-1', true), '/?view=published&model=model-1&signin=1');
  assert.equal(signInReturnUrl('https://app.example/?view=editing-models&signin=1'), '/?view=editing-models');
  assert.equal(signInReturnUrl('https://app.example/?view=published-models', true), '/?view=published-models&signin=1');
  assert.equal(signInReturnUrl('https://app.example/evil?return_to=https://evil.example&model=https://evil.example&view=other'), '/');
});

test('successful password sign-in submits once and reloads rather than reusing another account workspace', async () => {
  let resolve, calls = [];
  const f = loginFixture((...args) => { calls.push(structuredClone(args)); return new Promise(done => { resolve = done; }); });
  const pending = f.submitForm();
  await f.submitForm();
  assert.deepEqual(calls, [['/api/auth/login', 'POST', { username: 'test-user', password: 'test-password' }]]);
  assert.equal(f.submit.disabled, true); assert.equal(f.attributes['aria-busy'], 'true'); assert.equal(f.destinations.length, 0);
  resolve({ ok: true }); await pending;
  assert.equal(f.password.value, ''); assert.deepEqual(f.destinations, ['/?view=published&model=model-1']);
});

test('rejected sign-in clears passwords, conceals account details, and permits a new attempt', async () => {
  let attempts = 0;
  const f = loginFixture(async () => { attempts++; throw Object.assign(new Error('Account test-user is disabled.'), { status: 403 }); });
  await f.submitForm();
  assert.equal(f.error.textContent, 'The username or password is incorrect.'); assert.equal(f.error.hidden, false);
  assert.equal(f.password.value, ''); assert.equal(f.password.focused, true); assert.equal(f.submit.disabled, false);
  assert.equal(f.attributes['aria-busy'], 'false'); assert.equal(f.destinations.length, 0);
  f.password.value = 'another-password'; await f.submitForm(); assert.equal(attempts, 2);
});

test('rate-limited sign-in gives a useful retry message without exposing backend details', async () => {
  const f = loginFixture(async () => { throw Object.assign(new Error('Private account data'), { status: 429 }); });
  await f.submitForm();
  assert.equal(f.error.textContent, 'Too many sign-in attempts. Wait a few minutes and try again.');
  assert.equal(f.password.value, ''); assert.equal(f.destinations.length, 0);
});

test('password sign-out uses POST and waits for cookie invalidation before navigation', async () => {
  let resolve;
  const calls = [], destinations = [], link = { setAttribute() {} };
  setupSignOut({ signOutUrl: '/api/auth/logout' }, { document: { querySelector: () => link },
    location: { href: 'https://app.example/?model=model-1', replace(value) { destinations.push(value); } },
    request(...args) { calls.push(args); return new Promise(done => { resolve = done; }); } });
  const pending = link.onclick({ preventDefault() {} }); await link.onclick({ preventDefault() {} });
  assert.deepEqual(calls, [['/api/auth/logout', 'POST', {}]]); assert.equal(destinations.length, 0);
  resolve({ ok: true }); await pending; assert.deepEqual(destinations, ['/?model=model-1&signin=1']);
});

test('explicit sign-in initializes the form and never reads an existing authenticated workspace', async t => {
  const keys = ['document', 'location', 'fetch'];
  const original = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const nodes = new Map(), handlers = new Map(), destinations = []; let reads = 0;
  const node = key => { if (!nodes.has(key)) nodes.set(key, { hidden: true, textContent: '', classList: { add() {}, remove() {} } }); return nodes.get(key); };
  const form = { elements: {}, addEventListener(type, action) { handlers.set(type, action); } };
  nodes.set('#login-form', form);
  globalThis.document = { body: node('body'), querySelector: node };
  globalThis.location = { href: 'https://app.example/?signin=1&model=model-1', reload() {}, replace(value) { destinations.push(value); } };
  globalThis.fetch = async () => { reads++; throw new Error('Unexpected authenticated request.'); };
  connectWorkspace(); await Promise.resolve();
  assert.equal(typeof handlers.get('submit'), 'function'); assert.equal(reads, 0);
  assert.equal(node('#auth-screen').hidden, false); assert.equal(node('#workspace-main').hidden, true);
  node('#auth-retry').onclick(); assert.deepEqual(destinations, ['/?model=model-1']);
});
