import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type JsonWebKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, type Address } from "@qm/core";

export interface PublicJwk extends JsonWebKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface PrivateJwk extends PublicJwk {
  d: string;
}

export interface KeyFile {
  kind: "qm-sim-key/1";
  role: string;
  jwk: PrivateJwk;
}

export function generateP256(): PrivateJwk {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ format: "jwk" }) as PrivateJwk;
}

export function publicOf(jwk: PrivateJwk | PublicJwk): PublicJwk {
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/** P-256 ECDSA over the canonical JSON of `payload`, IEEE P1363 encoded, base64url. */
export function signPayload(jwk: PrivateJwk, payload: unknown): string {
  const key = createPrivateKey({ key: jwk, format: "jwk" });
  return sign("sha256", Buffer.from(canonicalJson(payload)), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

export function verifyPayload(jwk: PublicJwk, payload: unknown, signature: string): boolean {
  try {
    const key = createPublicKey({ key: publicOf(jwk), format: "jwk" });
    return verify("sha256", Buffer.from(canonicalJson(payload)), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function sameKey(a: PublicJwk, b: PublicJwk): boolean {
  return a.x === b.x && a.y === b.y;
}

/** A 20-byte address derived from a public key, the way the simnet names key holders. */
export function addressOfKey(jwk: PublicJwk, salt = ""): Address {
  return `0x${createHash("sha256").update(`${salt}${jwk.x}.${jwk.y}`).digest("hex").slice(0, 40)}`;
}

export function randomAddress(): Address {
  return `0x${randomBytes(20).toString("hex")}`;
}

export function randomHex32(): `0x${string}` {
  return `0x${randomBytes(32).toString("hex")}`;
}

export function writeKeyFile(path: string, role: string, jwk: PrivateJwk) {
  mkdirSync(dirname(path), { recursive: true });
  const file: KeyFile = { kind: "qm-sim-key/1", role, jwk };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

export function readKeyFile(path: string): KeyFile {
  return JSON.parse(readFileSync(path, "utf8")) as KeyFile;
}

export function writeJson(path: string, value: unknown, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
