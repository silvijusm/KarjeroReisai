import test from 'node:test';
import assert from 'node:assert/strict';
import { createMembersService, normalizeCode, generateCode, JOIN_LIMIT_PER_HOUR } from '../members.js';

// In-memory Firestore adapter: documents, transactions and batches.
function fixture() {
  const data = new Map([
    ['users/owner', { companyId: 'c1', role: 'company_admin', name: 'Owner', email: 'owner@x.lt' }],
    ['companies/c1', { ownerUid: 'owner', plan: 'trial', name: 'Vežėjas UAB' }],
    ['users/owner2', { companyId: 'c2', role: 'company_admin', name: 'Other', email: 'o2@x.lt' }],
    ['companies/c2', { ownerUid: 'owner2', plan: 'trial', name: 'Kita UAB' }],
  ]);
  const doc = path => ({ path, id: path.split('/').at(-1),
    async get() { return { exists: data.has(path), data: () => data.get(path) }; },
    async set(value, options) { data.set(path, options?.merge ? { ...data.get(path), ...value } : value); },
    async delete() { data.delete(path); },
  });
  const writer = () => { const ops = []; return {
    set: (ref, ...args) => ops.push(() => ref.set(...args)),
    delete: ref => ops.push(() => ref.delete()),
    async run() { for (const op of ops) await op(); },
  }; };
  const db = { doc,
    async runTransaction(fn) { const w = writer(); const result = await fn({ get: ref => ref.get(), set: w.set, delete: w.delete }); await w.run(); return result; },
    batch() { const w = writer(); return { set: w.set, delete: w.delete, commit: () => w.run() }; },
  };
  let t = 1_000_000;
  let seq = 0;
  const random = n => (seq++ * 7) % n;
  const service = createMembersService({ db, now: () => t, random });
  return { service, data, advance: ms => { t += ms; } };
}
const auth = (uid, email = `${uid}@x.lt`) => ({ uid, token: { email } });

async function joined(f, uid = 'jonas') {
  const { code } = await f.service.companyCode(auth('owner'));
  await f.service.joinCompany(auth(uid), { code, name: 'Jonas Jonaitis' });
  return code;
}

test('codes are readable and normalized from user input', () => {
  const code = generateCode(() => 0);
  assert.match(code, /^KR-[2-9A-Z]{6}$/);
  assert.doesNotMatch(code, /[01OIL]/);
  assert.equal(normalizeCode(' kr-ab3k9q '), 'KR-AB3K9Q');
  assert.equal(normalizeCode('AB3 K9Q'), 'KR-AB3K9Q');
  assert.equal(normalizeCode('KR-AB0K9Q'), null);
  assert.equal(normalizeCode('KR-AB'), null);
  assert.equal(normalizeCode(42), null);
});

test('only the company owner can get and regenerate the company code', async () => {
  const f = fixture();
  const first = await f.service.companyCode(auth('owner'));
  assert.deepEqual(await f.service.companyCode(auth('owner')), first);
  assert.equal(f.data.get(`companyCodes/${first.code}`).companyId, 'c1');
  const second = await f.service.companyCode(auth('owner'), { regenerate: true });
  assert.notEqual(second.code, first.code);
  assert.equal(f.data.has(`companyCodes/${first.code}`), false);
  await assert.rejects(f.service.companyCode(null), { code: 'unauthenticated' });
  await assert.rejects(f.service.companyCode(auth('stranger')), { code: 'permission-denied' });
});

test('driver joins with code as pending and cannot act before approval', async () => {
  const f = fixture();
  await joined(f);
  assert.equal(f.data.get('companies/c1/members/jonas').status, 'pending');
  assert.equal(f.data.get('companies/c1/members/jonas').role, 'driver');
  assert.equal(f.data.get('users/jonas').companyId, 'c1');
  assert.equal(f.data.get('users/jonas').role, 'driver');
  await assert.rejects(f.service.approveMember(auth('jonas'), { uid: 'jonas' }), { code: 'permission-denied' });
});

test('old code stops working after regeneration; wrong code is rejected', async () => {
  const f = fixture();
  const { code } = await f.service.companyCode(auth('owner'));
  await f.service.companyCode(auth('owner'), { regenerate: true });
  await assert.rejects(f.service.joinCompany(auth('jonas'), { code, name: 'Jonas' }), { code: 'not-found' });
  await assert.rejects(f.service.joinCompany(auth('jonas'), { code: 'KR-ZZZZZZ', name: 'Jonas' }), { code: 'not-found' });
  await assert.rejects(f.service.joinCompany(auth('jonas'), { code, name: '  ' }), { code: 'invalid-argument' });
});

test('join attempts are limited per hour', async () => {
  const f = fixture();
  for (let i = 0; i < JOIN_LIMIT_PER_HOUR; i++) {
    await assert.rejects(f.service.joinCompany(auth('spam'), { code: 'KR-ZZZZZZ', name: 'X' }), { code: 'not-found' });
  }
  await assert.rejects(f.service.joinCompany(auth('spam'), { code: 'KR-ZZZZZZ', name: 'X' }), { code: 'resource-exhausted' });
  f.advance(3600000);
  await assert.rejects(f.service.joinCompany(auth('spam'), { code: 'KR-ZZZZZZ', name: 'X' }), { code: 'not-found' });
});

test('one user – one company; owners cannot join another company', async () => {
  const f = fixture();
  await joined(f);
  const { code: other } = await f.service.companyCode(auth('owner2'));
  await assert.rejects(f.service.joinCompany(auth('jonas'), { code: other, name: 'Jonas' }), { code: 'already-exists' });
  await assert.rejects(f.service.joinCompany(auth('owner'), { code: other, name: 'Owner' }), { code: 'failed-precondition' });
});

test('owner approves; driver then active. Another company owner cannot approve', async () => {
  const f = fixture();
  await joined(f);
  await assert.rejects(f.service.approveMember(auth('owner2'), { uid: 'jonas' }), { code: 'not-found' });
  await f.service.approveMember(auth('owner'), { uid: 'jonas' });
  const member = f.data.get('companies/c1/members/jonas');
  assert.equal(member.status, 'active');
  assert.equal(member.approvedBy, 'owner');
  await assert.rejects(f.service.approveMember(auth('owner'), { uid: 'jonas' }), { code: 'failed-precondition' });
});

test('reject and cancel free the user to join again', async () => {
  const f = fixture();
  const code = await joined(f);
  await f.service.rejectMember(auth('owner'), { uid: 'jonas' });
  assert.equal(f.data.get('companies/c1/members/jonas').status, 'rejected');
  assert.equal(f.data.has('users/jonas'), false);
  await f.service.joinCompany(auth('jonas'), { code, name: 'Jonas' });
  await f.service.cancelJoin(auth('jonas'));
  assert.equal(f.data.get('companies/c1/members/jonas').status, 'cancelled');
  assert.equal(f.data.has('users/jonas'), false);
});

test('removed driver loses profile link but member record stays for reports', async () => {
  const f = fixture();
  await joined(f);
  await f.service.approveMember(auth('owner'), { uid: 'jonas' });
  await f.service.removeMember(auth('owner'), { uid: 'jonas' });
  assert.equal(f.data.get('companies/c1/members/jonas').status, 'removed');
  assert.equal(f.data.get('companies/c1/members/jonas').displayName, 'Jonas Jonaitis');
  assert.equal(f.data.has('users/jonas'), false);
  await assert.rejects(f.service.removeMember(auth('owner'), { uid: 'owner' }), { code: 'failed-precondition' });
});

test('dispatcher role: can be assigned, cannot manage members or codes', async () => {
  const f = fixture();
  await joined(f);
  await f.service.approveMember(auth('owner'), { uid: 'jonas' });
  await f.service.setMemberRole(auth('owner'), { uid: 'jonas', role: 'dispatcher' });
  assert.equal(f.data.get('companies/c1/members/jonas').role, 'dispatcher');
  assert.equal(f.data.get('users/jonas').role, 'dispatcher');
  await assert.rejects(f.service.companyCode(auth('jonas')), { code: 'permission-denied' });
  await assert.rejects(f.service.setMemberRole(auth('owner'), { uid: 'jonas', role: 'company_admin' }), { code: 'invalid-argument' });
  await assert.rejects(f.service.setMemberRole(auth('owner'), { uid: 'jonas', role: 'super_admin' }), { code: 'invalid-argument' });
});

test('forged profile without active membership grants no management rights', async () => {
  const f = fixture();
  f.data.set('users/forger', { companyId: 'c1', role: 'dispatcher' });
  await assert.rejects(f.service.companyCode(auth('forger')), { code: 'permission-denied' });
  f.data.set('users/forger', { companyId: 'c1', role: 'company_admin' });
  await assert.rejects(f.service.approveMember(auth('forger'), { uid: 'x' }), { code: 'permission-denied' });
});

// ---- Rangovas: objektai ir vežėjai ----
async function objectSetup(f) {
  f.data.set('companies/c2/objects/o1', { name: 'Kelias A1', objectCode: 'P-256', status: 'active' });
  const { code } = await f.service.objectJoinCode(auth('owner2'), { objectId: 'o1' });
  return code;
}
test('contractor gets an object join code; others cannot', async () => {
  const f = fixture();
  const code = await objectSetup(f);
  assert.match(code, /^OB-[2-9A-Z]{6}$/);
  assert.deepEqual(await f.service.objectJoinCode(auth('owner2'), { objectId: 'o1' }), { code });
  await assert.rejects(f.service.objectJoinCode(auth('owner'), { objectId: 'o1' }), { code: 'not-found' });
  await assert.rejects(f.service.objectJoinCode(auth('stranger'), { objectId: 'o1' }), { code: 'permission-denied' });
});
test('carrier joins object as pending; contractor approves and removes', async () => {
  const f = fixture();
  const code = await objectSetup(f);
  const r = await f.service.joinObject(auth('owner'), { code: code.toLowerCase() });
  assert.equal(r.status, 'pending');
  assert.equal(f.data.get('companies/c2/objects/o1/carriers/c1').status, 'pending');
  assert.equal(f.data.get('companies/c1/objectLinks/o1').contractorId, 'c2');
  await assert.rejects(f.service.joinObject(auth('owner'), { code }), { code: 'already-exists' });
  await assert.rejects(f.service.approveCarrier(auth('owner'), { objectId: 'o1', carrierId: 'c1' }), { code: 'not-found' });
  await f.service.approveCarrier(auth('owner2'), { objectId: 'o1', carrierId: 'c1' });
  assert.equal(f.data.get('companies/c2/objects/o1/carriers/c1').status, 'active');
  assert.equal(f.data.get('companies/c1/objectLinks/o1').status, 'active');
  await f.service.removeCarrier(auth('owner2'), { objectId: 'o1', carrierId: 'c1' });
  assert.equal(f.data.get('companies/c1/objectLinks/o1').status, 'removed');
});
test('drivers cannot join objects; wrong or finished object codes are rejected', async () => {
  const f = fixture();
  const code = await objectSetup(f);
  await joined(f);
  await f.service.approveMember(auth('owner'), { uid: 'jonas' });
  await assert.rejects(f.service.joinObject(auth('jonas'), { code }), { code: 'permission-denied' });
  await assert.rejects(f.service.joinObject(auth('owner'), { code: 'OB-ZZZZZZ' }), { code: 'not-found' });
  f.data.set('companies/c2/objects/o1', { ...f.data.get('companies/c2/objects/o1'), status: 'finished' });
  await assert.rejects(f.service.joinObject(auth('owner'), { code }), { code: 'not-found' });
});
test('loader role can be assigned', async () => {
  const f = fixture();
  await joined(f);
  await f.service.approveMember(auth('owner'), { uid: 'jonas' });
  await f.service.setMemberRole(auth('owner'), { uid: 'jonas', role: 'loader' });
  assert.equal(f.data.get('users/jonas').role, 'loader');
});
