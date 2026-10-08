/**
 * Defence-in-depth validation for privileged operation payloads.
 *
 * The control plane validates everything it accepts, but the agent is the
 * component that actually runs privileged commands as root, so it re-validates
 * every field before that field is used in a filesystem path, a systemd unit
 * name or a command argument. A compromised or buggy panel must not be able to
 * make the agent write outside its own directories or hand the kernel
 * nonsensical arguments.
 *
 * Every check is a pure function so it can be unit-tested without root.
 */

type Rec = Record<string, unknown>;

function asObject(value: unknown): Rec | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Rec;
  return null;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const GRE_KEY_RE = /^[0-9a-fA-F]{1,8}$/;

function isIpv4(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = value.match(IPV4_RE);
  if (!m) return false;
  return m.slice(1).every((part) => Number(part) <= 255);
}

function isCidr(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = value.match(CIDR_RE);
  if (!m) return false;
  if (!m.slice(1, 5).every((part) => Number(part) <= 255)) return false;
  const prefix = Number(m[5]);
  return prefix >= 0 && prefix <= 32;
}

/**
 * Names become directory names (`/etc/arvoo/openvpn/<name>`) and systemd
 * instance names (`arvoo-openvpn@<name>`). Reject anything that could escape
 * its directory, hide a file, or confuse systemd.
 */
function isSafeName(value: unknown, max = 63): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > max) return false;
  if (value === "." || value === "..") return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** Linux interface names: <= 15 chars (IFNAMSIZ-1), no "/" or whitespace. */
function isSafeIfName(value: unknown): value is string {
  return isSafeName(value, 15);
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isStringWithin(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isStringOrNull(value: unknown, max: number): boolean {
  return value === null || value === undefined || isStringWithin(value, max);
}

/** Max size (bytes) accepted for a generated file written to a node. */
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_PKI_BYTES = 256 * 1024;
const MAX_HOOK_BYTES = 64 * 1024;

function checkName(value: unknown, field: string): string | null {
  return isSafeName(value) ? null : `${field} must be 1-63 characters of [A-Za-z0-9._-] and may not start with a dot`;
}

function checkIfName(value: unknown, field: string): string | null {
  return isSafeIfName(value) ? null : `${field} is not a valid Linux interface name (max 15 characters, [A-Za-z0-9._-])`;
}

/** IPsec PSK: 16-128 URL-safe/base64 characters, no whitespace or control chars. */
function checkPsk(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_\-+/=]{16,128}$/.test(value)
    ? null
    : "psk must be 16-128 characters of [A-Za-z0-9_-+/=]";
}

/**
 * Common names go verbatim into the line-based OpenVPN management protocol,
 * so whitespace and control characters are rejected to stop command injection.
 */
function checkCommonName(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,62}$/.test(value)
    ? null
    : "commonName must be 1-63 characters of [A-Za-z0-9_.@-]";
}

function checkIpv4(value: unknown, field: string): string | null {
  return isIpv4(value) ? null : `${field} must be an IPv4 address`;
}

function checkCidr(value: unknown, field: string): string | null {
  return isCidr(value) ? null : `${field} must be an IPv4 CIDR such as 10.40.0.0/24`;
}

function checkInt(value: unknown, field: string, min: number, max: number): string | null {
  return isIntInRange(value, min, max) ? null : `${field} must be an integer between ${min} and ${max}`;
}

function checkRoutes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return "routes must be an array";
  if (value.length > 64) return "routes may contain at most 64 entries";
  for (const entry of value) {
    const route = asObject(entry);
    if (!route) return "each route must be an object";
    if (!isCidr(route.destination) && !isIpv4(route.destination)) {
      return "routes[].destination must be an IPv4 address or CIDR";
    }
    if (route.gateway !== undefined && route.gateway !== null && !isIpv4(route.gateway)) {
      return "routes[].gateway must be an IPv4 address";
    }
    if (route.device !== undefined && route.device !== null && !isSafeIfName(route.device)) {
      return "routes[].device is not a valid interface name";
    }
  }
  return null;
}

function checkPki(value: unknown): string | null {
  const pki = asObject(value);
  if (!pki) return "pki must be an object";
  for (const field of ["ca", "cert", "key"] as const) {
    if (!isStringWithin(pki[field], MAX_PKI_BYTES)) return `pki.${field} is missing or oversized`;
  }
  if (!isStringOrNull(pki.tlsKey, MAX_PKI_BYTES)) return "pki.tlsKey is oversized";
  if (!isStringOrNull(pki.dhParam, MAX_PKI_BYTES)) return "pki.dhParam is oversized";
  if (pki.tlsMode !== "tls-crypt" && pki.tlsMode !== "tls-auth" && pki.tlsMode !== "none") {
    return "pki.tlsMode must be tls-crypt, tls-auth or none";
  }
  // The OpenVPN config is generated from the control plane's TLS mode; a TLS key
  // must be present whenever the mode requires one.
  if (pki.tlsMode !== "none" && !isStringWithin(pki.tlsKey, MAX_PKI_BYTES)) {
    return `pki.tlsKey is required when tlsMode is ${String(pki.tlsMode)}`;
  }
  return null;
}

function checkEgress(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const egress = asObject(value);
  if (!egress) return "egress must be an object or null";
  if (!Array.isArray(egress.masqueradeSourceNetworks)) return "egress.masqueradeSourceNetworks must be an array";
  if (egress.masqueradeSourceNetworks.length > 32) return "egress.masqueradeSourceNetworks may contain at most 32 entries";
  for (const net of egress.masqueradeSourceNetworks) {
    const err = checkCidr(net, "egress.masqueradeSourceNetworks[]");
    if (err) return err;
  }
  if (egress.forwardFromSubnet !== undefined && egress.forwardFromSubnet !== null) {
    const err = checkCidr(egress.forwardFromSubnet, "egress.forwardFromSubnet");
    if (err) return err;
  }
  if (egress.egressInterface !== undefined && egress.egressInterface !== null && !isSafeIfName(egress.egressInterface)) {
    return "egress.egressInterface is not a valid interface name";
  }
  return null;
}

/**
 * Validate one operation payload.
 * Returns a human-readable reason when the payload must be rejected, or null
 * when it is safe to execute. Operations without a validator are rejected only
 * if their input is not an object.
 */
export function validateOperationInput(type: string, raw: unknown): string | null {
  const input = asObject(raw);

  switch (type) {
    case "CreateGRE": {
      if (!input) return "input must be an object";
      return (
        checkIfName(input.interfaceName, "interfaceName") ??
        checkIpv4(input.localEndpoint, "localEndpoint") ??
        checkIpv4(input.remoteEndpoint, "remoteEndpoint") ??
        checkIpv4(input.localTunnelIp, "localTunnelIp") ??
        checkIpv4(input.remoteTunnelIp, "remoteTunnelIp") ??
        checkCidr(input.tunnelNetwork, "tunnelNetwork") ??
        checkInt(input.mtu, "mtu", 576, 1500) ??
        checkInt(input.ttl, "ttl", 1, 255) ??
        (input.fouPort === null || input.fouPort === undefined ? null : checkInt(input.fouPort, "fouPort", 1024, 65535)) ??
        (input.key === null || input.key === undefined
          ? null
          : typeof input.key === "string" && GRE_KEY_RE.test(input.key)
            ? null
            : "key must be a 1-8 digit hexadecimal GRE key") ??
        checkRoutes(input.routes)
      );
    }
    case "DeleteGRE":
      if (!input) return "input must be an object";
      return checkIfName(input.interfaceName, "interfaceName");
    case "TestTunnel":
      if (!input) return "input must be an object";
      return (
        checkIfName(input.interfaceName, "interfaceName") ??
        checkIpv4(input.remoteTunnelIp, "remoteTunnelIp") ??
        checkInt(input.mtu, "mtu", 576, 1500)
      );
    case "CreateOpenVPNInbound":
    case "UpdateOpenVPNInbound": {
      if (!input) return "input must be an object";
      return (
        checkName(input.inboundName, "inboundName") ??
        checkInt(input.port, "port", 1, 65535) ??
        (input.protocol === "udp" || input.protocol === "tcp" ? null : "protocol must be udp or tcp") ??
        checkInt(input.maxClients, "maxClients", 1, 10000) ??
        checkCidr(input.clientNetwork, "clientNetwork") ??
        checkStringWithin(input.configText, MAX_CONFIG_BYTES, "configText") ??
        checkPki(input.pki) ??
        checkEgress(input.egress) ??
        checkStringOrNull(input.clientConnectHook, MAX_HOOK_BYTES, "clientConnectHook")
      );
    }
    case "DeleteOpenVPNInbound":
      if (!input) return "input must be an object";
      return (
        checkName(input.inboundName, "inboundName") ??
        ((input.clientNetwork === undefined || input.clientNetwork === null
          ? null
          : checkCidr(input.clientNetwork, "clientNetwork")))
      );
    case "RestartOpenVPN":
    case "StopOpenVPN":
      if (!input) return "input must be an object";
      return checkName(input.inboundName, "inboundName");
    case "KillClient":
      if (!input) return "input must be an object";
      return checkName(input.inboundName, "inboundName") ?? checkCommonName(input.commonName);
    case "ApplyIPsec":
      if (!input) return "input must be an object";
      return (
        checkIfName(input.interfaceName, "interfaceName") ??
        checkIpv4(input.localPublicIp, "localPublicIp") ??
        checkIpv4(input.remotePublicIp, "remotePublicIp") ??
        checkPsk(input.psk)
      );
    case "RemoveIPsec":
      if (!input) return "input must be an object";
      return checkIfName(input.interfaceName, "interfaceName");
    case "RunBenchmark":
      if (!input) return "input must be an object";
      return (
        checkIfName(input.interfaceName, "interfaceName") ??
        checkIpv4(input.remoteTunnelIp, "remoteTunnelIp") ??
        checkIpv4(input.localTunnelIp, "localTunnelIp") ??
        (input.pingCount === undefined || input.pingCount === null ? null : checkInt(input.pingCount, "pingCount", 1, 200)) ??
        (input.iperfSeconds === undefined || input.iperfSeconds === null ? null : checkInt(input.iperfSeconds, "iperfSeconds", 1, 60))
      );
    case "ApplyFirewallPolicy": {
      if (!input) return "input must be an object";
      return (
        checkName(input.inboundName, "inboundName") ??
        checkCidr(input.forwardFromSubnet, "forwardFromSubnet") ??
        checkIpv4(input.routeViaTunnelIp, "routeViaTunnelIp") ??
        (Array.isArray(input.masqueradeSourceNetworks)
          ? input.masqueradeSourceNetworks.length > 32
            ? "masqueradeSourceNetworks may contain at most 32 entries"
            : (input.masqueradeSourceNetworks.map((net) => checkCidr(net, "masqueradeSourceNetworks[]")).find((e) => e !== null) ?? null)
          : "masqueradeSourceNetworks must be an array")
      );
    }
    case "InstallOpenVPN":
    case "CollectDiagnostics":
    case "SyncConfiguration":
      return null;
    default:
      return `unknown operation type: ${type}`;
  }
}

function checkStringWithin(value: unknown, max: number, field: string): string | null {
  return isStringWithin(value, max) ? null : `${field} is missing, empty or larger than ${Math.floor(max / 1024)} KB`;
}

function checkStringOrNull(value: unknown, max: number, field: string): string | null {
  return isStringOrNull(value, max) ? null : `${field} is larger than ${Math.floor(max / 1024)} KB`;
}
