import type { AgentOperationPayload } from "@arvoo/shared";
import * as ops from "./ops.js";
import { validateOperationInput } from "./validate-op.js";
import { AGENT_VERSION, AgentApi } from "./api.js";

export interface OpContext {
  controlPlaneUrl: string;
  nodeId: string;
  nodeSecret: string;
}

export async function executeOperation(op: AgentOperationPayload, ctx: OpContext, api: AgentApi): Promise<void> {
  try {
    // Re-validate every payload here, at the privileged boundary, before any
    // field reaches a filesystem path, a unit name or a command argument.
    const invalid = validateOperationInput(op.type, op.input);
    if (invalid) {
      await api.reportOperationResult(op.id, false, undefined, `Rejected invalid operation payload: ${invalid}`);
      return;
    }

    const input = op.input as never;
    let result: ops.OpResult;
    switch (op.type) {
      case "CreateGRE":
        result = await ops.applyGre(input);
        break;
      case "DeleteGRE":
        result = await ops.deleteGre(input);
        break;
      case "TestTunnel":
        result = await ops.testGre(input);
        break;
      case "CreateOpenVPNInbound":
      case "UpdateOpenVPNInbound":
        result = await ops.applyOpenVPNInbound(input, ctx);
        break;
      case "DeleteOpenVPNInbound":
        result = await ops.deleteOpenVPNInbound(input);
        break;
      case "RestartOpenVPN":
        result = await ops.restartOpenVPN(input);
        break;
      case "StopOpenVPN":
        result = await ops.stopOpenVPN(input);
        break;
      case "KillClient":
        result = await ops.killOpenVPNClient(input);
        break;
      case "ApplyIPsec":
        result = await ops.applyIPsec(input);
        break;
      case "RemoveIPsec":
        result = await ops.removeIPsec(input);
        break;
      case "RunBenchmark":
        result = await ops.runBenchmark(input);
        break;
      case "ApplyFirewallPolicy":
        result = await ops.applyFirewallPolicy(input);
        break;
      case "ConfigureFirewall":
        result = await ops.configureFirewall(input);
        break;
      case "InstallOpenVPN":
        result = await ops.installOpenVPN();
        break;
      case "CollectDiagnostics":
        result = await ops.collectDiagnostics();
        break;
      case "CleanupNode":
        result = await ops.cleanupNode(input);
        break;
      case "SyncConfiguration":
        result = { success: true, output: { note: "Configuration already synchronized declaratively" } };
        break;
      default:
        result = { success: false, error: `Unknown operation type: ${op.type}` };
    }
    await api.reportOperationResult(op.id, result.success, result.output, result.error);
  } catch (err) {
    await api
      .reportOperationResult(op.id, false, undefined, (err as Error).message)
      .catch(() => undefined);
  }
}

export function agentVersion(): string {
  return AGENT_VERSION;
}
