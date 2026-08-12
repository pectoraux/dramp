// Application-level encryption for secrets stored at rest.
//
// Uses AES-256-GCM with a key derived from the WEBHOOK_ENCRYPTION_KEY env var.
// Supports key versioning for rotation: the encrypted blob stores the key
// version, so old secrets can be decrypted with an old key after rotation.
//
// Format: "v{version}:{iv}:{tag}:{ciphertext}" (all base64).

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// Key versioning: map version → derived key. Currently only v1.
// To rotate, add v2 with a new env var and keep v1 for decryption of old data.
const KEY_CACHE = new Map<number, Buffer>();

function getKey(version: number): Buffer {
  if (KEY_CACHE.has(version)) return KEY_CACHE.get(version)!;
  const envVar = version === 1 ? "WEBHOOK_ENCRYPTION_KEY" : `WEBHOOK_ENCRYPTION_KEY_V${version}`;
  const passphrase = process.env[envVar];
  if (!passphrase) {
    // In dev/test without a configured key, derive a deterministic one so the
    // prototype still works. In production, WEBHOOK_ENCRYPTION_KEY MUST be set.
    if (process.env.NODE_ENV !== "production") {
      const fallback = scryptSync("dramp-dev-fallback-key", "dramp-salt", 32);
      KEY_CACHE.set(version, fallback);
      return fallback;
    }
    throw new Error(`${envVar} is not set — required for webhook secret encryption in production.`);
  }
  const key = scryptSync(passphrase, "dramp-salt", 32);
  KEY_CACHE.set(version, key);
  return key;
}

export interface EncryptedSecret {
  encryptedSecret: string;
  encryptionKeyVersion: number;
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const version = 1;
  const key = getKey(version);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: v{version}:{ivBase64}:{tagBase64}:{ciphertextBase64}
  const blob = `v${version}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
  return { encryptedSecret: blob, encryptionKeyVersion: version };
}

export function decryptSecret(encryptedSecret: string): string {
  const parts = encryptedSecret.split(":");
  if (parts.length !== 4 || !parts[0].startsWith("v")) {
    throw new Error("invalid encrypted secret format");
  }
  const version = parseInt(parts[0].slice(1), 10);
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ciphertext = Buffer.from(parts[3], "base64");
  const key = getKey(version);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

// Check whether a stored value looks like an encrypted blob (vs plaintext).
export function isEncrypted(value: string): boolean {
  return value.startsWith("v") && value.split(":").length === 4;
}
