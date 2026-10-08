/**
 * Compatibility verdict from a real inspection (spec §2/§16/§17).
 *
 *   npx tsx scripts/endpoint-verdict.ts deploy/endpoint-inspection.example.json
 *
 * Reads the JSON produced by `scripts/endpoint-inspect.sh`, runs the shared
 * endpoint rules over every observed listener, prints the compatibility matrix
 * plus the per-inbound decision, and (optionally) writes the plan the share
 * script consumes. It changes nothing on any system.
 *
 * Exit codes: 0 = report produced, 1 = usage/read error,
 *             2 = --require-web-endpoint was passed and at least one inbound
 *                 cannot share, which is a normal and acceptable outcome.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  assessSharedEndpoint,
  buildCompatibilityMatrix,
  formatCompatibilityMatrix,
  type ObservedInbound,
  type ShareVerdict,
} from "../packages/shared/src/endpoint-sharing.js";

interface InspectionFile {
  generatedAt?: string;
  host?: string;
  kernel?: string;
  inbounds?: ObservedInbound[];
  note?: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function usage(): never {
  console.error(
    [
      "Usage: npx tsx scripts/endpoint-verdict.ts <inspection.json> [options]",
      "",
      "Options:",
      "  --web-port <n>            port the web service will listen on behind the share (default 8080)",
      "  --web-hostname <name>     hostname for the web vhost (recorded in the plan)",
      "  --conflicting <n,n>       ports already owned by an unrelated process",
      "  --emit-plan <file>        write the approved share plan for scripts/endpoint-share.sh",
      "  --require-web-endpoint    exit 2 when any inbound cannot share (reports, changes nothing)",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) usage();

const input = args[0]!;
const webPort = Number(optionValue("--web-port") ?? 8080);
const webHostname = optionValue("--web-hostname") ?? null;
const conflicts = (optionValue("--conflicting") ?? "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const planOut = optionValue("--emit-plan");
const requireShareable = args.includes("--require-web-endpoint");

function optionValue(flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} needs a value`);
  return value;
}

let inspection: InspectionFile;
try {
  inspection = JSON.parse(readFileSync(input, "utf8")) as InspectionFile;
} catch (err) {
  fail(`Could not read an inspection JSON from ${input}: ${(err as Error).message}`);
}

const inbounds = inspection.inbounds ?? [];
if (inbounds.length === 0) {
  console.log("No listeners in the inspection file: run scripts/endpoint-inspect.sh on the server first.");
  process.exit(0);
}

const options = { webPort, webHostname, conflictingOwners: conflicts };
const verdicts: Array<{ inbound: ObservedInbound; verdict: ShareVerdict }> = inbounds.map((inbound) => ({
  inbound,
  verdict: assessSharedEndpoint(inbound, options),
}));

console.log(`Shared endpoint assessment`);
console.log(`host: ${inspection.host ?? "unknown"}   kernel: ${inspection.kernel ?? "unknown"}`);
console.log(`inspected at: ${inspection.generatedAt ?? "unknown"}`);
console.log(`web service would listen on: 127.0.0.1:${webPort}${webHostname ? ` as ${webHostname}` : ""}`);
console.log("");
console.log("== Compatibility matrix ==");
console.log(formatCompatibilityMatrix(buildCompatibilityMatrix(inbounds, options)));
console.log("");

for (const { inbound, verdict } of verdicts) {
  const flag = verdict.possible ? `SHARE (${verdict.risk} risk, ${verdict.method})` : "LEAVE UNCHANGED";
  console.log(`== ${inbound.name}: ${flag} ==`);
  for (const reason of verdict.reasons) console.log(`   why: ${reason}`);
  if (verdict.possible) {
    for (const change of verdict.requiredChanges) console.log(`   change: ${change}`);
  }
  for (const rule of verdict.forbidden) console.log(`   never: ${rule}`);
  console.log(`   rollback: ${verdict.rollback[0]}`);
  console.log("");
}

const shareable = verdicts.filter((entry) => entry.verdict.possible);
const refused = verdicts.filter((entry) => !entry.verdict.possible);

console.log(`${shareable.length} of ${inbounds.length} listener(s) can share an endpoint with the web service; ${refused.length} must be left exactly as they are.`);

if (planOut) {
  const plan = {
    generatedAt: new Date().toISOString(),
    source: input,
    web: { listen: `127.0.0.1:${webPort}`, hostname: webHostname },
    approved: shareable.map((entry) => ({
      inbound: entry.inbound.name,
      method: entry.verdict.method,
      risk: entry.verdict.risk,
      // Where the shared endpoint already listens today; the share script never
      // invents a port, it only routes to one the inspection actually saw.
      listenPort: entry.inbound.ports?.[0] ?? null,
      requiredChanges: entry.verdict.requiredChanges,
    })),
    refused: refused.map((entry) => ({
      inbound: entry.inbound.name,
      reason: entry.verdict.reasons[0] ?? "not shareable",
    })),
    rollback: [
      "Restore the previous web server configuration from the timestamped backup.",
      "Reload the web server gracefully; never restart the inbound.",
      "Verify every listener in this inspection file is still present and unchanged.",
    ],
  };
  writeFileSync(planOut, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`wrote plan ${planOut}`);
  if (shareable.length === 0) {
    console.log("Plan contains no approvals: scripts/endpoint-share.sh will refuse to apply it.");
  }
}

if (requireShareable && refused.length > 0) {
  console.log("At least one inbound cannot share an endpoint; leaving it unchanged is the correct outcome.");
  process.exit(2);
}
