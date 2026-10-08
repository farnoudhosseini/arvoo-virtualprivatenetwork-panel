/**
 * Structured configuration validation. Pure functions - shared by API
 * (request validation) and tests.
 */

import {
  COMPAT_CIPHERS,
  SUPPORTED_DATA_CIPHERS,
  PERFORMANCE_PROFILES,
  profileAdjustments,
} from "./openvpn";
import type { OpenVPNStructuredConfig } from "./types";

export interface FieldIssue {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: FieldIssue[];
  warnings: FieldIssue[];
}

const CIPHER_WHITELIST = new Set<string>(COMPAT_CIPHERS);

function validIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((p) => Number(p) >= 0 && Number(p) <= 255);
}

function validCidr(cidr: string, maxPrefix: number): boolean {
  const [addr, prefixStr] = cidr.split("/");
  if (!addr || !prefixStr) return false;
  const prefix = Number(prefixStr);
  return validIpv4(addr) && Number.isInteger(prefix) && prefix >= 8 && prefix <= maxPrefix;
}

function subnetCapacity(cidr: string): number {
  const prefix = Number(cidr.split("/")[1]);
  return Math.max(2, Math.pow(2, 32 - prefix) - 2);
}

export function validateOpenVPNConfig(cfg: OpenVPNStructuredConfig): ValidationResult {
  const errors: FieldIssue[] = [];
  const warnings: FieldIssue[] = [];

  // Port
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    errors.push({ field: "port", message: "Port must be an integer between 1 and 65535." });
  } else if (cfg.port < 1024) {
    warnings.push({ field: "port", message: "Ports below 1024 require elevated privileges on the node." });
  }

  // Listen address
  if (cfg.listenAddress !== "0.0.0.0" && !validIpv4(cfg.listenAddress)) {
    errors.push({ field: "listenAddress", message: "Listen address must be a valid IPv4 address or 0.0.0.0." });
  }

  // Server network
  if (!validCidr(cfg.serverNetwork, 30)) {
    errors.push({ field: "serverNetwork", message: "VPN network must be a valid IPv4 CIDR (prefix /8 to /30)." });
  } else {
    const capacity = subnetCapacity(cfg.serverNetwork);
    if (cfg.maxClients > capacity) {
      errors.push({
        field: "maxClients",
        message: `max-clients ${cfg.maxClients} exceeds the address capacity of ${cfg.serverNetwork} (${capacity} hosts).`,
      });
    }
    if (cfg.serverNetwork.startsWith("10.0.0.0/")) {
      warnings.push({ field: "serverNetwork", message: "Overlaps the common 10.0.0.0/8 home/office range; clients behind such networks may fail to route." });
    }
    if (cfg.serverNetwork.startsWith("192.168.") && cfg.redirectGateway) {
      warnings.push({ field: "serverNetwork", message: "192.168.x.x VPN range frequently conflicts with client LANs when redirect-gateway is enabled." });
    }
  }

  // MTU / MSS
  if (!Number.isInteger(cfg.tunMtu) || cfg.tunMtu < 576 || cfg.tunMtu > 1500) {
    errors.push({ field: "tunMtu", message: "tun MTU must be an integer between 576 and 1500." });
  }
  if (cfg.mssFix != null && (!Number.isInteger(cfg.mssFix) || cfg.mssFix < 200 || cfg.mssFix > cfg.tunMtu - 40)) {
    errors.push({ field: "mssFix", message: `MSS must be an integer between 200 and tun-mtu - 40 (${cfg.tunMtu - 40}).` });
  }
  if (cfg.tunMtu > 1420) {
    warnings.push({ field: "tunMtu", message: "tun-mtu above 1420 commonly causes fragmentation for paths with extra encapsulation." });
  }

  // Ciphers
  if (cfg.dataCiphers.length === 0) {
    errors.push({ field: "dataCiphers", message: "At least one data cipher is required." });
  }
  for (const c of cfg.dataCiphers) {
    if (!CIPHER_WHITELIST.has(c)) {
      errors.push({ field: "dataCiphers", message: `Unsupported data cipher "${c}". Supported: ${[...COMPAT_CIPHERS].join(", ")}.` });
    }
  }
  if (cfg.fallbackCipher && !CIPHER_WHITELIST.has(cfg.fallbackCipher)) {
    errors.push({ field: "fallbackCipher", message: `Unsupported fallback cipher "${cfg.fallbackCipher}".` });
  }
  if (cfg.performanceProfile !== "compatibility" && cfg.dataCiphers.some((c) => c.endsWith("-CBC"))) {
    errors.push({ field: "dataCiphers", message: "CBC ciphers are only allowed in the compatibility profile." });
  }

  // TLS
  if (cfg.tlsMode !== "tls-crypt" && cfg.tlsMode !== "tls-auth" && cfg.tlsMode !== "none") {
    errors.push({ field: "tlsMode", message: "TLS mode must be tls-crypt, tls-auth or none." });
  }
  if (cfg.tlsVersionMin !== "1.2" && cfg.tlsVersionMin !== "1.3") {
    errors.push({ field: "tlsVersionMin", message: "Minimum TLS version must be 1.2 or 1.3." });
  }

  // Keepalive
  if (cfg.keepaliveTimeout <= cfg.keepaliveInterval) {
    errors.push({ field: "keepaliveTimeout", message: "Keepalive timeout must be greater than the interval." });
  }

  // maxClients
  if (!Number.isInteger(cfg.maxClients) || cfg.maxClients < 1 || cfg.maxClients > 10000) {
    errors.push({ field: "maxClients", message: "max-clients must be between 1 and 10000." });
  }

  // Profile
  if (!PERFORMANCE_PROFILES[cfg.performanceProfile]) {
    errors.push({ field: "performanceProfile", message: "Unknown performance profile." });
  }

  // DNS
  for (const dns of cfg.dnsServers) {
    if (!validIpv4(dns)) errors.push({ field: "dnsServers", message: `Invalid DNS server IP: ${dns}` });
  }

  // Push routes
  for (const r of cfg.pushRoutes) {
    if (!validCidr(r, 32)) {
      errors.push({ field: "pushRoutes", message: `Pushed route must be a CIDR: ${r}` });
    }
  }

  // Deployment mode
  if (cfg.deploymentMode === "through-tunnel" && !cfg.tunnelId) {
    errors.push({ field: "tunnelId", message: "A tunnel must be selected for through-tunnel deployment." });
  }

  // Profile-specific adjustments sanity (e.g. compatibility forces tls-auth)
  const adj = profileAdjustments(cfg.performanceProfile);
  if (cfg.tlsMode === "none" && adj.tlsMode === "none") {
    warnings.push({ field: "tlsMode", message: "Running without tls-crypt/tls-auth exposes the control channel to passive inspection and port-scanners." });
  }

  if (cfg.compression !== "off") {
    errors.push({ field: "compression", message: "Compression must be off (VUVNARA/CRIME risk and CPU waste)." });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
