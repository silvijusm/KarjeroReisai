import { before, after, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { collection, getDocs, query, where, orderBy, documentId, limit, doc, setDoc, getDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';
let env;
before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Use npm run test:rules (emulator only).');
  env = await initializeTestEnvironment({ projectId: 'demo-karjeroreisai', firestore: { rules: readFileSync('firestore.rules', 'utf8') } });
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });
const db = (uid) => env.authenticatedContext(uid, { email: `${uid}@example.test` }).firestore();
const company = (uid, patch = {}) => ({ name: 'Test company', ownerUid: uid, plan: 'trial', trialEndsAtMillis: Date.now() + 60 * 86400000, createdAt: serverTimestamp(), ...patch });
const profile = (uid, companyId, patch = {}) => ({ email: `${uid}@example.test`, name: 'Test user', role: 'company_admin', companyId, createdAt: serverTimestamp(), ...patch });
function register(uid, id, companyPatch = {}, userPatch = {}) {
  const client = db(uid), batch = writeBatch(client);
  batch.set(doc(client, 'companies', id), company(uid, companyPatch));
  batch.set(doc(client, 'users', uid), profile(uid, id, userPatch));
  return batch.commit();
}
async function seedUser(uid, data) {
  await env.withSecurityRulesDisabled(async ctx => setDoc(doc(ctx.firestore(), 'users', uid), data));
}
test('current Android atomic company registration succeeds', async () => { await assertSucceeds(register('alice', 'a')); });
test('anonymous reads and writes are denied', async () => {
  await register('alice', 'a');
  const anon = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anon, 'companies', 'a')));
  await assertFails(setDoc(doc(anon, 'users', 'intruder'), profile('intruder', 'a')));
});
test('owner can read own company and profile', async () => {
  await register('alice', 'a');
  await assertSucceeds(getDoc(doc(db('alice'), 'companies', 'a')));
  await assertSucceeds(getDoc(doc(db('alice'), 'users', 'alice')));
});
test('another tenant cannot read a company or user profile', async () => {
  await register('alice', 'a'); await register('bob', 'b');
  await assertFails(getDoc(doc(db('bob'), 'companies', 'a')));
  await assertFails(getDoc(doc(db('bob'), 'users', 'alice')));
});
test('new user cannot attach their profile to an existing foreign company', async () => {
  await register('alice', 'a');
  await assertFails(setDoc(doc(db('bob'), 'users', 'bob'), profile('bob', 'a')));
});
test('previously forged companyId grants no company read or update', async () => {
  await register('alice', 'a');
  await seedUser('bob', { ...profile('bob', 'a'), createdAt: Timestamp.now() });
  await assertFails(getDoc(doc(db('bob'), 'companies', 'a')));
  await assertFails(updateDoc(doc(db('bob'), 'companies', 'a'), { name: 'Stolen' }));
});
test('profile cannot be created without a new company', async () => {
  await assertFails(setDoc(doc(db('alice'), 'users', 'alice'), profile('alice', 'missing')));
});
test('company cannot be created without its matching profile', async () => {
  await assertFails(setDoc(doc(db('alice'), 'companies', 'a'), company('alice')));
});
test('existing owner cannot mint another trial company', async () => {
  await register('alice', 'a');
  await assertFails(setDoc(doc(db('alice'), 'companies', 'second'), company('alice')));
});
test('one registration batch cannot create a second company', async () => {
  const client = db('alice'), batch = writeBatch(client);
  batch.set(doc(client, 'users', 'alice'), profile('alice', 'a'));
  batch.set(doc(client, 'companies', 'a'), company('alice'));
  batch.set(doc(client, 'companies', 'b'), company('alice'));
  await assertFails(batch.commit());
});
test('signup cannot claim super_admin or another owner', async () => {
  await assertFails(register('alice', 'a', {}, { role: 'super_admin' }));
  await assertFails(register('alice', 'a', { ownerUid: 'bob' }));
});
test('signup cannot claim paid plan, long trial or forged creation time', async () => {
  await assertFails(register('alice', 'a', { plan: 'paid' }));
  await assertFails(register('alice', 'a', { trialEndsAtMillis: Date.now() + 365 * 86400000 }));
  await assertFails(register('alice', 'a', { createdAt: Timestamp.fromMillis(0) }));
});
test('signup rejects extra privilege fields and mismatched email', async () => {
  await assertFails(register('alice', 'a', {}, { admin: true }));
  await assertFails(register('alice', 'a', {}, { email: 'bob@example.test' }));
});
test('owner can edit display names', async () => {
  await register('alice', 'a');
  await assertSucceeds(updateDoc(doc(db('alice'), 'users', 'alice'), { name: 'Updated' }));
  await assertSucceeds(updateDoc(doc(db('alice'), 'companies', 'a'), { name: 'Updated company' }));
});
test('owner cannot change billing, expiry, ownership or remove protected fields', async () => {
  await register('alice', 'a');
  for (const patch of [{ plan: 'paid' }, { trialEndsAtMillis: Date.now() + 365 * 86400000 }, { ownerUid: 'bob' }]) {
    await assertFails(updateDoc(doc(db('alice'), 'companies', 'a'), patch));
  }
  await assertFails(setDoc(doc(db('alice'), 'companies', 'a'), { name: 'Replacement', ownerUid: 'alice' }));
});
test('profile role and membership cannot be changed', async () => {
  await register('alice', 'a');
  await assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { role: 'super_admin' }));
  await assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { companyId: 'b' }));
});
test('deletes and unmatched collection writes are denied', async () => {
  await register('alice', 'a');
  await assertFails(deleteDoc(doc(db('alice'), 'users', 'alice')));
  await assertFails(deleteDoc(doc(db('alice'), 'companies', 'a')));
  await assertFails(setDoc(doc(db('alice'), 'billing', 'a'), { paid: true }));
});
test('trusted super admin can read companies but billing remains server-only', async () => {
  await register('alice', 'a');
  await seedUser('support', { role: 'super_admin' });
  await assertSucceeds(getDoc(doc(db('support'), 'companies', 'a')));
  await assertSucceeds(getDoc(doc(db('support'), 'users', 'alice')));
  await assertFails(updateDoc(doc(db('support'), 'companies', 'a'), { plan: 'paid' }));
});

test('company list is restricted to trusted administrators', async () => {
  await register('alice', 'a');
  await seedUser('support', { role: 'super_admin' });
  await assertSucceeds(getDocs(query(collection(db('support'), 'companies'), orderBy(documentId()), limit(50))));
  await assertFails(getDocs(collection(db('alice'), 'companies')));
});
test('billing customer mappings and webhook receipts remain server-only for all clients', async () => {
  await register('alice', 'a');
  await seedUser('support', { role: 'super_admin' });
  for (const uid of ['alice', 'support']) {
    for (const name of ['billingCustomers', 'billingEvents']) {
      await assertFails(getDoc(doc(db(uid), name, 'a')));
      await assertFails(setDoc(doc(db(uid), name, 'a'), { customerId: 'fake', processed: true }));
    }
  }
});

async function seedMember(uid, { status = 'active', role = 'driver', companyId = 'a' } = {}) {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'users', uid), {
      email: `${uid}@example.test`, name: uid, role,
      companyId: status === 'active' ? companyId : '', membershipStatus: status,
      createdAt: Timestamp.now()
    });
    await setDoc(doc(ctx.firestore(), 'companies', companyId, 'members', uid), { role, status, displayName: uid });
  });
}
async function seedVehicle() {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'companies', 'a', 'vehicles', 'ABC123'), { plateNumber: 'ABC123', active: true });
  });
}
test('active driver can read company and vehicles, only own membership', async () => {
  await register('alice', 'a'); await seedMember('driver'); await seedMember('second'); await seedVehicle();
  await assertSucceeds(getDoc(doc(db('driver'), 'companies', 'a')));
  await assertSucceeds(getDocs(collection(db('driver'), 'companies', 'a', 'vehicles')));
  await assertSucceeds(getDoc(doc(db('driver'), 'companies', 'a', 'members', 'driver')));
  await assertFails(getDoc(doc(db('driver'), 'companies', 'a', 'members', 'second')));
  await assertFails(getDocs(collection(db('driver'), 'companies', 'a', 'members')));
  await assertFails(getDoc(doc(db('driver'), 'users', 'second')));
});
test('dispatcher and owner can list the team but dispatcher cannot edit it or company billing', async () => {
  await register('alice', 'a'); await seedMember('dispatch', { role: 'dispatcher' }); await seedMember('driver');
  for (const uid of ['alice', 'dispatch']) {
    await assertSucceeds(getDocs(collection(db(uid), 'companies', 'a', 'members')));
    await assertFails(updateDoc(doc(db(uid), 'companies', 'a', 'members', 'driver'), { role: 'dispatcher' }));
  }
  await assertFails(updateDoc(doc(db('dispatch'), 'companies', 'a'), { name: 'Changed' }));
  await assertFails(updateDoc(doc(db('dispatch'), 'companies', 'a'), { plan: 'paid' }));
});
test('pending and removed drivers see own status but cannot access company or vehicles', async () => {
  await register('alice', 'a'); await seedVehicle();
  for (const status of ['pending', 'removed', 'rejected', 'cancelled']) {
    await seedMember('driver', { status });
    await assertSucceeds(getDoc(doc(db('driver'), 'companies', 'a', 'members', 'driver')));
    await assertFails(getDoc(doc(db('driver'), 'companies', 'a')));
    await assertFails(getDoc(doc(db('driver'), 'companies', 'a', 'vehicles', 'ABC123')));
  }
});
test('profile alone, mismatched roles and stale membership do not grant tenant access', async () => {
  await register('alice', 'a'); await register('bob', 'b'); await seedVehicle();
  await seedUser('forged', { role: 'driver', companyId: 'a' });
  await assertFails(getDoc(doc(db('forged'), 'companies', 'a')));
  await seedMember('driver');
  await seedUser('driver', { role: 'dispatcher', companyId: 'a' });
  await assertFails(getDocs(collection(db('driver'), 'companies', 'a', 'members')));
  await seedUser('driver', { role: 'driver', companyId: 'b' });
  await assertFails(getDoc(doc(db('driver'), 'companies', 'a', 'vehicles', 'ABC123')));
});
test('direct client driver registration, approval, removal, vehicle and code writes are denied', async () => {
  await register('alice', 'a'); await seedMember('driver'); await seedVehicle();
  await assertFails(setDoc(doc(db('new'), 'users', 'new'), { name: 'New', role: 'driver', companyId: 'a' }));
  for (const uid of ['alice', 'driver']) {
    await assertFails(setDoc(doc(db(uid), 'companies', 'a', 'members', 'new'), { role: 'driver', status: 'active' }));
    await assertFails(updateDoc(doc(db(uid), 'companies', 'a', 'members', 'driver'), { status: 'removed' }));
    await assertFails(deleteDoc(doc(db(uid), 'companies', 'a', 'members', 'driver')));
    await assertFails(updateDoc(doc(db(uid), 'companies', 'a', 'vehicles', 'ABC123'), { active: false }));
    await assertFails(updateDoc(doc(db(uid), 'companies', 'a'), { companyCode: 'KR-AAAAAAAA' }));
  }
  await assertFails(updateDoc(doc(db('driver'), 'users', 'driver'), { membershipStatus: 'active', companyId: 'b' }));
  await assertSucceeds(updateDoc(doc(db('driver'), 'users', 'driver'), { name: 'New name' }));
});
test('codes and rate limits cannot be read or changed even by client super admin', async () => {
  await register('alice', 'a'); await seedUser('support', { role: 'super_admin' });
  for (const uid of ['alice', 'support']) {
    for (const path of ['companyCodes/KR-AAAAAAAA', 'companyJoinLimits/alice']) {
      await assertFails(getDoc(doc(db(uid), path)));
      await assertFails(setDoc(doc(db(uid), path), { companyId: 'a', attempts: [] }));
    }
  }
});
test('cross-company and anonymous membership or vehicle access is denied', async () => {
  await register('alice', 'a'); await register('bob', 'b'); await seedMember('driver'); await seedVehicle();
  const anon = env.unauthenticatedContext().firestore();
  for (const client of [anon, db('bob')]) {
    await assertFails(getDoc(doc(client, 'companies', 'a', 'members', 'driver')));
    await assertFails(getDocs(collection(client, 'companies', 'a', 'vehicles')));
  }
});
test('sessions and live locations remain inaccessible until sync rules are implemented', async () => {
  await register('alice', 'a'); await seedMember('driver');
  for (const uid of ['alice', 'driver']) {
    await assertFails(setDoc(doc(db(uid), 'companies', 'a', 'sessions', 's'), { driverUid: uid }));
    await assertFails(getDocs(query(collection(db(uid), 'companies', 'a', 'sessions'), where('driverUid', '==', uid))));
    await assertFails(setDoc(doc(db(uid), 'companies', 'a', 'liveLocations', uid), { lat: 55, lng: 24 }));
  }
});
