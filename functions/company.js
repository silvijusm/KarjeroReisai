import { randomInt } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const HOUR = 60 * 60 * 1000;
const fail = (code, message) => { throw new HttpsError(code, message); };
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    fail('invalid-argument', 'Invalid identifier.');
  }
  return value;
}
function text(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail('invalid-argument', 'Invalid text.');
  }
  return value.trim();
}
function authenticated(auth) {
  if (!auth?.uid) fail('unauthenticated', 'Sign in first.');
  return identifier(auth.uid);
}
export function generateCompanyCode() {
  return 'KR-' + Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

// All tenant/role changes run here with the Admin SDK, never in client writes.
// Dependencies are injectable so transactions can be tested without live accounts.
export function createCompanyService({ db, now = Date.now, newCode = generateCompanyCode }) {
  const stamp = () => FieldValue.serverTimestamp();
  const userRef = uid => db.doc(`users/${uid}`);
  const companyRef = id => db.doc(`companies/${id}`);
  const memberRef = (id, uid) => db.doc(`companies/${id}/members/${uid}`);

  async function administrator(tx, uid, companyId) {
    const [user, company] = await Promise.all([tx.get(userRef(uid)), tx.get(companyRef(companyId))]);
    const profile = user.data();
    if (!company.exists || !profile || (profile.role !== 'super_admin' &&
      !(profile.role === 'company_admin' && profile.companyId === companyId && company.data().ownerUid === uid))) {
      fail('permission-denied', 'Only the company owner can manage the team.');
    }
    return company.data();
  }

  async function consumeJoinAttempt(uid) {
    const ref = db.doc(`companyJoinLimits/${uid}`);
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const time = now();
      const attempts = (snapshot.data()?.attempts ?? []).filter(t => t > time - HOUR);
      if (attempts.length >= 10) fail('resource-exhausted', 'Try again later.');
      // Commit before looking up the code: failed guesses consume the limit too.
      tx.set(ref, { attempts: [...attempts, time] });
    });
  }

  return {
    async registerDriver(auth, input = {}) {
      const uid = authenticated(auth);
      const name = text(input.name);
      const email = text(auth.token?.email, 320);
      return db.runTransaction(async tx => {
        const ref = userRef(uid);
        const existing = await tx.get(ref);
        if (existing.exists) {
          if (existing.data().role !== 'driver') fail('failed-precondition', 'An account profile already exists.');
          return { status: existing.data().membershipStatus ?? 'unassigned' };
        }
        tx.set(ref, { name, email, role: 'driver', companyId: '', membershipStatus: 'unassigned', createdAt: stamp() });
        return { status: 'unassigned' };
      });
    },

    async rotateCode(auth, input = {}) {
      const uid = authenticated(auth);
      const companyId = identifier(input.companyId);
      // A collision is retried, never allowed to overwrite another company's code.
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode();
        const result = await db.runTransaction(async tx => {
          const company = await administrator(tx, uid, companyId);
          const codeRef = db.doc(`companyCodes/${code}`);
          if ((await tx.get(codeRef)).exists) return null;
          if (company.companyCode) tx.delete(db.doc(`companyCodes/${company.companyCode}`));
          tx.set(codeRef, { companyId, createdAt: stamp() });
          tx.update(companyRef(companyId), { companyCode: code });
          return { companyCode: code };
        });
        if (result) return result;
      }
      fail('aborted', 'Please retry.');
    },

    async requestMembership(auth, input = {}) {
      const uid = authenticated(auth);
      await consumeJoinAttempt(uid);
      const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
      if (!/^KR-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(code)) fail('not-found', 'Company code not found.');
      return db.runTransaction(async tx => {
        const [profileDoc, codeDoc] = await Promise.all([
          tx.get(userRef(uid)), tx.get(db.doc(`companyCodes/${code}`))
        ]);
        const profile = profileDoc.data();
        if (!profile || profile.role !== 'driver' || profile.companyId) {
          fail('failed-precondition', 'Only an unassigned driver can request membership.');
        }
        if (!codeDoc.exists) fail('not-found', 'Company code not found.');
        const companyId = codeDoc.data().companyId;
        const company = await tx.get(companyRef(companyId));
        if (!company.exists || company.data().companyCode !== code) fail('not-found', 'Company code not found.');
        if (profile.pendingCompanyId && profile.pendingCompanyId !== companyId) {
          fail('failed-precondition', 'Cancel the existing request first.');
        }
        const ref = memberRef(companyId, uid);
        const member = await tx.get(ref);
        if (member.data()?.status === 'active') fail('failed-precondition', 'Membership already exists.');
        if (member.data()?.status !== 'pending') {
          tx.set(ref, { role: 'driver', status: 'pending', displayName: profile.name, requestedAt: stamp() });
        }
        tx.update(userRef(uid), { pendingCompanyId: companyId, membershipStatus: 'pending' });
        return { companyId, status: 'pending' };
      });
    },

    async cancelRequest(auth) {
      const uid = authenticated(auth);
      return db.runTransaction(async tx => {
        const profile = (await tx.get(userRef(uid))).data();
        if (!profile || profile.companyId) fail('failed-precondition', 'No pending request.');
        if (!profile.pendingCompanyId) return { status: 'unassigned' };
        const ref = memberRef(profile.pendingCompanyId, uid);
        const member = await tx.get(ref);
        if (member.data()?.status !== 'pending') fail('failed-precondition', 'Request has already changed.');
        tx.update(ref, { status: 'cancelled', updatedAt: stamp() });
        tx.update(userRef(uid), { pendingCompanyId: FieldValue.delete(), membershipStatus: 'unassigned' });
        return { status: 'unassigned' };
      });
    },

    async reviewMembership(auth, input = {}) {
      const uid = authenticated(auth);
      const companyId = identifier(input.companyId);
      const targetUid = identifier(input.uid);
      const action = input.action;
      if (!['approve', 'reject', 'remove', 'set_role'].includes(action)) fail('invalid-argument', 'Invalid action.');
      const role = input.role ?? 'driver';
      if (!['driver', 'dispatcher'].includes(role)) fail('invalid-argument', 'Invalid member role.');
      return db.runTransaction(async tx => {
        const company = await administrator(tx, uid, companyId);
        if (targetUid === company.ownerUid || targetUid === uid) fail('permission-denied', 'The owner cannot be changed here.');
        const ref = memberRef(companyId, targetUid);
        const [memberDoc, profileDoc] = await Promise.all([tx.get(ref), tx.get(userRef(targetUid))]);
        const member = memberDoc.data();
        const profile = profileDoc.data();
        if (!member || !profile) fail('not-found', 'Member not found.');
        if (!['driver', 'dispatcher'].includes(profile.role)) fail('permission-denied', 'Protected account.');
        if (action === 'approve' || action === 'reject') {
          // Retries after a successful approval/rejection are harmless.
          if (action === 'approve' && member.status === 'active' && profile.companyId === companyId) return { status: 'active' };
          if (action === 'reject' && member.status === 'rejected') return { status: 'rejected' };
          if (member.status !== 'pending' || profile.pendingCompanyId !== companyId || profile.companyId) {
            fail('failed-precondition', 'Request has already changed.');
          }
          const approved = action === 'approve';
          tx.update(ref, { status: approved ? 'active' : 'rejected', role: 'driver',
            reviewedBy: uid, updatedAt: stamp(), ...(approved ? { joinedAt: stamp() } : {}) });
          tx.update(userRef(targetUid), { companyId: approved ? companyId : '', role: 'driver',
            pendingCompanyId: FieldValue.delete(), membershipStatus: approved ? 'active' : 'rejected' });
          return { status: approved ? 'active' : 'rejected' };
        }
        if (action === 'remove' && member.status === 'removed') return { status: 'removed' };
        if (member.status !== 'active' || profile.companyId !== companyId) fail('failed-precondition', 'Member is not active.');
        if (action === 'remove') {
          tx.update(ref, { status: 'removed', removedAt: stamp(), removedBy: uid });
          tx.update(userRef(targetUid), { companyId: '', role: 'driver', membershipStatus: 'removed', pendingCompanyId: FieldValue.delete() });
          // Sessions, trips and the membership record are deliberately retained.
          return { status: 'removed' };
        }
        tx.update(ref, { role, updatedAt: stamp(), reviewedBy: uid });
        tx.update(userRef(targetUid), { role });
        return { status: 'active', role };
      });
    },

    async saveVehicle(auth, input = {}) {
      const uid = authenticated(auth);
      const companyId = identifier(input.companyId);
      const plateNumber = text(input.plateNumber, 16).toUpperCase().replace(/\s+/g, ' ');
      if (!/^[A-Z0-9 -]{2,16}$/.test(plateNumber)) fail('invalid-argument', 'Invalid plate number.');
      // Canonical plate ID makes retries and duplicate additions idempotent.
      const vehicleId = plateNumber.replace(/[ -]/g, '');
      if (vehicleId.length < 2) fail('invalid-argument', 'Invalid plate number.');
      if (input.active !== undefined && typeof input.active !== 'boolean') fail('invalid-argument', 'Invalid active flag.');
      const name = input.name ? text(input.name) : '';
      const make = input.make ? text(input.make, 80) : '';
      const payloadT = input.payloadT ?? 0;
      if (typeof payloadT !== 'number' || !Number.isFinite(payloadT) || payloadT < 0 || payloadT > 200) {
        fail('invalid-argument', 'Invalid payload.');
      }
      return db.runTransaction(async tx => {
        await administrator(tx, uid, companyId);
        const ref = db.doc(`companies/${companyId}/vehicles/${vehicleId}`);
        const existing = await tx.get(ref);
        tx.set(ref, { plateNumber, name, make, payloadT, active: input.active ?? true,
          updatedAt: stamp(), updatedBy: uid, ...(!existing.exists ? { createdAt: stamp() } : {}) }, { merge: true });
        return { vehicleId };
      });
    }
  };
}
