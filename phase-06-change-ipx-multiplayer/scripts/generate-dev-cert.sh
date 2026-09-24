#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$ROOT/certs"
KEY="$CERT_DIR/dev-key.pem"
CERT="$CERT_DIR/dev-cert.pem"
LAN_IP="${DOS_CLOUD_CERT_IP:-$(hostname -I | awk '{print $1}')}"

mkdir -p "$CERT_DIR"

SAN="DNS:localhost,IP:127.0.0.1"
if [[ -n "$LAN_IP" ]]; then
  SAN="$SAN,IP:$LAN_IP"
fi

openssl req   -x509   -newkey rsa:2048   -sha256   -nodes   -days 825   -keyout "$KEY"   -out "$CERT"   -subj "/CN=${LAN_IP:-localhost}/O=DOS Cloud Development"   -addext "subjectAltName=$SAN"   -addext "basicConstraints=critical,CA:FALSE"   -addext "keyUsage=critical,digitalSignature,keyEncipherment"   -addext "extendedKeyUsage=serverAuth"   >/dev/null 2>&1

chmod 600 "$KEY"
chmod 644 "$CERT"

echo "Generated:"
echo "  $CERT"
echo "  $KEY"
echo "SAN: $SAN"
