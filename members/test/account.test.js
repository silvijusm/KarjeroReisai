import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountService } from '../account.js';

function fixture(extra = {}) {
  const data = new Map(Object.entries({
    'users/owner': { companyId: 'c1', role: 'company_admin' },
    'companies/c1': { ownerUid: 'owner', companyCode: 'KR-AAAAAA', name: 'Vežėjas' },
    'companyCodes/KR-AAAAAA': { companyId: 'c1' },
    'companies/c1/members/jonas': { role: 'driver', status: 'active', displayName: 'Jonas', email: 'j@x.lt' },
    'users/jonas': { companyId: 'c1', role: 'driver' },
    'companies/c1/liveLocations/jonas': { lat: 1 },
    'companies/c1/sessions/s1': { driverUid: 'jonas' },
    'companies/c1/objects/o1': { joinCode: 'OB-BBBBBB' },
    'objectCodes/OB-BBBBBB': { contractorId: 'c1', objectId: 'o1' },
    'companies/c1/objects/o1/carriers/c2': { status: 'active' },
    'companies/c2/objectLinks/o1': { contractorId: 'c1', status: 'active' },
    'companies/c1/objectLinks/o9': { contractorId: 'c3', status: 'active' },
    'companies/c3/objects/o9/carriers/c1': { status: 'active' },
    'users/owner2': { companyId: 'c2', role: 'company_admin' },
    'companies/c2': { ownerUid: 'owner2' },
    ...extra,
  }));
  const doc = path => ({ path, id: path.split('/').at(-1),
    async get() { return { exists: data.has(path), data: () => data.get(path) }; },
    async set(v, o) { data.set(path, o?.merge ? { ...data.get(path), ...v } : v); },
    async delete() { data.delete(path); } });
  const collection = path => ({ async get() {
    const depth = path.split('/').length + 1;
    return { docs: [...data.keys()].filter(k => k.startsWith(path + '/') && k.split('/').length === depth)
      .map(k => ({ id: k.split('/').at(-1), data: () => data.get(k) })) };
  } });
  const deletedUsers = [];
  const service = createAccountService({ db: { doc, collection },
    deleteTree: async ref => { for (const k of [...data.keys()]) if (k === ref.path || k.startsWith(ref.path + '/')) data.delete(k); },
    deleteAuthUser: async uid => { deletedUsers.push(uid); }, now: () => 5 });
  return { service, data, deletedUsers };
}

test('requires sign-in and explicit confirmation', async () => {
  const f = fixture();
  await assert.rejects(f.service.deleteAccount(null, { confirm: true }), { code: 'unauthenticated' });
  await assert.rejects(f.service.deleteAccount({ uid: 'jonas' }, {}), { code: 'invalid-argument' });
  assert.ok(f.data.has('users/jonas'));
});

test('a driver leaves the company; work records stay with the employer', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.deleteAccount({ uid: 'jonas' }, { confirm: true }), { ok: true, deleted: 'membership' });
  assert.equal(f.data.has('users/jonas'), false);
  assert.equal(f.data.has('companies/c1/liveLocations/jonas'), false);
  const m = f.data.get('companies/c1/members/jonas');
  assert.equal(m.status, 'removed'); assert.equal(m.email, null);
  assert.ok(f.data.has('companies/c1/sessions/s1'));
  assert.deepEqual(f.deletedUsers, ['jonas']);
});

test('the owner deletes the whole company and links to other companies', async () => {
  const f = fixture();
  assert.equal((await f.service.deleteAccount({ uid: 'owner' }, { confirm: true })).deleted, 'company');
  for (const k of f.data.keys()) assert.ok(!k.startsWith('companies/c1'), k);
  assert.equal(f.data.has('companyCodes/KR-AAAAAA'), false);
  assert.equal(f.data.has('objectCodes/OB-BBBBBB'), false);
  assert.equal(f.data.has('users/jonas'), false);
  assert.equal(f.data.has('users/owner'), false);
  assert.equal(f.data.get('companies/c2/objectLinks/o1').status, 'removed');
  assert.equal(f.data.get('companies/c3/objects/o9/carriers/c1').status, 'removed');
  assert.ok(f.data.has('companies/c2'));
  assert.deepEqual(f.deletedUsers, ['owner']);
});

test('an owner with a running subscription must cancel it first', async () => {
  const f = fixture({ 'billingCustomers/c1': { subscriptionId: 'sub_1', subscriptionStatus: 'active' } });
  await assert.rejects(f.service.deleteAccount({ uid: 'owner' }, { confirm: true }), { code: 'failed-precondition', message: 'subscription-active' });
  assert.ok(f.data.has('companies/c1'));
  f.data.set('billingCustomers/c1', { subscriptionId: 'sub_1', subscriptionStatus: 'active', cancelAtPeriodEnd: true });
  await f.service.deleteAccount({ uid: 'owner' }, { confirm: true });
  assert.equal(f.data.has('companies/c1'), false);
  assert.equal(f.data.has('billingCustomers/c1'), false);
});

test('a user without a company just loses the sign-in', async () => {
  const f = fixture({ 'users/solo': { role: 'driver' } });
  assert.equal((await f.service.deleteAccount({ uid: 'solo' }, { confirm: true })).deleted, 'profile');
  assert.equal(f.data.has('users/solo'), false);
});
