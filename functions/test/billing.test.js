import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { assertOwner, safeReturnUrl, subscriptionPlan, createBillingService, PLANS, GRACE_MS } from '../billing.js';

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
    collection(collection) {
      const q = filters => ({
        where: (field, op, value) => q([...filters, [field, value]]),
        limit: () => q(filters),
        async get() {
          const depth = collection.split('/').length + 1;
          const paths = [...data.keys()].filter(p => p.startsWith(collection + '/') && p.split('/').length === depth
            && filters.every(([f, v]) => data.get(p)?.[f] === v));
          return { size: paths.length, docs: paths.map(p => ({ ref: doc(p), data: () => data.get(p) })) };
        },
      });
      return q([]);
    },
  };
  let current = [];
  let checkoutCalls = 0;
  const sessions = new Map();
  const itemUpdates = [];
  const stripe = {
    customers: { create: async () => ({ id: 'cus_test' }) },
    prices: { list: async ({ lookup_keys }) => ({ data: [{ id: `price_${lookup_keys[0]}` }] }) },
    subscriptionItems: { update: async (id, params) => { itemUpdates.push([id, params]); return {}; } },
    subscriptions: { list() { return { async *[Symbol.asyncIterator]() { yield* current; } }; }, retrieve: async id => current.find(s => s.id === id) },
    checkout: { sessions: {
      create: async (params, options) => { checkoutCalls++; const s = { id: 'cs_test', url: 'https://checkout.stripe.com/test', status: 'open', params, options }; sessions.set(s.id, s); return s; },
      retrieve: async id => sessions.get(id),
    } },
    billingPortal: { sessions: { create: async ({ customer }) => ({ url: `https://billing.stripe.com/${customer}` }) } },
  };
  let t = 200000000;
  const service = createBillingService({ db, stripe, config: { enabled: true, priceId: 'price_server', plans: PLANS, returnUrl: 'https://example.org/return', ...config }, now: () => t });
  return { service, data, sessions, itemUpdates, advance: ms => { t += ms; }, setSubscriptions: value => { current = value; }, calls: () => checkoutCalls };
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

// ---- Kainos pagal lookup_key, vietos pagal vairuotojus, malonės laikotarpis ----
const drivers = (f, n) => { for (let i = 0; i < n; i++) f.data.set(`companies/company/members/d${i}`, { role: 'driver', status: 'active' }); };
const companySub = (quantity, status = 'active') => ({ id: 'sub_c', status, metadata: { companyId: 'company' },
  items: { data: [{ id: 'si_1', quantity, price: { lookup_key: PLANS.company } }] } });

test('company plan checkout uses lookup price and bills at least 3 drivers', async () => {
  const f = fixture();
  drivers(f, 2);
  f.data.set('companies/company/members/disp', { role: 'dispatcher', status: 'active' });
  f.data.set('companies/company/members/gone', { role: 'driver', status: 'removed' });
  await f.service.checkout({ uid: 'owner' }, { plan: 'company' });
  const items = f.sessions.get('cs_test').params.line_items[0];
  assert.equal(items.price, 'price_karjeroreisai_company_per_driver');
  assert.equal(items.quantity, 3);
});
test('company plan with 5 active drivers bills 5; monthly bills 1; unknown plan rejected', async () => {
  const f = fixture();
  drivers(f, 5);
  await f.service.checkout({ uid: 'owner' }, { plan: 'company' });
  assert.equal(f.sessions.get('cs_test').params.line_items[0].quantity, 5);
  const g = fixture();
  await g.service.checkout({ uid: 'owner' }, { plan: 'yearly' });
  assert.equal(g.sessions.get('cs_test').params.line_items[0].price, 'price_karjeroreisai_yearly');
  assert.equal(g.sessions.get('cs_test').params.line_items[0].quantity, 1);
  await assert.rejects(fixture().service.checkout({ uid: 'owner' }, { plan: 'free_forever' }), { code: 'invalid-argument' });
});
test('seat sync: approving a 4th driver sets quantity 4, removing down to 2 keeps 3', async () => {
  const f = fixture();
  f.data.set('billingCustomers/company', { customerId: 'cus_test', subscriptionId: 'sub_c' });
  f.setSubscriptions([companySub(3)]);
  drivers(f, 4);
  assert.deepEqual(await f.service.syncSeats({ uid: 'owner' }), { seats: 4 });
  assert.equal(f.itemUpdates.at(-1)[1].quantity, 4);
  assert.equal(f.itemUpdates.at(-1)[1].proration_behavior, 'create_prorations');
  f.setSubscriptions([companySub(4)]);
  f.data.delete('companies/company/members/d2'); f.data.delete('companies/company/members/d3');
  assert.deepEqual(await f.service.syncSeats({ uid: 'owner' }), { seats: 3 });
  assert.equal(f.itemUpdates.at(-1)[1].quantity, 3);
  await assert.rejects(f.service.syncSeats({ uid: 'attacker' }), { code: 'permission-denied' });
});
test('failed payment keeps access for 7 days, then blocks new work', async () => {
  const f = fixture();
  f.data.set('billingCustomers/company', { customerId: 'cus_test' });
  f.setSubscriptions([companySub(3, 'past_due')]);
  await f.service.event({ id: 'evt_pf', type: 'invoice.payment_failed', data: { object: { customer: 'cus_test' } } });
  assert.equal(f.data.get('companies/company').plan, 'paid');
  assert.ok(f.data.get('companies/company').graceUntilMillis > 0);
  f.advance(GRACE_MS + 1000);
  await f.service.event({ id: 'evt_pf2', type: 'customer.subscription.updated', data: { object: { customer: 'cus_test' } } });
  assert.equal(f.data.get('companies/company').plan, 'inactive');
  f.setSubscriptions([companySub(3, 'active')]);
  await f.service.event({ id: 'evt_paid', type: 'invoice.paid', data: { object: { customer: 'cus_test' } } });
  assert.equal(f.data.get('companies/company').plan, 'paid');
  assert.equal(f.data.get('companies/company').billingPlan, 'company');
  assert.equal(f.data.get('billingCustomers/company').pastDueSinceMillis, null);
});
test('upcoming invoice re-counts drivers before renewal', async () => {
  const f = fixture();
  f.data.set('billingCustomers/company', { customerId: 'cus_test', subscriptionId: 'sub_c' });
  f.setSubscriptions([companySub(3)]);
  drivers(f, 6);
  await f.service.event({ id: 'evt_up', type: 'invoice.upcoming', data: { object: { customer: 'cus_test' } } });
  assert.equal(f.itemUpdates.at(-1)[1].quantity, 6);
});
