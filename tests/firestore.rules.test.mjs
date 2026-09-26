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
const company = (uid, patch = {}) => ({ name: 'Test company', ownerUid: uid, plan: 'trial', trialEndsAtMillis: Date.now() + 30 * 86400000, createdAt: serverTimestamp(), ...patch });
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
  await assertFails(register('alice', 'a', { trialEndsAtMillis: Date.now() + 60 * 86400000 }));
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

// ---- 2 etapas: vairuotojai, dispečeriai, automobiliai ----
async function seed(path, data) {
  await env.withSecurityRulesDisabled(async ctx => setDoc(doc(ctx.firestore(), ...path.split('/')), data));
}
// Company "a" (owner alice) with a driver, a dispatcher, a pending and a removed member.
async function team() {
  await register('alice', 'a');
  const member = (role, status, name) => ({ role, status, displayName: name, email: `${name}@example.test`, companyName: 'Test company', joinedAtMillis: 1 });
  const user = (uid, role) => ({ email: `${uid}@example.test`, name: uid, role, companyId: 'a', createdAtMillis: 1 });
  for (const [uid, role, status] of [['jonas', 'driver', 'active'], ['petras', 'driver', 'active'], ['disp', 'dispatcher', 'active'], ['naujas', 'driver', 'pending'], ['buves', 'driver', 'removed']]) {
    await seed(`companies/a/members/${uid}`, member(role, status, uid));
    await seedUser(uid, user(uid, role));
  }
  await seed('companies/a/vehicles/v1', { plateNumber: 'ABC123', name: 'Volvo', active: true, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
}
const vehicle = (patch = {}) => ({ plateNumber: 'XYZ789', name: '', active: true, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...patch });

test('driver reads own membership and company, but not other members', async () => {
  await team();
  await assertSucceeds(getDoc(doc(db('jonas'), 'companies/a/members/jonas')));
  await assertSucceeds(getDoc(doc(db('jonas'), 'companies', 'a')));
  await assertFails(getDoc(doc(db('jonas'), 'companies/a/members/petras')));
  await assertFails(getDocs(collection(db('jonas'), 'companies/a/members')));
  await assertFails(getDoc(doc(db('jonas'), 'users', 'petras')));
});
test('pending and removed members see only their own record', async () => {
  await team();
  for (const uid of ['naujas', 'buves']) {
    await assertSucceeds(getDoc(doc(db(uid), `companies/a/members/${uid}`)));
    await assertFails(getDoc(doc(db(uid), 'companies', 'a')));
    await assertFails(getDocs(collection(db(uid), 'companies/a/vehicles')));
  }
});
test('owner and dispatcher list all members; another company cannot', async () => {
  await team(); await register('bob', 'b');
  await assertSucceeds(getDocs(collection(db('alice'), 'companies/a/members')));
  await assertSucceeds(getDocs(collection(db('disp'), 'companies/a/members')));
  await assertFails(getDocs(collection(db('bob'), 'companies/a/members')));
  await assertFails(getDocs(collection(db('bob'), 'companies/a/vehicles')));
});
test('clients can never write memberships, codes or rate limits', async () => {
  await team();
  for (const uid of ['alice', 'jonas', 'naujas', 'disp']) {
    await assertFails(setDoc(doc(db(uid), `companies/a/members/${uid}`), { role: 'company_admin', status: 'active' }));
    await assertFails(updateDoc(doc(db(uid), 'companies/a/members/naujas'), { status: 'active' }));
    await assertFails(setDoc(doc(db(uid), 'companyCodes', 'KR-AAAAAA'), { companyId: 'a' }));
    await assertFails(getDoc(doc(db(uid), 'companyCodes', 'KR-AAAAAA')));
    await assertFails(setDoc(doc(db(uid), 'rateLimits', `join_${uid}`), { count: 0 }));
  }
  await assertFails(setDoc(doc(db('stranger'), 'companies/a/members/stranger'), { role: 'driver', status: 'active' }));
});
test('active driver and dispatcher read vehicles but cannot edit them', async () => {
  await team();
  for (const uid of ['jonas', 'disp']) {
    await assertSucceeds(getDocs(collection(db(uid), 'companies/a/vehicles')));
    await assertFails(setDoc(doc(db(uid), 'companies/a/vehicles/v2'), vehicle()));
    await assertFails(updateDoc(doc(db(uid), 'companies/a/vehicles/v1'), { active: false, updatedAt: serverTimestamp() }));
  }
});
test('owner adds and deactivates vehicles with valid fields only; no deletes', async () => {
  await team();
  await assertSucceeds(setDoc(doc(db('alice'), 'companies/a/vehicles/v2'), vehicle()));
  await assertSucceeds(updateDoc(doc(db('alice'), 'companies/a/vehicles/v1'), { active: false, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(db('alice'), 'companies/a/vehicles/v3'), vehicle({ plateNumber: '' })));
  await assertFails(setDoc(doc(db('alice'), 'companies/a/vehicles/v3'), vehicle({ plateNumber: 'X'.repeat(21) })));
  await assertFails(setDoc(doc(db('alice'), 'companies/a/vehicles/v3'), vehicle({ extra: 1 })));
  await assertFails(deleteDoc(doc(db('alice'), 'companies/a/vehicles/v1')));
});
test('profile claiming a role without matching active membership gets nothing', async () => {
  await team();
  await seedUser('fake', { email: 'fake@example.test', name: 'fake', role: 'dispatcher', companyId: 'a', createdAtMillis: 1 });
  await assertFails(getDocs(collection(db('fake'), 'companies/a/members')));
  await assertFails(getDoc(doc(db('fake'), 'companies', 'a')));
  // Driver record + dispatcher profile mismatch is also denied.
  await seedUser('jonas', { email: 'jonas@example.test', name: 'jonas', role: 'dispatcher', companyId: 'a', createdAtMillis: 1 });
  await assertFails(getDocs(collection(db('jonas'), 'companies/a/members')));
});
test('members cannot change their own profile role or company', async () => {
  await team();
  await assertFails(updateDoc(doc(db('jonas'), 'users', 'jonas'), { role: 'dispatcher' }));
  await assertFails(updateDoc(doc(db('jonas'), 'users', 'jonas'), { companyId: 'b' }));
  await assertSucceeds(updateDoc(doc(db('jonas'), 'users', 'jonas'), { name: 'Jonas J.' }));
});

// ---- 3 etapas: sesijos, maršrutas, gyva vieta ----
const session = (uid, patch = {}) => ({ driverUid: uid, driverName: uid, plate: 'ABC123', trailer: '', loadingPlace: 'A', unloadingPlace: 'B',
  date: '2026-09-26', startedAtMillis: 1000, endedAtMillis: null, tripsCount: 1, tonnes: 26, km: 7,
  trips: [{ n: 1, atMillis: 2000, weightT: 26 }], updatedAtMillis: 3000, ...patch });
const live = (patch = {}) => ({ lat: 55.7, lng: 24.3, speedKmh: 40, heading: 0, accuracyM: 5, updatedAtMillis: 3000, sessionId: 's1',
  plate: 'ABC123', driverName: 'jonas', state: 'moving', tripsCount: 1, tonnes: 26, startedAtMillis: 1000, ...patch });
const route = uid => ({ driverUid: uid, lat: [55.1, 55.2], lng: [24.1, 24.2], t: [1, 2], firstMillis: 1 });

test('active driver writes own session, route and live position', async () => {
  await team();
  const c = db('jonas');
  await assertSucceeds(setDoc(doc(c, 'companies/a/sessions/s1'), session('jonas')));
  await assertSucceeds(setDoc(doc(c, 'companies/a/sessions/s1/route/1'), route('jonas')));
  await assertSucceeds(setDoc(doc(c, 'companies/a/liveLocations/jonas'), live()));
  await assertSucceeds(setDoc(doc(c, 'companies/a/liveLocations/jonas'), { state: 'offline', updatedAtMillis: 4000 }, { merge: true }));
  await assertSucceeds(getDoc(doc(c, 'companies/a/sessions/s1')));
});
test('owner can also record own work', async () => {
  await team();
  await assertSucceeds(setDoc(doc(db('alice'), 'companies/a/sessions/o1'), session('alice')));
  await assertSucceeds(setDoc(doc(db('alice'), 'companies/a/liveLocations/alice'), live()));
});
test('driver cannot write as another driver or overwrite their session', async () => {
  await team();
  await seed('companies/a/sessions/p1', session('petras'));
  await assertFails(setDoc(doc(db('jonas'), 'companies/a/sessions/x'), session('petras')));
  await assertFails(setDoc(doc(db('jonas'), 'companies/a/sessions/p1'), session('jonas')));
  await assertFails(setDoc(doc(db('jonas'), 'companies/a/liveLocations/petras'), live()));
  await assertFails(setDoc(doc(db('jonas'), 'companies/a/sessions/p1/route/1'), route('jonas')));
});
test('driver cannot read other drivers sessions, routes or the live map', async () => {
  await team();
  await seed('companies/a/sessions/p1', session('petras'));
  await seed('companies/a/sessions/p1/route/1', route('petras'));
  await seed('companies/a/liveLocations/petras', live());
  await assertFails(getDoc(doc(db('jonas'), 'companies/a/sessions/p1')));
  await assertFails(getDoc(doc(db('jonas'), 'companies/a/sessions/p1/route/1')));
  await assertFails(getDocs(collection(db('jonas'), 'companies/a/liveLocations')));
  await assertFails(getDocs(collection(db('jonas'), 'companies/a/sessions')));
});
test('owner and dispatcher see the live map and all sessions; other company does not', async () => {
  await team(); await register('bob', 'b');
  await seed('companies/a/sessions/p1', session('petras'));
  await seed('companies/a/sessions/p1/route/1', route('petras'));
  await seed('companies/a/liveLocations/petras', live());
  for (const uid of ['alice', 'disp']) {
    await assertSucceeds(getDocs(collection(db(uid), 'companies/a/liveLocations')));
    await assertSucceeds(getDocs(collection(db(uid), 'companies/a/sessions')));
    await assertSucceeds(getDocs(collection(db(uid), 'companies/a/sessions/p1/route')));
  }
  await assertFails(getDocs(collection(db('bob'), 'companies/a/liveLocations')));
  await assertFails(getDocs(collection(db('bob'), 'companies/a/sessions')));
});
test('pending or removed drivers cannot record work; old sessions remain readable to the owner', async () => {
  await team();
  await seed('companies/a/sessions/b1', session('buves'));
  for (const uid of ['naujas', 'buves']) {
    await assertFails(setDoc(doc(db(uid), `companies/a/sessions/${uid}2`), session(uid)));
    await assertFails(setDoc(doc(db(uid), `companies/a/liveLocations/${uid}`), live()));
  }
  await assertSucceeds(getDoc(doc(db('alice'), 'companies/a/sessions/b1')));
});
test('invalid session, route and live data are rejected', async () => {
  await team();
  const c = db('jonas');
  await assertFails(setDoc(doc(c, 'companies/a/sessions/s2'), session('jonas', { admin: true })));
  await assertFails(setDoc(doc(c, 'companies/a/sessions/s2'), session('jonas', { startedAtMillis: 'x' })));
  await assertFails(setDoc(doc(c, 'companies/a/sessions/s2/route/1'), { ...route('jonas'), lng: [1] }));
  await assertFails(setDoc(doc(c, 'companies/a/liveLocations/jonas'), live({ state: 'flying' })));
  await assertFails(deleteDoc(doc(c, 'companies/a/liveLocations/jonas')));
});

// ---- 9–10 etapai: rangovo objektai, vežėjai, krovėjas ----
// Contractor "b" (owner bob) with object o1 and loader "kasys"; carrier "a" (alice + drivers) approved.
async function contractor({ approved = true } = {}) {
  await team(); await register('bob', 'b');
  await seed('companies/b/objects/o1', { name: 'Kelias A1', objectCode: 'P-256', status: 'active', distanceKm: 7 });
  await seed('companies/b/objects/o1/carriers/a', { carrierName: 'Test company', status: approved ? 'active' : 'pending' });
  await seed('companies/b/members/kasys', { role: 'loader', status: 'active', displayName: 'Kasys', email: 'k@example.test' });
  await seedUser('kasys', { email: 'kasys@example.test', name: 'Kasys', role: 'loader', companyId: 'b', createdAtMillis: 1 });
}
const load = (patch = {}) => ({ plate: 'ABC123', carrierId: 'a', carrierName: 'Test company', material: 'Smėlis', tonnes: 26, m3: 16.3,
  distanceKm: 7, loadedAtMillis: 5000, createdAtMillis: 5000, loaderUid: 'kasys', loaderName: 'Kasys', source: 'qr', note: '', status: 'loaded', ...patch });
const object = (patch = {}) => ({ name: 'Objektas', objectCode: 'P-1', status: 'active', distanceKm: 7, materials: [{ name: 'Smėlis', densityTm3: 1.6, tonnesPerTrip: 26 }],
  vehicleTonnes: {}, allowLoaderOverride: false, createdAtMillis: 1, updatedAtMillis: 1, ...patch });

test('contractor admin creates objects but cannot set the join code', async () => {
  await contractor();
  await assertSucceeds(setDoc(doc(db('bob'), 'companies/b/objects/o2'), object()));
  await assertFails(setDoc(doc(db('bob'), 'companies/b/objects/o3'), object({ joinCode: 'OB-AAAAAA' })));
  await assertFails(setDoc(doc(db('kasys'), 'companies/b/objects/o4'), object()));
  await assertFails(setDoc(doc(db('alice'), 'companies/b/objects/o5'), object()));
});
test('approved carrier driver reads the object; pending carrier and strangers do not', async () => {
  await contractor();
  await assertSucceeds(getDoc(doc(db('jonas'), 'companies/b/objects/o1')));
  await assertSucceeds(getDoc(doc(db('alice'), 'companies/b/objects/o1/carriers/a')));
  await assertFails(getDoc(doc(db('naujas'), 'companies/b/objects/o1')));
  await assertFails(getDocs(collection(db('jonas'), 'companies/b/objects/o1/carriers')));
});
test('pending carrier cannot see the object', async () => {
  await contractor({ approved: false });
  await assertFails(getDoc(doc(db('jonas'), 'companies/b/objects/o1')));
});
test('loader registers a load for an approved carrier only', async () => {
  await contractor();
  await assertSucceeds(setDoc(doc(db('kasys'), 'companies/b/objects/o1/loads/l1'), load()));
  await assertFails(setDoc(doc(db('kasys'), 'companies/b/objects/o1/loads/l2'), load({ carrierId: 'zzz' })));
  await assertFails(setDoc(doc(db('kasys'), 'companies/b/objects/o1/loads/l3'), load({ loaderUid: 'bob' })));
  await assertFails(setDoc(doc(db('kasys'), 'companies/b/objects/o1/loads/l4'), load({ tonnes: 500 })));
  await assertFails(setDoc(doc(db('jonas'), 'companies/b/objects/o1/loads/l5'), load({ loaderUid: 'jonas' })));
});
test('driver sees own company loads, confirms, but cannot change tonnes or km', async () => {
  await contractor();
  await seed('companies/b/objects/o1/loads/l1', load());
  await assertSucceeds(getDocs(query(collection(db('jonas'), 'companies/b/objects/o1/loads'), where('carrierId', '==', 'a'), where('plate', '==', 'ABC123'))));
  await assertFails(getDocs(collection(db('jonas'), 'companies/b/objects/o1/loads')));
  await assertFails(updateDoc(doc(db('jonas'), 'companies/b/objects/o1/loads/l1'), { tonnes: 30 }));
  await assertFails(updateDoc(doc(db('jonas'), 'companies/b/objects/o1/loads/l1'), { distanceKm: 20, status: 'confirmed', driverUid: 'jonas' }));
  await assertSucceeds(updateDoc(doc(db('jonas'), 'companies/b/objects/o1/loads/l1'), { status: 'confirmed', driverUid: 'jonas', confirmedAtMillis: 6000 }));
});
test('contractor corrects tonnes with history; loader cancels own entry', async () => {
  await contractor();
  await seed('companies/b/objects/o1/loads/l1', load());
  await assertFails(updateDoc(doc(db('bob'), 'companies/b/objects/o1/loads/l1'), { tonnes: 20, editedBy: 'bob', editedAtMillis: 1 }));
  await assertSucceeds(updateDoc(doc(db('bob'), 'companies/b/objects/o1/loads/l1'),
    { tonnes: 20, editedBy: 'bob', editedAtMillis: 1, history: [{ by: 'bob', field: 'tonnes', old: 26, new: 20, reason: 'mažesnė mašina' }] }));
  await assertSucceeds(updateDoc(doc(db('kasys'), 'companies/b/objects/o1/loads/l1'), { status: 'cancelled' }));
  await assertFails(deleteDoc(doc(db('bob'), 'companies/b/objects/o1/loads/l1')));
});
test('contractor sees carrier vehicle only on its object, never the carrier map', async () => {
  await contractor();
  await assertSucceeds(setDoc(doc(db('jonas'), 'companies/b/objects/o1/live/jonas'), { ...live(), carrierId: 'a', carrierName: 'Test company' }));
  await assertSucceeds(getDocs(collection(db('bob'), 'companies/b/objects/o1/live')));
  await assertSucceeds(getDocs(collection(db('kasys'), 'companies/b/objects/o1/live')));
  await assertFails(getDocs(collection(db('bob'), 'companies/a/liveLocations')));
  await assertFails(getDocs(collection(db('bob'), 'companies/a/sessions')));
  await assertFails(setDoc(doc(db('jonas'), 'companies/b/objects/o1/live/jonas'), { ...live(), carrierId: 'b' }));
});
test('object codes, links and carrier records are server-written only', async () => {
  await contractor();
  await assertFails(setDoc(doc(db('alice'), 'companies/b/objects/o1/carriers/a'), { status: 'active' }));
  await assertFails(setDoc(doc(db('alice'), 'companies/a/objectLinks/o1'), { status: 'active' }));
  await assertFails(setDoc(doc(db('bob'), 'objectCodes', 'OB-AAAAAA'), { contractorId: 'b' }));
  await assertSucceeds(getDoc(doc(db('jonas'), 'companies/a/objectLinks/o1')));
});
