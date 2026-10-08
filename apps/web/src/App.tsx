import { Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { NodesPage } from "./pages/Nodes";
import { NodeDetailPage } from "./pages/NodeDetail";
import { InboundsPage } from "./pages/Inbounds";
import { InboundNewPage } from "./pages/InboundNew";
import { InboundDetailPage } from "./pages/InboundDetail";
import { ClientsPage } from "./pages/Clients";
import { ClientDetailPage } from "./pages/ClientDetail";
import { PoliciesPage } from "./pages/Policies";
import { TunnelsPage } from "./pages/Tunnels";
import { TunnelDetailPage } from "./pages/TunnelDetail";
import { TopologyPage } from "./pages/Topology";
import { RoutingPage } from "./pages/Routing";
import { OperationsPage } from "./pages/Operations";
import { AlertsPage } from "./pages/Alerts";
import { AuditPage } from "./pages/Audit";
import { ActivityPage } from "./pages/Activity";
import { SettingsPage } from "./pages/Settings";
import { LoadBalancingPage } from "./pages/LoadBalancing";
import { FirewallPage } from "./pages/Firewall";
import { TooltipProvider } from "./components/ui/overlay";

export default function App() {
  return (
    <TooltipProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="nodes" element={<NodesPage />} />
          <Route path="nodes/:id" element={<NodeDetailPage />} />
          <Route path="inbounds" element={<InboundsPage />} />
          <Route path="inbounds/new" element={<InboundNewPage />} />
          <Route path="inbounds/:id" element={<InboundDetailPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="clients/:id" element={<ClientDetailPage />} />
          <Route path="policies" element={<PoliciesPage />} />
          <Route path="tunnels" element={<TunnelsPage />} />
          <Route path="tunnels/:id" element={<TunnelDetailPage />} />
          <Route path="topology" element={<TopologyPage />} />
          <Route path="routing" element={<RoutingPage />} />
          <Route path="operations" element={<OperationsPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="load-balancing" element={<LoadBalancingPage />} />
          <Route path="firewall" element={<FirewallPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </TooltipProvider>
  );
}
