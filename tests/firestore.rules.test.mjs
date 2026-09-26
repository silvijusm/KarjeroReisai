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
