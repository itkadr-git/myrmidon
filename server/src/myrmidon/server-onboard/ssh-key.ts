import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";

export function sshPublicKey(privateKey: string): string {
  const key = createPublicKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 private key");
  const x = key.export({ format: "jwk" }).x;
  if (!x) throw new Error("Cannot derive SSH public key");
  const name = Buffer.from("ssh-ed25519");
  const raw = Buffer.from(x, "base64url");
  const nameLength = Buffer.alloc(4);
  const keyLength = Buffer.alloc(4);
  nameLength.writeUInt32BE(name.length);
  keyLength.writeUInt32BE(raw.length);
  return `ssh-ed25519 ${Buffer.concat([nameLength, name, keyLength, raw]).toString("base64")} myrmidon-access`;
}

export function sshTransportPrivateKey(privateKey: string): string {
  if (privateKey.includes("BEGIN OPENSSH PRIVATE KEY")) return privateKey;
  const jwk = createPrivateKey(privateKey).export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x || !jwk.d) {
    throw new Error("Expected an Ed25519 private key");
  }
  const field = (value: Buffer | string): Buffer => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  const publicBytes = Buffer.from(jwk.x, "base64url");
  const publicBlob = Buffer.concat([field("ssh-ed25519"), field(publicBytes)]);
  const check = randomBytes(4);
  let privateBlob = Buffer.concat([check, check, field("ssh-ed25519"), field(publicBytes), field(Buffer.concat([Buffer.from(jwk.d, "base64url"), publicBytes])), field("")]);
  const padding = 8 - (privateBlob.length % 8);
  privateBlob = Buffer.concat([privateBlob, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))]);
  const count = Buffer.alloc(4); count.writeUInt32BE(1);
  const encoded = Buffer.concat([Buffer.from("openssh-key-v1\0"), field("none"), field("none"), field(""), count, field(publicBlob), field(privateBlob)]).toString("base64");
  const lines = encoded.match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

export function generateSshKeyPair(): { publicKey: string; privateKey: string } {
  const { privateKey: key } = generateKeyPairSync("ed25519");
  const privateKey = key.export({ type: "pkcs8", format: "pem" }).toString();
  return { publicKey: sshPublicKey(privateKey), privateKey };
}
