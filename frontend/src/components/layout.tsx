import { Link, useLocation } from "react-router-dom";
import { Shield, ScrollText } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="container mx-auto flex h-14 items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <Shield className="h-5 w-5" />
            <span>a11y Crawler</span>
          </Link>
          <nav className="flex items-center gap-4">
            <Link
              to="/"
              className={`text-sm ${location.pathname === "/" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              Audits
            </Link>
            <Link
              to="/logs"
              className={`text-sm flex items-center gap-1 ${location.pathname === "/logs" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <ScrollText className="h-4 w-4" />
              Logs
            </Link>
          </nav>
        </div>
      </header>
      <main className="container mx-auto px-4 py-6">
        {children}
      </main>
    </div>
  );
}
