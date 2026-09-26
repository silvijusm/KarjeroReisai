import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { createMembersService } from './members.js';
import { createRetentionService } from './retention.js';
import { createAccountService } from './account.js';

// Company membership: codes, join requests, approval, roles.
// Separate codebase from billing so it deploys without Stripe secrets.
initializeApp();
const options = { region: 'europe-west1', maxInstances: 5, timeoutSeconds: 30 };
function callable(method) {
  return onCall(options, async request => {
    try { return await createMembersService({ db: getFirestore() })[method](request.auth, request.data); }
    catch (error) {
      if (error instanceof HttpsError) throw error;
      console.error('Membership operation failed', { method, code: typeof error.code === 'string' ? error.code : 'unknown' });
      throw new HttpsError('internal', 'Please try again.');
    }
  });
}
export const companyCode = callable('companyCode');
export const joinCompany = callable('joinCompany');
export const cancelJoin = callable('cancelJoin');
export const approveMember = callable('approveMember');
export const rejectMember = callable('rejectMember');
export const removeMember = callable('removeMember');
export const setMemberRole = callable('setMemberRole');
export const objectJoinCode = callable('objectJoinCode');
export const joinObject = callable('joinObject');
export const approveCarrier = callable('approveCarrier');
export const removeCarrier = callable('removeCarrier');

// "Delete my account" from the app (Google Play requirement).
export const deleteAccount = onCall({ ...options, timeoutSeconds: 300 }, async request => {
  try {
    const db = getFirestore();
    return await createAccountService({
      db,
      deleteTree: ref => db.recursiveDelete(ref),
      deleteAuthUser: async uid => { try { await getAuth().deleteUser(uid); } catch (e) { if (e?.code !== 'auth/user-not-found') throw e; } },
    }).deleteAccount(request.auth, request.data);
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error('Account deletion failed', { code: typeof error.code === 'string' ? error.code : 'unknown' });
    throw new HttpsError('internal', 'Please try again.');
  }
});

// Every night: delete precise GPS points older than the company retention period.
export const purgeOldLocations = onSchedule({ schedule: 'every day 03:30', timeZone: 'Europe/Vilnius', region: 'europe-west1', timeoutSeconds: 540 }, async () => {
  const result = await createRetentionService({ db: getFirestore() }).purgeAll();
  console.log('Retention done', result);
});
