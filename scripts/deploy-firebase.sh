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
  ACCOUNT=$(stripe https://api.stripe.com/v1/account | jq -r '.id // "?"')
  echo "::notice title=Stripe::Account $ACCOUNT ($( [[ "$STRIPE_SECRET_KEY" == sk_live_* || "$STRIPE_SECRET_KEY" == rk_live_* ]] && echo LIVE || echo test ))"

  # Prices are looked up by lookup_key. Create any that are missing (same amounts as the website).
  ensure_price() { # lookup_key amount_cents interval nickname
    local found
    found=$(stripe -G https://api.stripe.com/v1/prices -d "lookup_keys[]=$1" -d active=true | jq -r '.data[0].id // empty')
    if [ -z "$found" ]; then
      if [ -z "${PRODUCT:-}" ]; then
        PRODUCT=$(stripe https://api.stripe.com/v1/products -d "name=KarjeroReisai prenumerata" | jq -r '.id')
      fi
      found=$(stripe https://api.stripe.com/v1/prices -d product="$PRODUCT" -d currency=eur -d unit_amount="$2" \
        -d "recurring[interval]=$3" -d lookup_key="$1" -d tax_behavior=inclusive -d nickname="$4" | jq -r '.id // empty')
      [ -n "$found" ] || { echo "Could not create price $1"; exit 1; }
      echo "::notice title=Stripe::Created price $1"
    fi
  }
  ensure_price karjeroreisai_monthly 500 month "Mėnesio"
  ensure_price karjeroreisai_yearly 5500 year "Metinė"
  ensure_price karjeroreisai_company_per_driver 300 month "Įmonėms – už vairuotoją (nuo 3)"
  ensure_price karjeroreisai_contractor_small 4900 month "Rangovas – iki 10 aut."
  ensure_price karjeroreisai_contractor_medium 9900 month "Rangovas – iki 30 aut."
  ensure_price karjeroreisai_contractor_large 19900 month "Rangovas – neribotai"

  CURRENT=$($FB functions:secrets:access STRIPE_SECRET_KEY 2>/dev/null || true)
  KEY_CHANGED=0
  if [ "$CURRENT" != "$STRIPE_SECRET_KEY" ]; then echo "Saving Stripe key to Secret Manager"; set_secret STRIPE_SECRET_KEY "$STRIPE_SECRET_KEY"; KEY_CHANGED=1; fi
  # The webhook must exist in the key's account; check it is there.
  HOOK_OK=$(stripe https://api.stripe.com/v1/webhook_endpoints?limit=100 | jq -r --arg u "$HOOK_URL" '[.data[] | select(.url==$u)] | length')

  # Webhook: its signing secret is shown by Stripe only when created, so create it here if we do not have it.
  if [ "$KEY_CHANGED" = "1" ] || [ "$HOOK_OK" = "0" ] || ! $FB functions:secrets:access STRIPE_WEBHOOK_SECRET >/dev/null 2>&1; then
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
    echo "::notice title=Stripe::Webhook created: $HOOK_URL"
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
    echo "::notice title=Stripe::Customer portal configured"
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
