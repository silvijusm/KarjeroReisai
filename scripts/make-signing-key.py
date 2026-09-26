#!/usr/bin/env python3
"""Builds the same APK signing keystore on every CI run, so test APK updates install over each other.

The key is derived from a secret (APK_SIGNING_SEED, or else FIREBASE_SERVICE_ACCOUNT) – nothing secret is
stored in the repository. Usage: make-signing-key.py <out.p12>; prints the keystore password to stdout.
"""
import datetime, hashlib, hmac, os, sys
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

secret = os.environ.get("APK_SIGNING_SEED") or os.environ.get("FIREBASE_SERVICE_ACCOUNT")
if not secret:
    sys.exit("No APK_SIGNING_SEED / FIREBASE_SERVICE_ACCOUNT secret – cannot build a stable signing key.")
seed = hmac.new(secret.encode(), b"karjeroreisai-apk-signing-v1", hashlib.sha256).digest()
password = hmac.new(seed, b"password", hashlib.sha256).hexdigest()[:32]

curve = ec.SECP256R1()
n = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
key = ec.derive_private_key(int.from_bytes(hashlib.sha512(seed).digest(), "big") % (n - 1) + 1, curve)

name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "KarjeroReisai"),
                  x509.NameAttribute(NameOID.ORGANIZATION_NAME, "S. Meskeno imone"),
                  x509.NameAttribute(NameOID.COUNTRY_NAME, "LT")])
cert = (x509.CertificateBuilder()
        .subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(int.from_bytes(hashlib.sha256(seed + b"serial").digest()[:16], "big") >> 1)
        .not_valid_before(datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc))
        .not_valid_after(datetime.datetime(2056, 1, 1, tzinfo=datetime.timezone.utc))
        .sign(key, hashes.SHA256(), ecdsa_deterministic=True))  # identical certificate every run

enc = (serialization.PrivateFormat.PKCS12.encryption_builder()
       .kdf_rounds(50000)
       .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
       .hmac_hash(hashes.SHA1())
       .build(password.encode()))
with open(sys.argv[1], "wb") as f:
    f.write(pkcs12.serialize_key_and_certificates(b"karjeroreisai", key, cert, None, enc))
print(password)
