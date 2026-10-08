/**
 * PKI service - real X.509 certificate generation with node-forge.
 *
 * One Arvoo Root CA per installation. Server certificates are issued per
 * OpenVPN inbound; client certificates per VPN client. Private keys are
 * encrypted at rest (AES-256-GCM) and never returned in listing APIs.
 */

import forge from "node-forge";
import { q1, run, uuid, nowIso } from "../db/index.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";
import { notFound } from "../lib/errors.js";

export interface IssuedCertificate {
  certificatePem: string;
  privateKeyPem: string;
  serial: string;
}

function pkiRandomSerial(): string {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

export async function ensureRootCA(): Promise<{ id: string; certificatePem: string }> {
  const existing = await q1<{ id: string; certificate: string }>(
    `SELECT id, certificate FROM pki_certificates WHERE kind = 'ca' LIMIT 1`,
  );
  if (existing) return { id: existing.id, certificatePem: existing.certificate };

  const keys = forge.pki.rsa.generateKeyPair(3072);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = pkiRandomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: "commonName", value: "Arvoo Infrastructure Root CA" },
    { name: "organizationName", value: "Arvoo" },
    { shortName: "OU", value: "PKI" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certificatePem = forge.pki.certificateToPem(cert);
  const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const id = uuid();
  await run(
    `INSERT INTO pki_certificates (id, kind, name, serial, certificate, encrypted_private_key, not_before, not_after, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    "ca",
    "Arvoo Root CA",
    cert.serialNumber,
    certificatePem,
    encryptSecret(privateKeyPem),
    cert.validity.notBefore.toISOString(),
    cert.validity.notAfter.toISOString(),
    nowIso(),
  );
  return { id, certificatePem };
}

/**
 * The CN of an inbound's server certificate. The generated client profile pins
 * exactly this name (`verify-x509-name`), so both sides read it from here
 * instead of hardcoding a value that can drift.
 */
export function serverCommonName(inboundName: string): string {
  return `server-${inboundName}`;
}

export async function issueServerCertificate(
  inboundId: string,
  inboundName: string,
  domain?: string | null,
): Promise<IssuedCertificate> {
  const ca = await ensureRootCA();
  const caRow = await q1<{ certificate: string; encrypted_private_key: string }>(
    `SELECT certificate, encrypted_private_key FROM pki_certificates WHERE id = ?`,
    ca.id,
  );
  if (!caRow) throw notFound("Arvoo Root CA is missing");
  const caCert = forge.pki.certificateFromPem(caRow.certificate);
  const caKey = forge.pki.privateKeyFromPem(decryptSecret(caRow.encrypted_private_key));

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = pkiRandomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);
  cert.setSubject([
    { name: "commonName", value: serverCommonName(inboundName) },
    { name: "organizationName", value: "Arvoo" },
  ]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      // type 2 = DNS. The configured public domain is included when set so the
      // certificate is valid for the name users actually dial.
      altNames: [
        { type: 2, value: inboundName },
        ...(domain ? [{ type: 2, value: domain }] : []),
      ],
    },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  const certificatePem = forge.pki.certificateToPem(cert);
  const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const id = uuid();
  await run(
    `INSERT INTO pki_certificates (id, kind, name, inbound_id, serial, certificate, encrypted_private_key, not_before, not_after, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    "server",
    `server-${inboundName}`,
    inboundId,
    cert.serialNumber,
    certificatePem,
    encryptSecret(privateKeyPem),
    cert.validity.notBefore.toISOString(),
    cert.validity.notAfter.toISOString(),
    nowIso(),
  );
  return { certificatePem, privateKeyPem, serial: cert.serialNumber };
}

export async function issueClientCertificate(clientId: string, commonName: string): Promise<IssuedCertificate> {
  const ca = await ensureRootCA();
  const caRow = await q1<{ certificate: string; encrypted_private_key: string }>(
    `SELECT certificate, encrypted_private_key FROM pki_certificates WHERE id = ?`,
    ca.id,
  );
  if (!caRow) throw notFound("Arvoo Root CA is missing");
  const caCert = forge.pki.certificateFromPem(caRow.certificate);
  const caKey = forge.pki.privateKeyFromPem(decryptSecret(caRow.encrypted_private_key));

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = pkiRandomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 3);
  cert.setSubject([
    { name: "commonName", value: commonName },
    { name: "organizationName", value: "Arvoo" },
  ]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, critical: true },
    { name: "extKeyUsage", clientAuth: true },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  const certificatePem = forge.pki.certificateToPem(cert);
  const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const id = uuid();
  await run(
    `INSERT INTO pki_certificates (id, kind, name, client_id, serial, certificate, encrypted_private_key, not_before, not_after, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    "client",
    commonName,
    clientId,
    cert.serialNumber,
    certificatePem,
    encryptSecret(privateKeyPem),
    cert.validity.notBefore.toISOString(),
    cert.validity.notAfter.toISOString(),
    nowIso(),
  );
  return { certificatePem, privateKeyPem, serial: cert.serialNumber };
}

export async function revokeCertificatesFor(entityType: "inbound" | "client", entityId: string): Promise<void> {
  await run(`UPDATE pki_certificates SET revoked = 1 WHERE ${entityType === "inbound" ? "inbound_id" : "client_id"} = ?`, entityId);
}

/** Fetch PKI material needed to build a deployment payload. */
export async function serverMaterial(inboundId: string): Promise<{
  ca: string;
  cert: string;
  key: string;
}> {
  const ca = await q1<{ certificate: string }>(`SELECT certificate FROM pki_certificates WHERE kind = 'ca' LIMIT 1`);
  const server = await q1<{ certificate: string; encrypted_private_key: string }>(
    `SELECT certificate, encrypted_private_key FROM pki_certificates WHERE kind = 'server' AND inbound_id = ? AND revoked = 0`,
    inboundId,
  );
  if (!ca || !server) throw notFound("PKI material for this inbound is missing");
  return {
    ca: ca.certificate,
    cert: server.certificate,
    key: decryptSecret(server.encrypted_private_key),
  };
}

export async function clientMaterial(clientId: string): Promise<{ cert: string; key: string }> {
  const row = await q1<{ certificate: string; encrypted_private_key: string }>(
    `SELECT certificate, encrypted_private_key FROM pki_certificates WHERE kind = 'client' AND client_id = ? AND revoked = 0 ORDER BY created_at DESC LIMIT 1`,
    clientId,
  );
  if (!row) throw notFound("Client certificate is missing or revoked");
  return { cert: row.certificate, key: decryptSecret(row.encrypted_private_key) };
}
