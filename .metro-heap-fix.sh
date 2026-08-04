#!/bin/sh
# Re-apply the Metro heap bump after a pod recreation.
# /etc is NOT on the PVC, so /etc/supervisor/conf.d/supervisord.conf reverts to
# the image default (no NODE_OPTIONS) on every fresh container, and Metro then
# OOMs at ~2GB bundling this app's ~1800-module / 30MB dev bundle.
set -e
CONF=/etc/supervisor/conf.d/supervisord.conf
grep -q NODE_OPTIONS "$CONF" && { echo 'already applied'; exit 0; }
sed -i 's/^environment=EXPO_DEVTOOLS_LISTEN_ADDRESS="0.0.0.0",CI="false"$/environment=EXPO_DEVTOOLS_LISTEN_ADDRESS="0.0.0.0",CI="false",NODE_OPTIONS="--max-old-space-size=4096"/' "$CONF"
grep -q NODE_OPTIONS "$CONF" || { echo 'FAILED: anchor line not found'; exit 1; }
supervisorctl reread && supervisorctl update expo && supervisorctl restart expo
echo 'applied: Metro heap -> 4096MB'
