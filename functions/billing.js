import { randomUUID } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';

export function assertOwner(auth, profile, company) {
  if (!auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (!profile?.companyId || !['company_admin', 'super_admin'].includes(profile.role) || company?.ownerUid !== auth.uid) {
    throw new HttpsError('permission-denied', 'Company ownership is required.');
  }
}

export function safeReturnUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || ['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('A public HTTPS return URL is required.');
  }
  return url.href;
}

export function subscriptionPlan(subscription) {
  // Incomplete, unpaid, paused, past_due and cancelled subscriptions grant no paid access.
  return subscription?.status === 'active' ? 'paid' : 'inactive';
}

export function createBillingService({ db, stripe, config, now = Date.now }) {
  async function owner(auth) {
    if (!auth?.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
    const profile = (await db.doc(`users/${auth.uid}`).get()).data();
    const id = profile?.companyId;
    if (typeof id !== 'string' || !id || id.includes('/')) throw new HttpsError('permission-denied', 'No company.');
    const companyRef = db.doc(`companies/${id}`);
    const company = (await companyRef.get()).data();
    assertOwner(auth, profile, company);
    return { id, company, companyRef, ref: db.doc(`billingCustomers/${id}`) };
  }

  function enabled() {
    if (!config.enabled || !config.priceId || !config.returnUrl) throw new HttpsError('failed-precondition', 'Billing is not configured.');
    safeReturnUrl(config.returnUrl);
  }

  // Serialize checkout creation and webhook reconciliation for each company.
  // The lease is longer than the function timeout. A crashed invocation can be retried.
  async function lock(ref) {
    const token = randomUUID();
    await db.runTransaction(async tx => {
      const data = (await tx.get(ref)).data() || {};
      if ((data.leaseUntil || 0) > now()) throw new HttpsError('aborted', 'Billing is busy. Retry shortly.');
      tx.set(ref, { lease: token, leaseUntil: now() + 180000 }, { merge: true });
    });
    return async () => db.runTransaction(async tx => {
      if ((await tx.get(ref)).data()?.lease === token) tx.set(ref, { leaseUntil: 0 }, { merge: true });
    });
  }

  async function subscriptions(customerId) {
    const result = [];
    for await (const sub of stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })) result.push(sub);
    return result;
  }

  return {
    async status(auth) {
      const { ref } = await owner(auth);
      const data = (await ref.get()).data();
      return { enabled: !!(config.enabled && config.priceId && config.returnUrl),
        hasSubscription: !!data?.customerId && !!data?.subscriptionId && !['canceled', 'incomplete_expired'].includes(data?.subscriptionStatus) };
    },

    async checkout(auth) {
      enabled();
      const { id, ref } = await owner(auth);
      const release = await lock(ref);
      try {
        let data = (await ref.get()).data() || {};
        if (!data.customerId) {
          // Fixed parameters and key make a failed Firestore write safe to retry.
          const customer = await stripe.customers.create({ metadata: { companyId: id } }, { idempotencyKey: `company-${id}` });
          await ref.set({ customerId: customer.id }, { merge: true });
          data.customerId = customer.id;
        }
        const current = await subscriptions(data.customerId);
        if (current.some(s => !['canceled', 'incomplete_expired'].includes(s.status))) {
          throw new HttpsError('already-exists', 'Manage the existing subscription instead.');
        }
        if (data.checkoutId) {
          const previous = await stripe.checkout.sessions.retrieve(data.checkoutId);
          if (previous.status === 'open') return { url: previous.url };
          if (previous.status === 'complete') {
            // The subscription event can arrive after the browser returns.
            // Only allow another checkout once the previous subscription is terminal.
            const subId = typeof previous.subscription === 'string' ? previous.subscription : previous.subscription?.id;
            if (subId && !['canceled', 'incomplete_expired'].includes((await stripe.subscriptions.retrieve(subId)).status)) {
              throw new HttpsError('already-exists', 'Payment is being processed. Refresh shortly.');
            }
          }
          data.attempt = null;
        }
        // Never retry an unknown old creation with a fresh key: Stripe retains keys
        // for at least 24 hours. A stale unknown outcome needs operator reconciliation.
        if (data.attempt && now() - data.attempt.createdAt > 23 * 3600000) {
          throw new HttpsError('failed-precondition', 'Checkout requires operator reconciliation.');
        }
        const attempt = data.attempt || { id: randomUUID(), createdAt: now(), priceId: config.priceId, returnUrl: safeReturnUrl(config.returnUrl) };
        await ref.set({ attempt, checkoutId: null }, { merge: true });
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription', customer: data.customerId,
          line_items: [{ price: attempt.priceId, quantity: 1 }], payment_method_types: ['card'],
          client_reference_id: id, metadata: { companyId: id },
          subscription_data: { metadata: { companyId: id } },
          success_url: attempt.returnUrl, cancel_url: attempt.returnUrl,
        }, { idempotencyKey: `checkout-${attempt.id}` });
        await ref.set({ checkoutId: session.id, attempt: null }, { merge: true });
        return { url: session.url };
      } finally { await release(); }
    },

    async portal(auth) {
      enabled();
      const { ref } = await owner(auth);
      const customer = (await ref.get()).data()?.customerId;
      if (!customer) throw new HttpsError('failed-precondition', 'No billing account.');
      return { url: (await stripe.billingPortal.sessions.create({ customer, return_url: safeReturnUrl(config.returnUrl) })).url };
    },

    async event(event) {
      const supported = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];
      if (!supported.includes(event.type)) return;
      const customerId = typeof event.data.object.customer === 'string' ? event.data.object.customer : event.data.object.customer?.id;
      if (!customerId) return;
      const mapping = await db.collection('billingCustomers').where('customerId', '==', customerId).limit(2).get();
      if (mapping.size !== 1) throw new Error('Missing or ambiguous billing customer.');
      const ref = mapping.docs[0].ref;
      const release = await lock(ref);
      try {
        const receipt = db.doc(`billingEvents/${event.id}`);
        if ((await receipt.get()).exists) return;
        // Retrieve current state under the lease. Do not trust event order or
        // event.created (different events can share a timestamp).
        const current = (await subscriptions(customerId)).filter(s => s.metadata?.companyId === ref.id);
        const active = current.find(s => s.status === 'active');
        const sub = active || current.find(s => !['canceled', 'incomplete_expired'].includes(s.status)) || current[0];
        const batch = db.batch();
        batch.set(db.doc(`companies/${ref.id}`), { plan: subscriptionPlan(sub), billingUpdatedAtMillis: now() }, { merge: true });
        batch.set(ref, { subscriptionId: sub?.id || null, subscriptionStatus: sub?.status || 'none' }, { merge: true });
        batch.set(receipt, { companyId: ref.id, processedAtMillis: now() });
        await batch.commit();
      } finally { await release(); }
    },
  };
}
