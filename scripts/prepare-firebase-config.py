"""Use an optional CI-provided Firebase client config without logging its contents."""
import json
import os
from pathlib import Path

path = Path('app/google-services.json')
provided = os.environ.get('GOOGLE_SERVICES_JSON', '')
raw = provided if provided.strip() else path.read_text(encoding='utf-8')
config = json.loads(raw)
if config.get('project_info', {}).get('project_id') != 'karjieroreisai':
    raise SystemExit('Unexpected Firebase project; refusing to build.')
clients = config.get('client', [])
if not any(c.get('client_info', {}).get('android_client_info', {}).get('package_name') == 'lt.karjeroreisai.app' for c in clients):
    raise SystemExit('Firebase configuration does not match the Android application.')
if provided.strip():
    path.write_text(raw, encoding='utf-8')
    path.chmod(0o600)
print('Firebase client configuration validated (values omitted).')
