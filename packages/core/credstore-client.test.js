"use strict";
// Tests for the read-only SAP Credential Store client.
//
// The JWE decryption is verified against a locally built compact JWE
// (RSA-OAEP-256 key wrap + A256GCM content encryption, AAD = ASCII of the
// protected-header segment) — the same construction jose/the store produce.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  findCredstoreBinding,
  loadKey,
  decryptJweCompact,
  readCredential,
  writeCredential,
} = require("./credstore-client");

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

/** Build a compact JWE the way the store does (reverse of decryptJweCompact). */
function encryptJweCompact(payloadObject, pubKey) {
  const header = Buffer.from(JSON.stringify({ alg: "RSA-OAEP-256", enc: "A256GCM" })).toString("base64url");
  const cek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cek, iv);
  cipher.setAAD(Buffer.from(header, "ascii"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payloadObject), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encKey = crypto.publicEncrypt(
    { key: pubKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    cek
  );
  return [header, encKey.toString("base64url"), iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

function makeBinding() {
  return {
    url: "https://credstore.example/api/v1/credentials",
    username: "binding-user",
    password: "binding-pass",
    encryption: {
      client_private_key: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      server_public_key: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    },
  };
}

test("decryptJweCompact: round-trip with RSA-OAEP-256 + A256GCM", () => {
  const jwe = encryptJweCompact({ name: "cf-management-user", value: "s3cret", username: "tech@x" }, publicKey);
  const out = JSON.parse(decryptJweCompact(jwe, privateKey));
  assert.deepEqual(out, { name: "cf-management-user", value: "s3cret", username: "tech@x" });
});

test("decryptJweCompact: rejects tampered ciphertext and wrong algorithms", () => {
  const jwe = encryptJweCompact({ v: 1 }, publicKey);
  const parts = jwe.split(".");
  parts[3] = Buffer.from("tampered!").toString("base64url");
  assert.throws(() => decryptJweCompact(parts.join("."), privateKey));

  const badHeader = Buffer.from(JSON.stringify({ alg: "RSA-OAEP", enc: "A256GCM" })).toString("base64url");
  const bad = [badHeader, ...jwe.split(".").slice(1)].join(".");
  assert.throws(() => decryptJweCompact(bad, privateKey), /unsupported JWE/);
});

test("loadKey: accepts base64-DER and PEM", () => {
  const b = makeBinding();
  assert.equal(loadKey(b.encryption.client_private_key, true).type, "private");
  assert.equal(loadKey(b.encryption.server_public_key, false).type, "public");
  assert.equal(loadKey(privateKey.export({ format: "pem", type: "pkcs8" }), true).type, "private");
  assert.throws(() => loadKey("", true), /missing/);
});

test("findCredstoreBinding: reads VCAP_SERVICES.credstore, tolerates absence", () => {
  const b = makeBinding();
  assert.deepEqual(findCredstoreBinding({ VCAP_SERVICES: JSON.stringify({ credstore: [{ credentials: b }] }) }), b);
  assert.equal(findCredstoreBinding({ VCAP_SERVICES: "{}" }), null);
  assert.equal(findCredstoreBinding({}), null);
  assert.equal(findCredstoreBinding({ VCAP_SERVICES: "not json" }), null);
});

test("readCredential: decrypts, returns null on 404, throws on other statuses", async () => {
  const binding = makeBinding();
  const jwe = encryptJweCompact({ name: "cf-management-user", value: "pw", username: "tech@x" }, publicKey);

  const calls = [];
  const okFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, text: async () => jwe };
  };
  const cred = await readCredential(binding, {}, okFetch);
  assert.deepEqual(cred, { name: "cf-management-user", value: "pw", username: "tech@x" });
  assert.match(calls[0].url, /\/password\?name=cf-management-user$/);
  assert.equal(calls[0].opts.headers["sapcp-credstore-namespace"], "figaf-manager");
  assert.match(calls[0].opts.headers.Authorization, /^Basic /);

  const notFound = await readCredential(binding, {}, async () => ({ ok: false, status: 404, text: async () => "" }));
  assert.equal(notFound, null);

  await assert.rejects(
    readCredential(binding, {}, async () => ({ ok: false, status: 429, text: async () => "slow down" })),
    /HTTP 429.*rate limit/
  );
});

test("writeCredential: POSTs a decryptable JWE with iat (seconds) and username", async () => {
  const binding = makeBinding();
  const calls = [];
  const okFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 201, text: async () => "" }; };

  await writeCredential(binding, { username: "tech@x", value: "pw-123" }, okFetch);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/password$/);
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.headers["Content-Type"], "application/jose");
  assert.equal(calls[0].opts.headers["sapcp-credstore-namespace"], "figaf-manager");

  // The body must decrypt with the (test) server private key and carry iat in seconds.
  const jwe = calls[0].opts.body;
  const header = JSON.parse(Buffer.from(jwe.split(".")[0], "base64url").toString("utf8"));
  assert.equal(header.alg, "RSA-OAEP-256");
  assert.equal(header.enc, "A256GCM");
  assert.ok(Number.isInteger(header.iat) && header.iat > 1e9 && header.iat < 1e11, "iat must be epoch SECONDS");
  const payload = JSON.parse(decryptJweCompact(jwe, privateKey));
  assert.deepEqual(payload, { name: "cf-management-user", value: "pw-123", username: "tech@x" });

  await assert.rejects(
    writeCredential(binding, { username: "u", value: "v" }, async () => ({ ok: false, status: 429, text: async () => "" })),
    /HTTP 429.*rate limit/
  );
});
