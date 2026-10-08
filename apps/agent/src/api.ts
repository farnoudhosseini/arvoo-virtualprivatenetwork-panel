/**
 * Control plane HTTP client for the agent. Node identity is `arvoo-node
 * <id>:<secret>`; enrollment uses a short-lived token once.
 */

import type { AgentHelloResponse, AgentHeartbeatRequest, AgentHeartbeatResponse, AgentAuthorizeRequest, AgentAuthorizeResponse } from "@arvoo/shared";

export class AgentApi {
  constructor(
    private baseUrl: string,
    private credentials: () => { nodeId: string; nodeSecret: string } | null,
  ) {}

  private headers(): Record<string, string> {
    const creds = this.credentials();
    if (!creds) return {};
    return { Authorization: `Bearer arvoo-node ${creds.nodeId}:${creds.nodeSecret}` };
  }

  async hello(enrollmentToken: string, hostname: string, platform: string, agentVersion: string): Promise<AgentHelloResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/agent/hello`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollmentToken, hostname, platform, agentVersion }),
    });
    if (!res.ok) throw new Error(`Enrollment failed (${res.status}): ${await res.text()}`);
    return (await res.json()) as AgentHelloResponse;
  }

  async heartbeat(payload: AgentHeartbeatRequest): Promise<AgentHeartbeatResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/agent/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Heartbeat rejected (${res.status}): ${await res.text()}`);
    return (await res.json()) as AgentHeartbeatResponse;
  }

  async nextOperation(): Promise<{ operation: { id: string; type: string; input: unknown } | null }> {
    const res = await fetch(`${this.baseUrl}/api/v1/agent/operations`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Operation poll failed (${res.status})`);
    return (await res.json()) as { operation: { id: string; type: string; input: unknown } | null };
  }

  async reportOperationResult(id: string, success: boolean, output?: unknown, error?: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/agent/operations/${id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify({ success, output, error }),
    });
    if (!res.ok) throw new Error(`Result report failed (${res.status})`);
  }

  async authorize(payload: AgentAuthorizeRequest): Promise<AgentAuthorizeResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/agent/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { allow: false, reason: `Authorization request failed (${res.status})`, directives: [] };
    return (await res.json()) as AgentAuthorizeResponse;
  }
}

export const AGENT_VERSION = "0.1.0";
