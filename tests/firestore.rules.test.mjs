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
test('invalid sessions and live locations are rejected', async () => {
  await register('alice', 'a'); await seedMember('driver');
  for (const uid of ['alice', 'driver']) {
    await assertFails(setDoc(doc(db(uid), 'companies', 'a', 'sessions', 's'), { driverUid: uid }));
    await assertSucceeds(getDocs(query(collection(db(uid), 'companies', 'a', 'sessions'), where('driverUid', '==', uid))));
    await assertFails(setDoc(doc(db(uid), 'companies', 'a', 'liveLocations', uid), { lat: 55, lng: 24 }));
  }
});

const sessionId = '12345678-1234-1234-1234-123456789abc';
const sessionPath = `companies/a/sessions/${sessionId}`;
function sessionData(uid = 'driver', patch = {}) {
  return { schemaVersion: 1, driverUid: uid, deviceId: sessionId, revision: 1, completeRevision: 0,
    date: '2026-09-26', startedAt: 100000, endedAt: null, loadingPlace: 'A', unloadingPlace: 'B',
    truck: 'ABC123', trailer: '', defaultWeight: 27, loadingLat: null, loadingLon: null,
    unloadingLat: null, unloadingLon: null, zoneRadiusM: 150, autoCount: true,
    billingMode: 'PER_TRIP', rate: 10, tripsCount: 1, tonnes: 27, km: 7, earnings: 10,
    updatedAt: serverTimestamp(), ...patch };
}
function tripData(patch = {}) {
  return { tripNumber: 1, timestamp: 110000, latitude: 55, longitude: 24, weight: 27, source: 'MANUAL',
    startTimestamp: 100000, distanceKm: 7, durationMs: 10000, deleted: false, revision: 1, updatedAt: serverTimestamp(), ...patch };
}
function chunkData(patch = {}) {
  return { encoding: 'polyline5', polyline: '_p~iF~ps|U', times: [110000], accuracies: [5], speeds: [10],
    pointCount: 1, firstPointId: 1, lastPointId: 1, revision: 1, updatedAt: serverTimestamp(), ...patch };
}
async function setupSync() { await register('alice', 'a'); await seedMember('driver'); }
test('owner and driver can create own sessions, stage children and finish an upload', async () => {
  await setupSync();
  for (const uid of ['alice', 'driver']) {
    const path = `companies/a/sessions/${uid === 'alice' ? '22345678-1234-1234-1234-123456789abc' : sessionId}`;
    const client = db(uid);
    await assertSucceeds(getDoc(doc(client, path))); // missing-document probe
    await assertSucceeds(setDoc(doc(client, path), sessionData(uid)));
    const batch = writeBatch(client);
    batch.set(doc(client, path, 'trips', '1'), tripData());
    batch.set(doc(client, path, 'routeChunks', '0'), chunkData());
    await assertSucceeds(batch.commit());
    await assertSucceeds(updateDoc(doc(client, path), { completeRevision: 1, updatedAt: serverTimestamp() }));
  }
});
test('driver cannot forge another driver or write into another tenant', async () => {
  await setupSync(); await register('bob', 'b');
  await assertFails(setDoc(doc(db('driver'), sessionPath), sessionData('alice')));
  await assertFails(setDoc(doc(db('driver'), `companies/b/sessions/${sessionId}`), sessionData()));
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), sessionPath), sessionData()));
});
test('driver reads only own work while dispatcher and owner can read company work', async () => {
  await setupSync(); await seedMember('second'); await seedMember('dispatch', { role: 'dispatcher' });
  await setDoc(doc(db('driver'), sessionPath), sessionData());
  await setDoc(doc(db('driver'), sessionPath, 'trips', '1'), tripData());
  for (const uid of ['driver', 'alice', 'dispatch']) {
    await assertSucceeds(getDoc(doc(db(uid), sessionPath)));
    await assertSucceeds(getDocs(collection(db(uid), sessionPath, 'trips')));
  }
  await assertFails(getDoc(doc(db('second'), sessionPath)));
  await assertFails(getDocs(collection(db('second'), sessionPath, 'trips')));
  await assertFails(getDocs(collection(db('driver'), 'companies/a/sessions')));
  await assertSucceeds(getDocs(query(collection(db('driver'), 'companies/a/sessions'), where('driverUid', '==', 'driver'))));
  for (const uid of ['alice', 'dispatch']) await assertSucceeds(getDocs(collection(db(uid), 'companies/a/sessions')));
});
test('removal immediately denies reads and uploads but preserves existing history', async () => {
  await setupSync(); await setDoc(doc(db('driver'), sessionPath), sessionData());
  await seedMember('driver', { status: 'removed' });
  await assertFails(getDoc(doc(db('driver'), sessionPath)));
  await assertFails(updateDoc(doc(db('driver'), sessionPath), { revision: 2, updatedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(db('alice'), sessionPath)));
});
test('retries cannot regress revisions, reopen a completed revision or change ownership', async () => {
  await setupSync(); const client = db('driver');
  await setDoc(doc(client, sessionPath), sessionData('driver', { revision: 3 }));
  await assertFails(setDoc(doc(client, sessionPath), sessionData('driver', { revision: 2 })));
  await assertFails(updateDoc(doc(client, sessionPath), { deviceId: '22345678-1234-1234-1234-123456789abc', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(client, sessionPath), { startedAt: 999, updatedAt: serverTimestamp() }));
  await updateDoc(doc(client, sessionPath), { completeRevision: 3, updatedAt: serverTimestamp() });
  await assertFails(setDoc(doc(client, sessionPath), sessionData('driver', { revision: 3 })));
  await assertSucceeds(setDoc(doc(client, sessionPath), sessionData('driver', { revision: 4 })));
  await assertFails(updateDoc(doc(client, sessionPath), { completeRevision: 3, updatedAt: serverTimestamp() }));
});
test('trip undo is a versioned tombstone, physical deletes and late children are denied', async () => {
  await setupSync(); const client = db('driver');
  await setDoc(doc(client, sessionPath), sessionData());
  await setDoc(doc(client, sessionPath, 'trips', '1'), tripData());
  await updateDoc(doc(client, sessionPath), { completeRevision: 1, updatedAt: serverTimestamp() });
  await assertFails(updateDoc(doc(client, sessionPath, 'trips', '1'), { deleted: true, updatedAt: serverTimestamp() }));
  await setDoc(doc(client, sessionPath), sessionData('driver', { revision: 2, tripsCount: 0, tonnes: 0 }));
  await assertSucceeds(setDoc(doc(client, sessionPath, 'trips', '1'), tripData({ revision: 2, deleted: true })));
  await assertFails(setDoc(doc(client, sessionPath, 'trips', '1'), tripData({ revision: 1 })));
  await assertFails(deleteDoc(doc(client, sessionPath, 'trips', '1')));
  await assertFails(deleteDoc(doc(client, sessionPath)));
});
test('session and child payload validation rejects extra authority fields and invalid coordinates', async () => {
  await setupSync(); const client = db('driver');
  for (const patch of [{ contractorKm: 7 }, { schemaVersion: 2 }, { loadingLat: 91 }, { rate: -1 }, { endedAt: 1 }]) {
    await assertFails(setDoc(doc(client, sessionPath), sessionData('driver', patch)));
  }
  await setDoc(doc(client, sessionPath), sessionData());
  for (const patch of [{ latitude: 91 }, { weight: -1 }, { approved: true }, { deleted: 'yes' }]) {
    await assertFails(setDoc(doc(client, sessionPath, 'trips', '1'), tripData(patch)));
  }
  for (const patch of [{ pointCount: 501 }, { times: [] }, { firstPointId: 0 }, { encoding: 'unknown' }]) {
    await assertFails(setDoc(doc(client, sessionPath, 'routeChunks', '0'), chunkData(patch)));
  }
});
test('end time cannot be reopened and managers cannot alter driver work', async () => {
  await setupSync(); await seedMember('dispatch', { role: 'dispatcher' });
  await setDoc(doc(db('driver'), sessionPath), sessionData('driver', { endedAt: 120000 }));
  await assertFails(setDoc(doc(db('driver'), sessionPath), sessionData('driver', { revision: 2 })));
  for (const uid of ['alice', 'dispatch']) {
    await assertFails(updateDoc(doc(db(uid), sessionPath), { km: 100, updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(db(uid), sessionPath, 'trips', '1'), tripData()));
  }
});
