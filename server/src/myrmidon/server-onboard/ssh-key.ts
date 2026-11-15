import { createPublicKey, generateKeyPairSync } from "node:crypto";

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

export function generateSshKeyPair(): { publicKey: string; privateKey: string } {
  const { privateKey: key } = generateKeyPairSync("ed25519");
  const privateKey = key.export({ type: "pkcs8", format: "pem" }).toString();
  return { publicKey: sshPublicKey(privateKey), privateKey };
}
