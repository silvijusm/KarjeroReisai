import { before, after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createCompanyService, generateCompanyCode } from '../company.js';

test('company codes avoid ambiguous characters', () => {
  for (let i = 0; i < 100; i++) assert.match(generateCompanyCode(), /^KR-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
});

describe('company transactions against Firestore emulator', { skip: !process.env.FIRESTORE_EMULATOR_HOST }, () => {
  let app, db, env, service;
  let time = 2_000_000_000_000;
  const auth = uid => ({ uid, token: { email: `${uid}@example.test` } });
  const read = async path => (await db.doc(path).get()).data();
  async function driver(uid = 'driver') { await service.registerDriver(auth(uid), { name: uid }); }
  async function invitation(id = 'a', owner = 'owner') {
    return (await service.rotateCode(auth(owner), { companyId: id })).companyCode;
  }
  const review = (uid, action, extra = {}) => service.reviewMembership(auth('owner'), { companyId: 'a', uid, action, ...extra });
  async function join(uid = 'driver') {
    await driver(uid);
    await service.requestMembership(auth(uid), { code: await invitation() });
  }
  before(async () => {
    const { initializeTestEnvironment } = await import('@firebase/rules-unit-testing');
    env = await initializeTestEnvironment({ projectId: 'demo-karjeroreisai', firestore: {
      rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8')
    } });
    app = initializeApp({ projectId: 'demo-karjeroreisai' }, 'company-integration');
    db = getFirestore(app);
  });
  after(async () => { await db?.terminate(); if (app) await deleteApp(app); await env?.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    time = 2_000_000_000_000;
    service = createCompanyService({ db, now: () => time });
    await Promise.all([
      db.doc('users/owner').set({ role: 'company_admin', companyId: 'a', name: 'Owner' }),
      db.doc('companies/a').set({ ownerUid: 'owner', name: 'A', plan: 'trial' }),
      db.doc('users/other').set({ role: 'company_admin', companyId: 'b', name: 'Other' }),
      db.doc('companies/b').set({ ownerUid: 'other', name: 'B', plan: 'trial' })
    ]);
  });
  test('all company operations require authentication', async () => {
    for (const operation of ['registerDriver', 'rotateCode', 'requestMembership', 'cancelRequest', 'reviewMembership', 'saveVehicle']) {
      await assert.rejects(service[operation](null, {}), { code: 'unauthenticated' });
    }
  });
  test('driver profile is server-assigned and registration is idempotent', async () => {
    await service.registerDriver(auth('driver'), { name: 'Jonas', role: 'super_admin', companyId: 'a' });
    const first = await read('users/driver');
    assert.equal(first.role, 'driver'); assert.equal(first.companyId, '');
    assert.equal(first.email, 'driver@example.test');
    await service.registerDriver(auth('driver'), { name: 'Changed' });
    assert.deepEqual(await read('users/driver'), first);
    await assert.rejects(service.registerDriver(auth('owner'), { name: 'No overwrite' }), { code: 'failed-precondition' });
  });
  test('only real owner or trusted super admin can rotate codes', async () => {
    await db.doc('users/forged').set({ role: 'company_admin', companyId: 'a' });
    for (const uid of ['other', 'forged']) {
      await assert.rejects(service.rotateCode(auth(uid), { companyId: 'a' }), { code: 'permission-denied' });
    }
    await db.doc('users/support').set({ role: 'super_admin' });
    assert.match((await service.rotateCode(auth('support'), { companyId: 'a' })).companyCode, /^KR-/);
  });
  test('rotation invalidates old code without changing pending requests', async () => {
    await driver(); await driver('second');
    const oldCode = await invitation();
    await service.requestMembership(auth('driver'), { code: oldCode.toLowerCase() });
    const code = await invitation();
    assert.notEqual(code, oldCode);
    assert.equal(await read(`companyCodes/${oldCode}`), undefined);
    await assert.rejects(service.requestMembership(auth('second'), { code: oldCode }), { code: 'not-found' });
    await review('driver', 'approve');
    assert.equal((await read('users/driver')).companyId, 'a');
  });
  test('colliding code never overwrites another tenant', async () => {
    await db.doc('companyCodes/KR-AAAAAAAA').set({ companyId: 'b' });
    const collisions = createCompanyService({ db, newCode: () => 'KR-AAAAAAAA' });
    await assert.rejects(collisions.rotateCode(auth('owner'), { companyId: 'a' }), { code: 'aborted' });
    assert.equal((await read('companyCodes/KR-AAAAAAAA')).companyId, 'b');
  });
  test('concurrent code rotations leave exactly one valid code', async () => {
    await Promise.all([invitation(), invitation()]);
    const codes = await db.collection('companyCodes').where('companyId', '==', 'a').get();
    assert.equal(codes.size, 1);
    assert.equal(codes.docs[0].id, (await read('companies/a')).companyCode);
  });
  test('invalid and malformed guesses are limited, window expires after one hour', async () => {
    await driver();
    for (let i = 0; i < 10; i++) {
      await assert.rejects(service.requestMembership(auth('driver'), { code: i % 2 ? 'KR-AAAAAAAA' : '../invalid' }), { code: 'not-found' });
    }
    const code = await invitation();
    await assert.rejects(service.requestMembership(auth('driver'), { code }), { code: 'resource-exhausted' });
    time += 3_600_001;
    assert.equal((await service.requestMembership(auth('driver'), { code })).status, 'pending');
  });
  test('parallel guesses cannot exceed the per-user limit', async () => {
    await driver();
    // A burst near the boundary exercises the transaction conflict path.
    await db.doc('companyJoinLimits/driver').set({ attempts: Array(9).fill(time) });
    const result = await Promise.allSettled(Array.from({ length: 3 }, () => service.requestMembership(auth('driver'), { code: 'KR-AAAAAAAA' })));
    assert.equal(result.filter(r => r.reason?.code === 'not-found').length, 1);
    assert.equal(result.filter(r => r.reason?.code === 'resource-exhausted').length, 2);
  });
  test('one driver cannot have pending requests for two companies', async () => {
    await driver();
    const [a, b] = await Promise.all([invitation(), invitation('b', 'other')]);
    const outcomes = await Promise.allSettled([
      service.requestMembership(auth('driver'), { code: a }),
      service.requestMembership(auth('driver'), { code: b })
    ]);
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    const profile = await read('users/driver');
    const otherId = profile.pendingCompanyId === 'a' ? 'b' : 'a';
    assert.equal(await read(`companies/${otherId}/members/driver`), undefined);
  });
  test('approval is atomic and repeated approval is harmless', async () => {
    await join();
    assert.equal((await read('users/driver')).companyId, '');
    await Promise.all([review('driver', 'approve'), review('driver', 'approve')]);
    const member = await read('companies/a/members/driver');
    const profile = await read('users/driver');
    assert.equal(member.status, 'active'); assert.equal(member.role, 'driver');
    assert.equal(profile.companyId, 'a'); assert.equal(profile.pendingCompanyId, undefined);
    await assert.rejects(service.requestMembership(auth('driver'), { code: await invitation('b', 'other') }), { code: 'failed-precondition' });
  });
  test('driver, dispatcher and unrelated owner cannot approve or manage vehicles', async () => {
    await join(); await review('driver', 'approve'); await review('driver', 'set_role', { role: 'dispatcher' });
    await join('second');
    for (const uid of ['driver', 'second', 'other']) {
      await assert.rejects(service.reviewMembership(auth(uid), { companyId: 'a', uid: 'second', action: 'approve' }), { code: 'permission-denied' });
      await assert.rejects(service.saveVehicle(auth(uid), { companyId: 'a', plateNumber: 'ABC 123' }), { code: 'permission-denied' });
    }
  });
  test('cancellation and rejection release pending assignment', async () => {
    await join();
    await service.cancelRequest(auth('driver'));
    await assert.rejects(review('driver', 'approve'), { code: 'failed-precondition' });
    await service.requestMembership(auth('driver'), { code: await invitation() });
    await review('driver', 'reject'); await review('driver', 'reject');
    assert.equal((await read('users/driver')).pendingCompanyId, undefined);
    assert.equal((await service.requestMembership(auth('driver'), { code: await invitation('b', 'other') })).status, 'pending');
  });
  test('removed driver loses assignment while historical trips remain', async () => {
    await join(); await review('driver', 'approve');
    await db.doc('companies/a/sessions/old').set({ driverUid: 'driver' });
    await review('driver', 'remove'); await review('driver', 'remove');
    assert.equal((await read('users/driver')).companyId, '');
    assert.equal((await read('companies/a/members/driver')).status, 'removed');
    assert.deepEqual(await read('companies/a/sessions/old'), { driverUid: 'driver' });
    await service.requestMembership(auth('driver'), { code: await invitation('b', 'other') });
    await service.reviewMembership(auth('other'), { companyId: 'b', uid: 'driver', action: 'approve' });
    await review('driver', 'remove'); // stale retry must not detach the new company
    assert.equal((await read('users/driver')).companyId, 'b');
  });
  test('role changes are synchronized and cannot promote owner or super admin', async () => {
    await join(); await review('driver', 'approve');
    await review('driver', 'set_role', { role: 'dispatcher' });
    assert.equal((await read('users/driver')).role, 'dispatcher');
    assert.equal((await read('companies/a/members/driver')).role, 'dispatcher');
    await review('driver', 'set_role', { role: 'driver' });
    for (const role of ['company_admin', 'super_admin']) {
      await assert.rejects(review('driver', 'set_role', { role }), { code: 'invalid-argument' });
    }
    await assert.rejects(review('owner', 'remove'), { code: 'permission-denied' });
  });
  test('vehicle validation, retry-safe creation, update and deactivation', async () => {
    const vehicle = { companyId: 'a', plateNumber: 'abc 123', name: 'Scania', make: 'Scania', payloadT: 27 };
    assert.deepEqual(await service.saveVehicle(auth('owner'), vehicle), { vehicleId: 'ABC123' });
    await service.saveVehicle(auth('owner'), { ...vehicle, plateNumber: 'ABC-123', active: false });
    const records = await db.collection('companies/a/vehicles').get();
    assert.equal(records.size, 1); assert.equal(records.docs[0].data().active, false);
    assert.equal(records.docs[0].data().payloadT, 27);
    for (const patch of [{ payloadT: -1 }, { payloadT: '27' }, { active: 'yes' }, { plateNumber: '../escape' }, { plateNumber: '--' }]) {
      await assert.rejects(service.saveVehicle(auth('owner'), { ...vehicle, ...patch }), { code: 'invalid-argument' });
    }
    assert.equal((await read('companies/a')).plan, 'trial');
  });
});
