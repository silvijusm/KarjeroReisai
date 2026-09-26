import { HttpsError } from 'firebase-functions/v2/https';

// "Delete my account" (Google Play requirement: users who can create an account in the app
// must be able to delete it from the app).
//
// - Driver / dispatcher / loader: leaves the company and loses access. Work already recorded
//   (trips, loads) stays with the employer, who is the data controller for work records;
//   the live position and the profile are deleted.
// - Company owner: the whole company is deleted – members, vehicles, trips, GPS routes, objects,
//   loads, invoices. Blocked while a paid subscription is still running (cancel it first).
// - Finally the sign-in (Firebase Auth user) is deleted.

const MEMBER_ROLES = ['driver', 'dispatcher', 'loader'];
const RUNNING = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'];

export function createAccountService({ db, deleteTree, deleteAuthUser, now = Date.now }) {
  async function detachFromContractors(companyId) {
    // Objects of other contractors this company carried for: mark the carrier as removed.
    const links = await db.collection(`companies/${companyId}/objectLinks`).get();
    for (const link of links.docs) {
      const l = link.data() || {};
      if (typeof l.contractorId !== 'string' || l.contractorId === companyId) continue;
      await db.doc(`companies/${l.contractorId}/objects/${link.id}/carriers/${companyId}`)
        .set({ status: 'removed', removedAtMillis: now(), removedReason: 'account_deleted' }, { merge: true });
    }
  }

  async function detachCarriers(companyId) {
    // This company's own objects: carriers lose the link, join codes stop working.
    const objects = await db.collection(`companies/${companyId}/objects`).get();
    for (const object of objects.docs) {
      const o = object.data() || {};
      if (typeof o.joinCode === 'string') await db.doc(`objectCodes/${o.joinCode}`).delete();
      const carriers = await db.collection(`companies/${companyId}/objects/${object.id}/carriers`).get();
      for (const carrier of carriers.docs) {
        if (carrier.id === companyId) continue;
        await db.doc(`companies/${carrier.id}/objectLinks/${object.id}`)
          .set({ status: 'removed', updatedAtMillis: now() }, { merge: true });
      }
    }
  }

  async function deleteCompany(companyId, company) {
    const members = await db.collection(`companies/${companyId}/members`).get();
    await detachFromContractors(companyId);
    await detachCarriers(companyId);
    if (typeof company.companyCode === 'string') await db.doc(`companyCodes/${company.companyCode}`).delete();
    // Former members keep their sign-in but no longer belong to a company.
    for (const m of members.docs) {
      const ref = db.doc(`users/${m.id}`);
      const user = (await ref.get()).data();
      if (user?.companyId === companyId && MEMBER_ROLES.includes(user.role)) await ref.delete();
    }
    await deleteTree(db.doc(`companies/${companyId}`));
  }

  return {
    async deleteAccount(auth, data) {
      const uid = auth?.uid;
      if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
      if (data?.confirm !== true) throw new HttpsError('invalid-argument', 'Confirmation required.');
      const userRef = db.doc(`users/${uid}`);
      const profile = (await userRef.get()).data() || {};
      const companyId = typeof profile.companyId === 'string' && profile.companyId && !profile.companyId.includes('/') ? profile.companyId : null;
      const company = companyId ? (await db.doc(`companies/${companyId}`).get()).data() : null;
      let deleted = 'profile';

      if (company && company.ownerUid === uid) {
        const billingRef = db.doc(`billingCustomers/${companyId}`);
        const billing = (await billingRef.get()).data() || {};
        if (billing.subscriptionId && RUNNING.includes(billing.subscriptionStatus) && !billing.cancelAtPeriodEnd) {
          throw new HttpsError('failed-precondition', 'subscription-active');
        }
        await deleteCompany(companyId, company);
        await billingRef.delete();
        deleted = 'company';
      } else if (company) {
        const memberRef = db.doc(`companies/${companyId}/members/${uid}`);
        if ((await memberRef.get()).exists) {
          await memberRef.set({ status: 'removed', removedAtMillis: now(), removedReason: 'account_deleted',
            email: null, displayName: 'Ištrinta paskyra' }, { merge: true });
        }
        await db.doc(`companies/${companyId}/liveLocations/${uid}`).delete();
        deleted = 'membership';
      }

      await db.doc(`rateLimits/join_${uid}`).delete();
      await userRef.delete();
      await deleteAuthUser(uid);
      return { ok: true, deleted };
    },
  };
}
