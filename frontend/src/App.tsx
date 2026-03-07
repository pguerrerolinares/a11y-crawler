import { Routes, Route } from "react-router-dom";
import { Layout } from "./components/layout";
import Dashboard from "./pages/dashboard";
import AuditDetail from "./pages/audit-detail";
import Logs from "./pages/logs";

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/audits/:id" element={<AuditDetail />} />
        <Route path="/logs" element={<Logs />} />
      </Routes>
    </Layout>
  );
}
