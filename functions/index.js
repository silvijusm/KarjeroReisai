import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret, defineString, defineBoolean } from 'firebase-functions/params';
import Stripe from 'stripe';
import { createBillingService, PLANS } from './billing.js';

initializeApp();
const stripeKey = defineSecret('STRIPE_SECRET_KEY');
const webhookKey = defineSecret('STRIPE_WEBHOOK_SECRET');
const enabled = defineBoolean('BILLING_ENABLED', { default: false });
const price = defineString('STRIPE_PRICE_ID', { default: '' });
const returnUrl = defineString('BILLING_RETURN_URL', { default: '' });
const options = { region: 'europe-west1', maxInstances: 3, timeoutSeconds: 60, secrets: [stripeKey] };

function service() {
  return createBillingService({ db: getFirestore(), stripe: new Stripe(stripeKey.value(), { maxNetworkRetries: 2 }),
    config: { enabled: enabled.value(), priceId: price.value(), plans: PLANS, returnUrl: returnUrl.value() } });
}
function callable(method) {
  return onCall(options, async request => {
    try { return await service()[method](request.auth, request.data); }
    catch (error) {
      if (error instanceof HttpsError) throw error;
      // Never return SDK exceptions, raw request bodies, keys or billing URLs.
      console.error('Billing operation failed', { method, code: typeof error.code === 'string' ? error.code : 'unknown' });
      throw new HttpsError('internal', 'Billing is temporarily unavailable.');
    }
  });
}
export const billingStatus = callable('status');
export const createCheckout = callable('checkout');
export const createBillingPortal = callable('portal');
export const syncSeats = callable('syncSeats');
export const stripeWebhook = onRequest({ ...options, secrets: [stripeKey, webhookKey] }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }
  const stripe = new Stripe(stripeKey.value());
  let event;
  try { event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], webhookKey.value()); }
  catch { res.status(400).send('Invalid signature'); return; }
  try {
    await service().event(event);
    res.status(200).send('OK');
  } catch {
    // Return non-2xx so Stripe retries busy leases and transient failures.
    console.error('Billing webhook requires retry', { eventId: event.id });
    res.status(503).send('Retry later');
  }
});

