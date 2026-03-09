import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/layout";
import { ErrorBoundary } from "./components/error-boundary";
import Dashboard from "./pages/dashboard";
import AuditDetail from "./pages/audit-detail";
import Logs from "./pages/logs";
import Reports from "./pages/reports";

export default function App() {
  return (
    <Layout>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/audits/:id" element={<AuditDetail />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/reports" element={<Reports />} />
        </Routes>
      </ErrorBoundary>
    </Layout>
  );
}
