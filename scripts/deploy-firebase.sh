#!/usr/bin/env bash
# Deploys Firestore rules, the "members" Cloud Functions and the web dispatcher (Hosting).
# Needs GOOGLE_APPLICATION_CREDENTIALS (service account). Used by .github/workflows/firebase-deploy.yml.
set -euo pipefail
PROJECT=karjieroreisai
FB="npx firebase --project $PROJECT --non-interactive"

# Web app config for the dispatcher page (public identifiers, not secrets).
APP_ID=$($FB apps:list WEB --json | jq -r '[.result[]? | select(.platform=="WEB")][0].appId // empty')
if [ -z "$APP_ID" ]; then
  echo "Creating Firebase web app…"
  APP_ID=$($FB apps:create WEB "KarjeroReisai dispecerio centras" --json | jq -r '.result.appId // empty')
fi
[ -n "$APP_ID" ] || { echo "Could not find or create the Firebase web app"; exit 1; }
$FB apps:sdkconfig WEB "$APP_ID" --json > "${RUNNER_TEMP:-/tmp}/sdk.json"
CONFIG=$(jq -c '.result.sdkConfig // empty' "${RUNNER_TEMP:-/tmp}/sdk.json")
[ -n "$CONFIG" ] || { echo "No sdkConfig in:"; cat "${RUNNER_TEMP:-/tmp}/sdk.json"; exit 1; }
echo "export const firebaseConfig = $CONFIG;" > web/config.js
echo "Web config written for app $APP_ID"

npm ci --prefix members --no-audit --no-fund
TARGETS="firestore:rules,firestore:indexes,functions:members,hosting"

# ---- Payments (Stripe) – only when the STRIPE_SECRET_KEY GitHub secret is set ----
if [ -n "${STRIPE_SECRET_KEY:-}" ]; then
  TMP="${RUNNER_TEMP:-/tmp}"
  REGION=europe-west1
  HOOK_URL="https://$REGION-$PROJECT.cloudfunctions.net/stripeWebhook"
  stripe() { curl -sS -u "$STRIPE_SECRET_KEY:" "$@"; }
  set_secret() { # name value
    printf '%s' "$2" > "$TMP/secret.txt"
    $FB functions:secrets:set "$1" --data-file "$TMP/secret.txt" --force >/dev/null
    rm -f "$TMP/secret.txt"
  }
  CURRENT=$($FB functions:secrets:access STRIPE_SECRET_KEY 2>/dev/null || true)
  if [ "$CURRENT" != "$STRIPE_SECRET_KEY" ]; then echo "Saving Stripe key to Secret Manager"; set_secret STRIPE_SECRET_KEY "$STRIPE_SECRET_KEY"; fi

  # Webhook: its signing secret is shown by Stripe only when created, so create it here if we do not have it.
  if ! $FB functions:secrets:access STRIPE_WEBHOOK_SECRET >/dev/null 2>&1; then
    for id in $(stripe https://api.stripe.com/v1/webhook_endpoints?limit=100 | jq -r --arg u "$HOOK_URL" '.data[] | select(.url==$u) | .id'); do
      stripe -X DELETE "https://api.stripe.com/v1/webhook_endpoints/$id" >/dev/null
    done
    WHSEC=$(stripe https://api.stripe.com/v1/webhook_endpoints -d url="$HOOK_URL" \
      -d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=customer.subscription.created" \
      -d "enabled_events[]=customer.subscription.updated" -d "enabled_events[]=customer.subscription.deleted" \
      -d "enabled_events[]=invoice.paid" -d "enabled_events[]=invoice.payment_failed" -d "enabled_events[]=invoice.upcoming" \
      -d "description=KarjeroReisai Firebase" | jq -r '.secret // empty')
    [ -n "$WHSEC" ] || { echo "Could not create the Stripe webhook"; exit 1; }
    echo "::add-mask::$WHSEC"
    set_secret STRIPE_WEBHOOK_SECRET "$WHSEC"
    echo "Stripe webhook created: $HOOK_URL"
  fi

  # Customer portal (change card, invoices, cancel) needs a saved configuration.
  if [ "$(stripe 'https://api.stripe.com/v1/billing_portal/configurations?is_default=true&limit=1' | jq '.data | length')" = "0" ]; then
    stripe https://api.stripe.com/v1/billing_portal/configurations \
      -d "business_profile[headline]=KarjeroReisai" \
      -d "features[invoice_history][enabled]=true" \
      -d "features[payment_method_update][enabled]=true" \
      -d "features[subscription_cancel][enabled]=true" \
      -d "features[subscription_cancel][mode]=at_period_end" \
      -d "features[customer_update][enabled]=true" -d "features[customer_update][allowed_updates][]=email" \
      -d "features[customer_update][allowed_updates][]=address" -d "features[customer_update][allowed_updates][]=tax_id" >/dev/null
    echo "Stripe customer portal configured"
  fi

  cat > functions/.env <<ENV
BILLING_ENABLED=true
BILLING_RETURN_URL=https://$PROJECT.web.app/
ENV
  npm ci --prefix functions --no-audit --no-fund
  TARGETS="$TARGETS,functions:billing"
else
  echo "STRIPE_SECRET_KEY not set – payments are not deployed."
fi

$FB deploy --force --only "$TARGETS"
