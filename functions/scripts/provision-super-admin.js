import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const email = valueOf('--email') || process.env.ADMIN_EMAIL;
const projectId = valueOf('--project') || process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const apply = process.argv.includes('--apply');

if (!email) {
  console.error('Usage: npm run provision-admin -- --email owner@example.com [--project PROJECT_ID] [--apply]');
  process.exit(2);
}

initializeApp({
  credential: applicationDefault(),
  ...(projectId ? { projectId } : {}),
});

const auth = getAuth();
const db = getFirestore();

const user = await auth.getUserByEmail(email.trim());
const userRef = db.doc(`users/${user.uid}`);
const userSnapshot = await userRef.get();

if (!userSnapshot.exists) {
  throw new Error('The Firebase user has no Firestore profile. Register this account in the Android app first.');
}

const profile = userSnapshot.data() || {};
if (profile.role === 'super_admin') {
  console.log(`Already super_admin: ${email} (${user.uid})`);
  process.exit(0);
}

if (profile.role !== 'company_admin' || typeof profile.companyId !== 'string' || !profile.companyId) {
  throw new Error('Only an existing company owner profile can be promoted by this script.');
}

const company = await db.doc(`companies/${profile.companyId}`).get();
if (!company.exists || company.data()?.ownerUid !== user.uid) {
  throw new Error('Refusing promotion: the account is not the verified owner of its company.');
}

console.log(`Verified owner: ${email}`);
console.log(`UID: ${user.uid}`);
console.log(`Company: ${profile.companyId}`);

if (!apply) {
  console.log('Dry run only. Re-run with --apply to set role=super_admin.');
  process.exit(0);
}

await userRef.update({ role: 'super_admin' });
console.log('Promotion complete. Sign out and sign in again in the Android app.');
