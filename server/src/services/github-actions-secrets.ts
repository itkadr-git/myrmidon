import crypto from "node:crypto";

const SIGMA = Buffer.from("expand 32-byte k", "ascii");

function rotl(a: number, b: number): number {
  return ((a << b) | (a >>> (32 - b))) >>> 0;
}

export function hsalsa20(nonce16: Buffer, key32: Buffer): Buffer {
  const x = new Uint32Array(16);
  for (let i = 0; i < 4; i++) {
    x[i * 5] = SIGMA.readUInt32LE(i * 4);
    x[i + 1] = key32.readUInt32LE(i * 4);
    x[i + 6] = nonce16.readUInt32LE(i * 4);
    x[i + 11] = key32.readUInt32LE((i + 4) * 4);
  }

  for (let i = 0; i < 20; i += 2) {
    x[4] ^= rotl((x[0] + x[12]) >>> 0, 7);
    x[8] ^= rotl((x[4] + x[0]) >>> 0, 9);
    x[12] ^= rotl((x[8] + x[4]) >>> 0, 13);
    x[0] ^= rotl((x[12] + x[8]) >>> 0, 18);

    x[9] ^= rotl((x[5] + x[1]) >>> 0, 7);
    x[13] ^= rotl((x[9] + x[5]) >>> 0, 9);
    x[1] ^= rotl((x[13] + x[9]) >>> 0, 13);
    x[5] ^= rotl((x[1] + x[13]) >>> 0, 18);

    x[14] ^= rotl((x[10] + x[6]) >>> 0, 7);
    x[2] ^= rotl((x[14] + x[10]) >>> 0, 9);
    x[6] ^= rotl((x[2] + x[14]) >>> 0, 13);
    x[10] ^= rotl((x[6] + x[2]) >>> 0, 18);

    x[3] ^= rotl((x[15] + x[11]) >>> 0, 7);
    x[7] ^= rotl((x[3] + x[15]) >>> 0, 9);
    x[11] ^= rotl((x[7] + x[3]) >>> 0, 13);
    x[15] ^= rotl((x[11] + x[7]) >>> 0, 18);

    x[1] ^= rotl((x[0] + x[3]) >>> 0, 7);
    x[2] ^= rotl((x[1] + x[0]) >>> 0, 9);
    x[3] ^= rotl((x[2] + x[1]) >>> 0, 13);
    x[0] ^= rotl((x[3] + x[2]) >>> 0, 18);

    x[6] ^= rotl((x[5] + x[4]) >>> 0, 7);
    x[7] ^= rotl((x[6] + x[5]) >>> 0, 9);
    x[4] ^= rotl((x[7] + x[6]) >>> 0, 13);
    x[5] ^= rotl((x[4] + x[7]) >>> 0, 18);

    x[11] ^= rotl((x[10] + x[9]) >>> 0, 7);
    x[8] ^= rotl((x[11] + x[10]) >>> 0, 9);
    x[9] ^= rotl((x[8] + x[11]) >>> 0, 13);
    x[10] ^= rotl((x[9] + x[8]) >>> 0, 18);

    x[12] ^= rotl((x[15] + x[14]) >>> 0, 7);
    x[13] ^= rotl((x[12] + x[15]) >>> 0, 9);
    x[14] ^= rotl((x[13] + x[12]) >>> 0, 13);
    x[15] ^= rotl((x[14] + x[13]) >>> 0, 18);
  }

  const out = Buffer.alloc(32);
  out.writeUInt32LE(x[0], 0);
  out.writeUInt32LE(x[5], 4);
  out.writeUInt32LE(x[10], 8);
  out.writeUInt32LE(x[15], 12);
  out.writeUInt32LE(x[6], 16);
  out.writeUInt32LE(x[7], 20);
  out.writeUInt32LE(x[8], 24);
  out.writeUInt32LE(x[9], 28);
  return out;
}

export function salsa20(input: Buffer, nonce8: Buffer, key32: Buffer, counter = 0): Buffer {
  const out = Buffer.alloc(input.length);
  const blocks = Math.ceil(input.length / 64);

  for (let b = 0; b < blocks; b++) {
    const x = new Uint32Array(16);
    for (let i = 0; i < 4; i++) {
      x[i * 5] = SIGMA.readUInt32LE(i * 4);
      x[i + 1] = key32.readUInt32LE(i * 4);
      x[i + 11] = key32.readUInt32LE((i + 4) * 4);
    }
    x[6] = nonce8.readUInt32LE(0);
    x[7] = nonce8.readUInt32LE(4);
    const currCounter = BigInt(counter + b);
    x[8] = Number(currCounter & 0xffffffffn);
    x[9] = Number((currCounter >> 32n) & 0xffffffffn);

    const orig = new Uint32Array(x);

    for (let i = 0; i < 20; i += 2) {
      x[4] ^= rotl((x[0] + x[12]) >>> 0, 7);
      x[8] ^= rotl((x[4] + x[0]) >>> 0, 9);
      x[12] ^= rotl((x[8] + x[4]) >>> 0, 13);
      x[0] ^= rotl((x[12] + x[8]) >>> 0, 18);

      x[9] ^= rotl((x[5] + x[1]) >>> 0, 7);
      x[13] ^= rotl((x[9] + x[5]) >>> 0, 9);
      x[1] ^= rotl((x[13] + x[9]) >>> 0, 13);
      x[5] ^= rotl((x[1] + x[13]) >>> 0, 18);

      x[14] ^= rotl((x[10] + x[6]) >>> 0, 7);
      x[2] ^= rotl((x[14] + x[10]) >>> 0, 9);
      x[6] ^= rotl((x[2] + x[14]) >>> 0, 13);
      x[10] ^= rotl((x[6] + x[2]) >>> 0, 18);

      x[3] ^= rotl((x[15] + x[11]) >>> 0, 7);
      x[7] ^= rotl((x[3] + x[15]) >>> 0, 9);
      x[11] ^= rotl((x[7] + x[3]) >>> 0, 13);
      x[15] ^= rotl((x[11] + x[7]) >>> 0, 18);

      x[1] ^= rotl((x[0] + x[3]) >>> 0, 7);
      x[2] ^= rotl((x[1] + x[0]) >>> 0, 9);
      x[3] ^= rotl((x[2] + x[1]) >>> 0, 13);
      x[0] ^= rotl((x[3] + x[2]) >>> 0, 18);

      x[6] ^= rotl((x[5] + x[4]) >>> 0, 7);
      x[7] ^= rotl((x[6] + x[5]) >>> 0, 9);
      x[4] ^= rotl((x[7] + x[6]) >>> 0, 13);
      x[5] ^= rotl((x[4] + x[7]) >>> 0, 18);

      x[11] ^= rotl((x[10] + x[9]) >>> 0, 7);
      x[8] ^= rotl((x[11] + x[10]) >>> 0, 9);
      x[9] ^= rotl((x[8] + x[11]) >>> 0, 13);
      x[10] ^= rotl((x[9] + x[8]) >>> 0, 18);

      x[12] ^= rotl((x[15] + x[14]) >>> 0, 7);
      x[13] ^= rotl((x[12] + x[15]) >>> 0, 9);
      x[14] ^= rotl((x[13] + x[12]) >>> 0, 13);
      x[15] ^= rotl((x[14] + x[13]) >>> 0, 18);
    }

    const keyStream = Buffer.alloc(64);
    for (let i = 0; i < 16; i++) {
      keyStream.writeUInt32LE((x[i] + orig[i]) >>> 0, i * 4);
    }

    const start = b * 64;
    const end = Math.min(start + 64, input.length);
    for (let i = start; i < end; i++) {
      out[i] = input[i] ^ keyStream[i - start];
    }
  }

  return out;
}

export function poly1305(msg: Buffer, key32: Buffer): Buffer {
  let r0 = BigInt(key32.readUInt32LE(0)) & 0x3ffffffn;
  let r1 = (BigInt(key32.readUInt32LE(3)) >> 2n) & 0x3ffff03n;
  let r2 = (BigInt(key32.readUInt32LE(6)) >> 4n) & 0x3ffc0ffn;
  let r3 = (BigInt(key32.readUInt32LE(9)) >> 6n) & 0x3f03fffn;
  let r4 = (BigInt(key32.readUInt32LE(12)) >> 8n) & 0x00fffffn;

  const s1 = r1 * 5n;
  const s2 = r2 * 5n;
  const s3 = r3 * 5n;
  const s4 = r4 * 5n;

  let h0 = 0n, h1 = 0n, h2 = 0n, h3 = 0n, h4 = 0n;

  let offset = 0;
  while (offset < msg.length) {
    const chunkLen = Math.min(16, msg.length - offset);
    const chunk = Buffer.alloc(16);
    msg.copy(chunk, 0, offset, offset + chunkLen);
    offset += chunkLen;

    const w0 = BigInt(chunk.readUInt32LE(0));
    const w1 = BigInt(chunk.readUInt32LE(4));
    const w2 = BigInt(chunk.readUInt32LE(8));
    const w3 = BigInt(chunk.readUInt32LE(12));

    h0 += w0 & 0x3ffffffn;
    h1 += ((w0 >> 26n) | (w1 << 6n)) & 0x3ffffffn;
    h2 += ((w1 >> 20n) | (w2 << 12n)) & 0x3ffffffn;
    h3 += ((w2 >> 14n) | (w3 << 18n)) & 0x3ffffffn;
    h4 += (w3 >> 8n) | (1n << 24n);

    const d0 = h0 * r0 + h1 * s4 + h2 * s3 + h3 * s2 + h4 * s1;
    const d1 = h0 * r1 + h1 * r0 + h2 * s4 + h3 * s3 + h4 * s2;
    const d2 = h0 * r2 + h1 * r1 + h2 * r0 + h3 * s4 + h4 * s3;
    const d3 = h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * s4;
    const d4 = h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;

    let c = d0 >> 26n; h0 = d0 & 0x3ffffffn;
    let d = d1 + c; c = d >> 26n; h1 = d & 0x3ffffffn;
    d = d2 + c; c = d >> 26n; h2 = d & 0x3ffffffn;
    d = d3 + c; c = d >> 26n; h3 = d & 0x3ffffffn;
    d = d4 + c; c = d >> 26n; h4 = d & 0x3ffffffn;
    h0 += c * 5n;
    c = h0 >> 26n; h0 &= 0x3ffffffn;
    h1 += c;
  }

  let c = h1 >> 26n; h1 &= 0x3ffffffn;
  h2 += c; c = h2 >> 26n; h2 &= 0x3ffffffn;
  h3 += c; c = h3 >> 26n; h3 &= 0x3ffffffn;
  h4 += c; c = h4 >> 26n; h4 &= 0x3ffffffn;
  h0 += c * 5n; c = h0 >> 26n; h0 &= 0x3ffffffn;
  h1 += c;

  let g0 = h0 + 5n; c = g0 >> 26n; g0 &= 0x3ffffffn;
  let g1 = h1 + c; c = g1 >> 26n; g1 &= 0x3ffffffn;
  let g2 = h2 + c; c = g2 >> 26n; g2 &= 0x3ffffffn;
  let g3 = h3 + c; c = g3 >> 26n; g3 &= 0x3ffffffn;
  let g4 = h4 + c - (1n << 26n);

  let mask = (g4 >> 63n) - 1n;
  g0 &= mask; g1 &= mask; g2 &= mask; g3 &= mask; g4 &= mask;
  mask = ~mask;
  h0 = (h0 & mask) | g0;
  h1 = (h1 & mask) | g1;
  h2 = (h2 & mask) | g2;
  h3 = (h3 & mask) | g3;
  h4 = (h4 & mask) | g4;

  const f0 = ((h0) | (h1 << 26n)) & 0xffffffffffffffffn;
  const f1 = ((h1 >> 6n) | (h2 << 20n) | (h3 << 46n)) & 0xffffffffffffffffn;
  const f2 = ((h3 >> 18n) | (h4 << 8n)) & 0xffffffffffffffffn;

  const totalH = f0 | (f1 << 64n) | (f2 << 128n);
  const pad = BigInt(key32.readUInt32LE(16)) |
    (BigInt(key32.readUInt32LE(20)) << 32n) |
    (BigInt(key32.readUInt32LE(24)) << 64n) |
    (BigInt(key32.readUInt32LE(28)) << 96n);

  const finalMac = (totalH + pad) & ((1n << 128n) - 1n);

  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number((finalMac >> BigInt(i * 8)) & 0xffn);
  }
  return out;
}

export function secretbox(msg: Buffer, nonce24: Buffer, key32: Buffer): Buffer {
  const subkey = hsalsa20(nonce24.subarray(0, 16), key32);
  const block0 = salsa20(Buffer.alloc(64), nonce24.subarray(16, 24), subkey, 0);
  const polyKey = block0.subarray(0, 32);
  const ciphertext = salsa20(msg, nonce24.subarray(16, 24), subkey, 1);
  const tag = poly1305(ciphertext, polyKey);
  return Buffer.concat([tag, ciphertext]);
}

function blake2b24(input: Buffer): Buffer {
  return crypto.createHash("blake2b512").update(input).digest().subarray(0, 24);
}

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export function seal(message: Buffer, recipientPublicKey32: Buffer): Buffer {
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const epkRaw = ephemeral.publicKey.export({ type: "spki", format: "der" }).subarray(-32);

  const recipientSpki = Buffer.concat([X25519_SPKI_PREFIX, recipientPublicKey32]);
  const importedRecipientPk = crypto.createPublicKey({ key: recipientSpki, format: "der", type: "spki" });

  const dhSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: importedRecipientPk,
  });

  const k = hsalsa20(Buffer.alloc(16), dhSecret);
  const nonce24 = blake2b24(Buffer.concat([epkRaw, recipientPublicKey32]));
  const boxed = secretbox(message, nonce24, k);

  return Buffer.concat([epkRaw, boxed]);
}

/** Encrypts a secret value using a base64-encoded GitHub repository Curve25519 public key. */
export function sealGitHubActionsSecret(secretValue: string, recipientPublicKeyBase64: string): string {
  const recipientPk = Buffer.from(recipientPublicKeyBase64, "base64");
  if (recipientPk.length !== 32) {
    throw new Error(`Invalid Curve25519 public key length: expected 32 bytes, got ${recipientPk.length}`);
  }
  const sealed = seal(Buffer.from(secretValue, "utf8"), recipientPk);
  return sealed.toString("base64");
}

export interface GitHubRepoPublicKey {
  key_id: string;
  key: string;
}

export async function fetchRepoPublicKey(
  repo: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubRepoPublicKey> {
  const url = `https://api.github.com/repos/${repo}/actions/secrets/public-key`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "myrmidon-secrets",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch public key for repo ${repo}: HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as GitHubRepoPublicKey;
}

export async function putRepoSecret(
  repo: string,
  secretName: string,
  encryptedValue: string,
  keyId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/actions/secrets/${secretName}`;
  const response = await fetchImpl(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "myrmidon-secrets",
    },
    body: JSON.stringify({
      encrypted_value: encryptedValue,
      key_id: keyId,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to put secret ${secretName} in repo ${repo}: HTTP ${response.status} ${response.statusText}`);
  }
}

export async function syncSecretToGitHubActions(
  options: {
    repo: string;
    secretName: string;
    secretValue: string;
    token?: string | null;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ success: boolean; keyId?: string; error?: string }> {
  const token =
    options.token ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    (options.secretValue.startsWith("github_pat_") || options.secretValue.startsWith("ghp_")
      ? options.secretValue
      : null);

  if (!token) {
    return {
      success: false,
      error: "No GitHub token available to sync GitHub Actions secret",
    };
  }

  try {
    const cleanRepo = options.repo.trim();
    const cleanSecretName = options.secretName.trim().replace(/^actions\./i, "");
    const { key_id, key } = await fetchRepoPublicKey(cleanRepo, token, fetchImpl);
    const encryptedValue = sealGitHubActionsSecret(options.secretValue, key);
    await putRepoSecret(cleanRepo, cleanSecretName, encryptedValue, key_id, token, fetchImpl);
    return { success: true, keyId: key_id };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
