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
$FB deploy --force --only firestore:rules,functions:members,hosting
