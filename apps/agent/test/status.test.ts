import { describe, expect, it } from "vitest";
import { parseOpenvpnStatus3 } from "../src/linux.js";

const SAMPLE = `OpenVPN STATISTICS
Updated,Mon Oct  7 16:40:22 2026
TUN/TAP read bytes,0
TUN/TAP write bytes,0
TCP/UDP read bytes,1024
TCP/UDP write bytes,2048
Auth read bytes,0
END
OpenVPN CLIENT LIST
Updated,Mon Oct  7 16:40:22 2026
Common Name,Real Address,Bytes Received,Bytes Sent,Connected Since
HEADER,CLIENT_LIST,Common Name,Real Address,Virtual Address,Bytes Received,Bytes Sent,Connected Since,Connected Since (time),Username,Client ID,Peer ID
CLIENT_LIST,client-A,5.6.7.8:41234,10.40.0.2,102400,204800,Mon Oct  7 16:20:00 2026,1767199200,,1,1
CLIENT_LIST,client-B,5.6.7.9:41235,,1024,2048,Mon Oct  7 15:20:00 2026,1767195600,,2,2
ROUTING TABLE
Virtual Address,Common Name,Real Address,Last Ref
10.40.0.2,client-A,5.6.7.8:41234,Mon Oct  7 16:40:00 2026
GLOBAL STATS
Max bcast/mcast queue length,0
END
`;

describe("openvpn status parser (status-version 3)", () => {
  it("extracts connected clients with counters", () => {
    const rows = parseOpenvpnStatus3(SAMPLE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      commonName: "client-A",
      realIp: "5.6.7.8:41234",
      vpnIp: "10.40.0.2",
      rxBytes: 102400,
      txBytes: 204800,
    });
  });

  it("handles a missing virtual address", () => {
    const rows = parseOpenvpnStatus3(SAMPLE);
    expect(rows[1]!.vpnIp).toBeNull();
  });

  it("returns empty for a malformed body", () => {
    expect(parseOpenvpnStatus3("garbage")).toEqual([]);
  });
});
