"""Static safety checks for Android/Firebase configuration used by CI."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
config = json.loads((ROOT / "app/google-services.json").read_text(encoding="utf-8"))

if config.get("project_info", {}).get("project_id") != "karjieroreisai":
    raise SystemExit("Unexpected Firebase project_id")

packages = {
    c.get("client_info", {}).get("android_client_info", {}).get("package_name")
    for c in config.get("client", [])
}
if "lt.karjeroreisai.app" not in packages:
    raise SystemExit("Firebase config does not contain lt.karjeroreisai.app")

source = (ROOT / "app/src/main/java/lt/karjeroreisai/app/location/LocationTrackingService.kt").read_text(encoding="utf-8")
if '"auto_state_\\$sessionId"' in source or '"trip_start_\\$sessionId"' in source:
    raise SystemExit("Session preference keys must interpolate sessionId instead of storing literal $sessionId")
if '"auto_state_$sessionId"' not in source or '"trip_start_$sessionId"' not in source:
    raise SystemExit("Expected per-session preference keys were not found")

print("Android/Firebase configuration checks passed.")
