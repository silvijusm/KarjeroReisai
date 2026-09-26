import { randomInt } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';

// Company membership: company codes, driver join requests, approval, roles.
// All membership state is written here with the Admin SDK; Firestore rules
// deny every client write to members, companyCodes and rateLimits.

// No 0/O, 1/I/L – easy to read aloud and type on a phone.
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;
export const JOIN_LIMIT_PER_HOUR = 10;
// loader = excavator operator at the quarry (free, registers loads).
const ASSIGNABLE_ROLES = ['driver', 'dispatcher', 'loader'];

export function generateCode(random = randomInt, prefix = 'KR') {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  return `${prefix}-${code}`;
}

// Accepts "kr-ab3k9q", "AB3K9Q", "KR AB3 K9Q". Returns null when malformed.
export function normalizeCode(value, prefix = 'KR') {
  if (typeof value !== 'string') return null;
  let clean = value.toUpperCase().replace(/[\s-]/g, '');
  if (clean.startsWith(prefix)) clean = clean.slice(prefix.length);
  if (clean.length !== CODE_LENGTH || [...clean].some(c => !CODE_ALPHABET.includes(c))) return null;
  return `${prefix}-${clean}`;
}

export function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length > 0 && name.length <= 100 ? name : null;
}

function validUid(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
}

export function createMembersService({ db, now = Date.now, random = randomInt }) {
  function requireAuth(auth) {
    if (!auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
    return auth.uid;
  }

  // Resolves the caller's company and checks they may manage it.
  // needAdmin=true: owner or member with role company_admin (or super_admin in own company).
  // needAdmin=false: also active dispatchers.
  async function manager(auth, needAdmin) {
    const uid = requireAuth(auth);
    const profile = (await db.doc(`users/${uid}`).get()).data();
    const companyId = profile?.companyId;
    if (typeof companyId !== 'string' || !validUid(companyId)) throw new HttpsError('permission-denied', 'No company.');
    const companyRef = db.doc(`companies/${companyId}`);
    const company = (await companyRef.get()).data();
    if (!company) throw new HttpsError('permission-denied', 'No company.');
    const isOwner = company.ownerUid === uid && ['company_admin', 'super_admin'].includes(profile.role);
    if (!isOwner) {
      const member = (await db.doc(`companies/${companyId}/members/${uid}`).get()).data();
      const allowed = needAdmin ? ['company_admin'] : ['company_admin', 'dispatcher'];
      if (member?.status !== 'active' || !allowed.includes(member.role) || member.role !== profile.role) {
        throw new HttpsError('permission-denied', 'Company management rights are required.');
      }
    }
    return { uid, companyId, companyRef, company };
  }

  async function objectFor(companyId, objectId) {
    if (!validUid(objectId)) throw new HttpsError('invalid-argument', 'Object is required.');
    const ref = db.doc(`companies/${companyId}/objects/${objectId}`);
    const data = (await ref.get()).data();
    if (!data) throw new HttpsError('not-found', 'Object not found.');
    return { ref, data };
  }

  async function setCarrierStatus(auth, data, status) {
    const { uid, companyId } = await manager(auth, true);
    const { ref: objectRef } = await objectFor(companyId, data?.objectId);
    if (!validUid(data?.carrierId)) throw new HttpsError('invalid-argument', 'Carrier is required.');
    const carrierRef = db.doc(`${objectRef.path}/carriers/${data.carrierId}`);
    const carrier = (await carrierRef.get()).data();
    if (!carrier) throw new HttpsError('not-found', 'Carrier not found.');
    const t = now();
    const batch = db.batch();
    batch.set(carrierRef, { status, decidedBy: uid, decidedAtMillis: t }, { merge: true });
    batch.set(db.doc(`companies/${data.carrierId}/objectLinks/${data.objectId}`), { status, updatedAtMillis: t }, { merge: true });
    await batch.commit();
    return { ok: true };
  }

  async function rateLimit(uid) {
    const ref = db.doc(`rateLimits/join_${uid}`);
    await db.runTransaction(async tx => {
      const data = (await tx.get(ref)).data();
      const t = now();
      const fresh = !data || t - (data.windowStart || 0) >= 3600000;
      const count = fresh ? 0 : (data.count || 0);
      if (count >= JOIN_LIMIT_PER_HOUR) throw new HttpsError('resource-exhausted', 'Too many attempts. Try again later.');
      tx.set(ref, { windowStart: fresh ? t : data.windowStart, count: count + 1 });
    });
  }

  async function memberFor(companyId, memberUid) {
    if (!validUid(memberUid)) throw new HttpsError('invalid-argument', 'Member is required.');
    const ref = db.doc(`companies/${companyId}/members/${memberUid}`);
    const data = (await ref.get()).data();
    if (!data) throw new HttpsError('not-found', 'Member not found.');
    return { ref, data };
  }

  // Removes the membership link from the user's profile, if it still points to this company.
  async function detachProfile(batchOrTx, memberUid, companyId) {
    const userRef = db.doc(`users/${memberUid}`);
    const user = (await userRef.get()).data();
    if (user && user.companyId === companyId && ASSIGNABLE_ROLES.includes(user.role)) batchOrTx.delete(userRef);
  }

  return {
    // Returns the company code, creating it on first use. regenerate=true invalidates the old one.
    async companyCode(auth, data) {
      const { companyId, companyRef } = await manager(auth, true);
      const regenerate = data?.regenerate === true;
      return db.runTransaction(async tx => {
        const company = (await tx.get(companyRef)).data() || {};
        if (company.companyCode && !regenerate) return { code: company.companyCode };
        let code = null;
        for (let attempt = 0; attempt < 8 && !code; attempt++) {
          const candidate = generateCode(random);
          if (!(await tx.get(db.doc(`companyCodes/${candidate}`))).exists) code = candidate;
        }
        if (!code) throw new HttpsError('aborted', 'Try again.');
        if (company.companyCode) tx.delete(db.doc(`companyCodes/${company.companyCode}`));
        tx.set(db.doc(`companyCodes/${code}`), { companyId, createdAtMillis: now() });
        tx.set(companyRef, { companyCode: code }, { merge: true });
        return { code };
      });
    },

    // Contractor: join code for an object, shown to carriers (OB-XXXXXX).
    async objectJoinCode(auth, data) {
      const { companyId } = await manager(auth, true);
      const { ref: objectRef } = await objectFor(companyId, data?.objectId);
      const regenerate = data?.regenerate === true;
      return db.runTransaction(async tx => {
        const object = (await tx.get(objectRef)).data() || {};
        if (object.joinCode && !regenerate) return { code: object.joinCode };
        let code = null;
        for (let attempt = 0; attempt < 8 && !code; attempt++) {
          const candidate = generateCode(random, 'OB');
          if (!(await tx.get(db.doc(`objectCodes/${candidate}`))).exists) code = candidate;
        }
        if (!code) throw new HttpsError('aborted', 'Try again.');
        if (object.joinCode) tx.delete(db.doc(`objectCodes/${object.joinCode}`));
        tx.set(db.doc(`objectCodes/${code}`), { contractorId: companyId, objectId: objectRef.id, createdAtMillis: now() });
        tx.set(objectRef, { joinCode: code }, { merge: true });
        return { code };
      });
    },

    // Carrier company admin asks to work on a contractor's object.
    async joinObject(auth, data) {
      const { uid, companyId: carrierId, company: carrier } = await manager(auth, true);
      await rateLimit(uid);
      const code = normalizeCode(data?.code, 'OB');
      if (!code) throw new HttpsError('not-found', 'Unknown object code.');
      const mapping = (await db.doc(`objectCodes/${code}`).get()).data();
      if (!mapping) throw new HttpsError('not-found', 'Unknown object code.');
      const objectRef = db.doc(`companies/${mapping.contractorId}/objects/${mapping.objectId}`);
      const object = (await objectRef.get()).data();
      if (!object || object.joinCode !== code || object.status === 'finished') throw new HttpsError('not-found', 'Unknown object code.');
      const carrierRef = db.doc(`${objectRef.path}/carriers/${carrierId}`);
      const existing = (await carrierRef.get()).data();
      if (['pending', 'active'].includes(existing?.status)) throw new HttpsError('already-exists', 'Already joined.');
      const contractor = (await db.doc(`companies/${mapping.contractorId}`).get()).data() || {};
      const t = now();
      const batch = db.batch();
      batch.set(carrierRef, { carrierName: carrier.name || '', status: 'pending', requestedBy: uid, joinedAtMillis: t });
      batch.set(db.doc(`companies/${carrierId}/objectLinks/${mapping.objectId}`), {
        contractorId: mapping.contractorId, contractorName: contractor.name || '',
        objectName: object.name || '', objectCode: object.objectCode || '', status: 'pending', updatedAtMillis: t,
      });
      await batch.commit();
      return { status: 'pending', objectName: object.name || '', contractorName: contractor.name || '' };
    },

    approveCarrier(auth, data) { return setCarrierStatus(auth, data, 'active'); },
    removeCarrier(auth, data) { return setCarrierStatus(auth, data, 'removed'); },

    // A signed-in user without a company asks to join one with its code.
    async joinCompany(auth, data) {
      const uid = requireAuth(auth);
      const email = auth.token?.email;
      if (typeof email !== 'string' || !email) throw new HttpsError('failed-precondition', 'An e-mail account is required.');
      const name = cleanName(data?.name);
      if (!name) throw new HttpsError('invalid-argument', 'Name is required.');
      const code = normalizeCode(data?.code);
      await rateLimit(uid); // Count malformed and wrong codes too.
      if (!code) throw new HttpsError('not-found', 'Unknown company code.');

      const userRef = db.doc(`users/${uid}`);
      const profile = (await userRef.get()).data();
      if (profile) {
        if (!ASSIGNABLE_ROLES.includes(profile.role)) {
          throw new HttpsError('failed-precondition', 'Company owners cannot join another company.');
        }
        if (profile.companyId) {
          const current = (await db.doc(`companies/${profile.companyId}/members/${uid}`).get()).data();
          if (['pending', 'active'].includes(current?.status)) {
            throw new HttpsError('already-exists', 'Already a member of a company.');
          }
        }
      }
      const mapping = (await db.doc(`companyCodes/${code}`).get()).data();
      const companyId = mapping?.companyId;
      const company = companyId ? (await db.doc(`companies/${companyId}`).get()).data() : null;
      if (!company || company.companyCode !== code) throw new HttpsError('not-found', 'Unknown company code.');

      const t = now();
      const batch = db.batch();
      batch.set(db.doc(`companies/${companyId}/members/${uid}`), {
        role: 'driver', status: 'pending', displayName: name, email,
        companyName: company.name || '', joinedAtMillis: t,
        approvedBy: null, approvedAtMillis: null, removedAtMillis: null,
      });
      batch.set(userRef, { email, name, role: 'driver', companyId, createdAtMillis: t });
      await batch.commit();
      return { status: 'pending', companyName: company.name || '' };
    },

    // The user cancels their own pending request.
    async cancelJoin(auth) {
      const uid = requireAuth(auth);
      const userRef = db.doc(`users/${uid}`);
      const profile = (await userRef.get()).data();
      if (!profile || !ASSIGNABLE_ROLES.includes(profile.role) || !profile.companyId) return { ok: true };
      const memberRef = db.doc(`companies/${profile.companyId}/members/${uid}`);
      const member = (await memberRef.get()).data();
      if (member?.status !== 'pending') throw new HttpsError('failed-precondition', 'Only a pending request can be cancelled.');
      const batch = db.batch();
      batch.set(memberRef, { status: 'cancelled', removedAtMillis: now() }, { merge: true });
      batch.delete(userRef);
      await batch.commit();
      return { ok: true };
    },

    async approveMember(auth, data) {
      const { uid, companyId } = await manager(auth, true);
      const { ref, data: member } = await memberFor(companyId, data?.uid);
      if (member.status !== 'pending') throw new HttpsError('failed-precondition', 'Request is not pending.');
      const user = (await db.doc(`users/${data.uid}`).get()).data();
      if (user?.companyId !== companyId) throw new HttpsError('failed-precondition', 'Request was withdrawn.');
      await ref.set({ status: 'active', approvedBy: uid, approvedAtMillis: now() }, { merge: true });
      return { ok: true };
    },

    async rejectMember(auth, data) {
      const { uid, companyId } = await manager(auth, true);
      const { ref, data: member } = await memberFor(companyId, data?.uid);
      if (member.status !== 'pending') throw new HttpsError('failed-precondition', 'Request is not pending.');
      const batch = db.batch();
      batch.set(ref, { status: 'rejected', removedAtMillis: now(), approvedBy: uid }, { merge: true });
      await detachProfile(batch, data.uid, companyId);
      await batch.commit();
      return { ok: true };
    },

    // Removed members lose access; their past work stays in company reports.
    async removeMember(auth, data) {
      const { uid, companyId, company } = await manager(auth, true);
      if (data?.uid === uid || data?.uid === company.ownerUid) throw new HttpsError('failed-precondition', 'The owner cannot be removed.');
      const { ref, data: member } = await memberFor(companyId, data?.uid);
      if (!['active', 'pending'].includes(member.status)) throw new HttpsError('failed-precondition', 'Member is not active.');
      const batch = db.batch();
      batch.set(ref, { status: 'removed', removedAtMillis: now(), removedBy: uid }, { merge: true });
      await detachProfile(batch, data.uid, companyId);
      await batch.commit();
      return { ok: true };
    },

    async setMemberRole(auth, data) {
      const { uid, companyId } = await manager(auth, true);
      if (!ASSIGNABLE_ROLES.includes(data?.role)) throw new HttpsError('invalid-argument', 'Unknown role.');
      if (data?.uid === uid) throw new HttpsError('failed-precondition', 'You cannot change your own role.');
      const { ref, data: member } = await memberFor(companyId, data?.uid);
      if (member.status !== 'active') throw new HttpsError('failed-precondition', 'Member is not active.');
      const userRef = db.doc(`users/${data.uid}`);
      const user = (await userRef.get()).data();
      if (user?.companyId !== companyId || !ASSIGNABLE_ROLES.includes(user.role)) {
        throw new HttpsError('failed-precondition', 'Member profile is not linked to this company.');
      }
      const batch = db.batch();
      batch.set(ref, { role: data.role }, { merge: true });
      batch.set(userRef, { role: data.role }, { merge: true });
      await batch.commit();
      return { ok: true };
    },
  };
}
