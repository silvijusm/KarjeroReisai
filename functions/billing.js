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

// Plans the customer can choose. Prices are found by Stripe lookup_key, so moving
// from the sandbox to live needs no code change.
export const PLANS = {
  monthly: 'karjeroreisai_monthly',
  yearly: 'karjeroreisai_yearly',
  company: 'karjeroreisai_company_per_driver',
  contractor_small: 'karjeroreisai_contractor_small',
  contractor_medium: 'karjeroreisai_contractor_medium',
  contractor_large: 'karjeroreisai_contractor_large',
};
export const MIN_COMPANY_SEATS = 3;
export const GRACE_MS = 7 * 86400000;

export function createBillingService({ db, stripe, config, now = Date.now }) {
  const plans = config.plans || {};

  // Company plan: 3 € per active driver, at least 3.
  async function seatsFor(companyId) {
    const snap = await db.collection(`companies/${companyId}/members`).where('status', '==', 'active').get();
    const drivers = snap.docs.filter(d => (d.data?.() || {}).role === 'driver').length;
    return Math.max(MIN_COMPANY_SEATS, drivers);
  }

  async function priceFor(plan) {
    if (!plan && config.priceId) return config.priceId; // legacy single price
    const key = plans[plan];
    if (!key) throw new HttpsError('invalid-argument', 'Unknown plan.');
    const list = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
    const price = list.data?.[0]?.id;
    if (!price) throw new HttpsError('failed-precondition', 'Price is not configured.');
    return price;
  }

  function planOf(sub) {
    const key = sub?.items?.data?.[0]?.price?.lookup_key;
    return Object.keys(plans).find(p => plans[p] === key) || null;
  }
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
    if (!config.enabled || !(config.priceId || Object.keys(plans).length) || !config.returnUrl) throw new HttpsError('failed-precondition', 'Billing is not configured.');
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
      return { enabled: !!(config.enabled && (config.priceId || Object.keys(plans).length) && config.returnUrl),
        plan: data?.plan || null, seats: data?.seats || null,
        hasSubscription: !!data?.customerId && !!data?.subscriptionId && !['canceled', 'incomplete_expired'].includes(data?.subscriptionStatus) };
    },

    async checkout(auth, input) {
      enabled();
      const { id, ref } = await owner(auth);
      const plan = input?.plan || null;
      if (plan && !plans[plan]) throw new HttpsError('invalid-argument', 'Unknown plan.');
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
        const attempt = data.attempt || {
          id: randomUUID(), createdAt: now(), plan, priceId: await priceFor(plan),
          quantity: plan === 'company' ? await seatsFor(id) : 1, returnUrl: safeReturnUrl(config.returnUrl),
        };
        await ref.set({ attempt, checkoutId: null }, { merge: true });
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription', customer: data.customerId,
          line_items: [{ price: attempt.priceId, quantity: attempt.quantity || 1 }], payment_method_types: ['card'],
          client_reference_id: id, metadata: { companyId: id, plan: attempt.plan || '' },
          subscription_data: { metadata: { companyId: id, plan: attempt.plan || '' } },
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

    // Company plan: set the subscription quantity to the number of active drivers (min 3).
    // Called after a driver is approved / removed, and before each renewal (invoice.upcoming).
    async syncSeats(auth) {
      enabled();
      const { id } = await owner(auth);
      return this.syncSeatsFor(id);
    },

    async syncSeatsFor(companyId) {
      const ref = db.doc(`billingCustomers/${companyId}`);
      const data = (await ref.get()).data() || {};
      if (!data.subscriptionId) return { seats: null };
      const sub = await stripe.subscriptions.retrieve(data.subscriptionId);
      const item = sub?.items?.data?.[0];
      if (!item || planOf(sub) !== 'company' || ['canceled', 'incomplete_expired'].includes(sub.status)) return { seats: null };
      const seats = await seatsFor(companyId);
      if (item.quantity !== seats) {
        await stripe.subscriptionItems.update(item.id, { quantity: seats, proration_behavior: 'create_prorations' },
          { idempotencyKey: `seats-${companyId}-${item.id}-${seats}-${Math.floor(now() / 60000)}` });
      }
      await db.doc(`companies/${companyId}`).set({ seats }, { merge: true });
      await ref.set({ seats }, { merge: true });
      return { seats };
    },

    async event(event) {
      const supported = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
        'invoice.paid', 'invoice.payment_failed', 'invoice.upcoming'];
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
        // Failed payment: 7 days of grace, then new work cannot be started (current work can be finished).
        const stored = (await ref.get()).data() || {};
        let plan = subscriptionPlan(sub);
        let pastDueSince = null;
        if (sub?.status === 'past_due') {
          pastDueSince = stored.pastDueSinceMillis || now();
          if (now() - pastDueSince < GRACE_MS) plan = 'paid';
        }
        const batch = db.batch();
        batch.set(db.doc(`companies/${ref.id}`), {
          plan, billingUpdatedAtMillis: now(), billingPlan: planOf(sub),
          seats: sub?.items?.data?.[0]?.quantity ?? null, graceUntilMillis: pastDueSince ? pastDueSince + GRACE_MS : null,
        }, { merge: true });
        batch.set(ref, { subscriptionId: sub?.id || null, subscriptionStatus: sub?.status || 'none', pastDueSinceMillis: pastDueSince, plan: planOf(sub) }, { merge: true });
        batch.set(receipt, { companyId: ref.id, processedAtMillis: now() });
        await batch.commit();
      } finally { await release(); }
      if (event.type === 'invoice.upcoming') {
        try { await this.syncSeatsFor(ref.id); } catch (e) { console.error('Seat sync failed', { companyId: ref.id }); }
      }
    },
  };
}
