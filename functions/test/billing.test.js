import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { assertOwner, safeReturnUrl, subscriptionPlan, createBillingService } from '../billing.js';

// In-memory Firestore adapter keeps tests at the billing boundary, without any
// production account, network calls, money movement or real credentials.
function fixture(config = {}) {
  const data = new Map([
    ['users/owner', { companyId: 'company', role: 'company_admin' }],
    ['users/attacker', { companyId: 'company', role: 'company_admin' }],
    ['companies/company', { ownerUid: 'owner', plan: 'trial', name: 'Test' }],
  ]);
  const doc = path => ({ path, id: path.split('/').at(-1),
    async get() { return { exists: data.has(path), data: () => data.get(path), ref: this }; },
    async set(value, options) { data.set(path, options?.merge ? { ...data.get(path), ...value } : value); },
  });
  const db = { doc,
    async runTransaction(fn) { return fn({ get: ref => ref.get(), set: (ref, ...args) => ref.set(...args) }); },
    batch() { const writes = []; return { set: (...args) => writes.push(args), async commit() { for (const [ref, ...args] of writes) await ref.set(...args); } }; },
    collection(collection) { return { where(field, op, value) { return { limit() { return { async get() {
      const paths = [...data.keys()].filter(p => p.startsWith(collection + '/') && data.get(p)?.[field] === value);
      return { size: paths.length, docs: paths.map(p => ({ ref: doc(p) })) };
    } }; } }; } }; },
  };
  let current = [];
  let checkoutCalls = 0;
  const sessions = new Map();
  const stripe = {
    customers: { create: async () => ({ id: 'cus_test' }) },
    subscriptions: { list() { return { async *[Symbol.asyncIterator]() { yield* current; } }; }, retrieve: async id => current.find(s => s.id === id) },
    checkout: { sessions: {
      create: async (params, options) => { checkoutCalls++; const s = { id: 'cs_test', url: 'https://checkout.stripe.com/test', status: 'open', params, options }; sessions.set(s.id, s); return s; },
      retrieve: async id => sessions.get(id),
    } },
    billingPortal: { sessions: { create: async ({ customer }) => ({ url: `https://billing.stripe.com/${customer}` }) } },
  };
  const service = createBillingService({ db, stripe, config: { enabled: true, priceId: 'price_server', returnUrl: 'https://example.org/return', ...config }, now: () => 200000000 });
  return { service, data, sessions, setSubscriptions: value => { current = value; }, calls: () => checkoutCalls };
}

test('no authentication and forged company membership cannot bill another company', async () => {
  const f = fixture();
  await assert.rejects(f.service.checkout(null), { code: 'unauthenticated' });
  await assert.rejects(f.service.checkout({ uid: 'attacker' }), { code: 'permission-denied' });
  assert.equal(f.calls(), 0);
  assert.throws(() => assertOwner({ uid: 'attacker' }, { role: 'super_admin', companyId: 'company' }, { ownerUid: 'owner' }), { code: 'permission-denied' });
});
test('disabled billing never creates a payment session', async () => {
  const f = fixture({ enabled: false });
  assert.equal((await f.service.status({ uid: 'owner' })).enabled, false);
  await assert.rejects(f.service.checkout({ uid: 'owner' }), { code: 'failed-precondition' });
  assert.equal(f.calls(), 0);
});
test('server controls price, company and redirects; repeated checkout reuses open session', async () => {
  const f = fixture();
  const first = await f.service.checkout({ uid: 'owner' });
  assert.deepEqual(await f.service.checkout({ uid: 'owner' }), first);
  assert.equal(f.calls(), 1);
  assert.equal(f.sessions.get('cs_test').params.line_items[0].price, 'price_server');
  assert.equal(f.sessions.get('cs_test').params.subscription_data.metadata.companyId, 'company');
  assert.equal(f.data.get('companies/company').plan, 'trial'); // redirect is not payment proof
});
test('existing and pending subscriptions cannot be charged twice', async () => {
  const f = fixture();
  for (const status of ['active', 'past_due', 'incomplete', 'trialing', 'paused', 'unpaid']) {
    f.setSubscriptions([{ id: 'sub_test', status }]);
    await assert.rejects(f.service.checkout({ uid: 'owner' }), { code: 'already-exists' });
  }
  assert.equal(f.calls(), 0);
});
test('active lease prevents concurrent checkout and expired unknown outcomes stop safely', async () => {
  const f = fixture();
  f.data.set('billingCustomers/company', { leaseUntil: 200000001 });
  await assert.rejects(f.service.checkout({ uid: 'owner' }), { code: 'aborted' });
  f.data.set('billingCustomers/company', { customerId: 'cus_test', attempt: { id: 'old', createdAt: 0 } });
  await assert.rejects(f.service.checkout({ uid: 'owner' }), { code: 'failed-precondition' });
  assert.equal(f.calls(), 0);
});
test('webhook duplicates are harmless and old events retrieve current subscription state', async () => {
  const f = fixture();
  f.data.set('billingCustomers/company', { customerId: 'cus_test' });
  const event = { id: 'evt_1', type: 'customer.subscription.updated', created: 10, data: { object: { customer: 'cus_test', status: 'active' } } };
  f.setSubscriptions([{ id: 'sub_test', status: 'canceled', metadata: { companyId: 'company' } }]);
  await f.service.event(event);
  assert.equal(f.data.get('companies/company').plan, 'inactive');
  f.setSubscriptions([{ id: 'sub_test', status: 'active', metadata: { companyId: 'company' } }]);
  await f.service.event(event);
  assert.equal(f.data.get('companies/company').plan, 'inactive'); // same ID ignored
  await f.service.event({ ...event, id: 'evt_2', created: 10 }); // same timestamp is allowed
  assert.equal(f.data.get('companies/company').plan, 'paid');
});
test('unrelated subscription metadata cannot grant paid access', async () => {
  const f = fixture();
  f.data.set('billingCustomers/company', { customerId: 'cus_test' });
  f.setSubscriptions([{ id: 'sub_other', status: 'active', metadata: { companyId: 'other' } }]);
  await f.service.event({ id: 'evt_3', type: 'checkout.session.completed', data: { object: { customer: 'cus_test' } } });
  assert.equal(f.data.get('companies/company').plan, 'inactive');
});
test('only active subscriptions grant paid access', () => {
  assert.equal(subscriptionPlan({ status: 'active' }), 'paid');
  for (const status of ['incomplete', 'past_due', 'unpaid', 'canceled', 'paused', 'trialing']) assert.equal(subscriptionPlan({ status }), 'inactive');
});
test('return URLs require HTTPS without embedded credentials', () => {
  for (const value of ['http://example.com', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://localhost']) assert.throws(() => safeReturnUrl(value));
  assert.equal(safeReturnUrl('https://example.com/return'), 'https://example.com/return');
});
test('Stripe signature validation rejects changed bodies, bad signatures and old timestamps', () => {
  const stripe = new Stripe('sk_test_NOT_A_REAL_KEY');
  const payload = JSON.stringify({ id: 'evt_local', type: 'test' });
  const secret = 'whsec_LOCAL_TEST_ONLY';
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  assert.equal(stripe.webhooks.constructEvent(payload, header, secret).id, 'evt_local');
  assert.throws(() => stripe.webhooks.constructEvent(payload + ' ', header, secret));
  assert.throws(() => stripe.webhooks.constructEvent(payload, 'invalid', secret));
  assert.throws(() => stripe.webhooks.constructEvent(payload, stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: 1 }), secret));
});
