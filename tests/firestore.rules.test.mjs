import { before, after, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { collection, getDocs, query, orderBy, documentId, limit, doc, setDoc, getDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';
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
