import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ShieldCheck, Bell, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DarkModeToggle } from "@/components/dark-mode-toggle";
import { Footer } from "@/components/footer";

const NAV_LINKS = [
  { to: "/", label: "Scanner" },
  { to: "/reports", label: "Audits" },
  { to: "/logs", label: "Logs" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = (to: string) =>
    to === "/" ? location.pathname === "/" : location.pathname.startsWith(to);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b bg-background sticky top-0 z-50">
        <div className="container mx-auto flex h-14 items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold text-foreground shrink-0">
            <ShieldCheck className="h-5 w-5" />
            <span>a11y Crawler</span>
          </Link>

          <nav className="hidden sm:flex items-center gap-6">
            {NAV_LINKS.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                className={`text-sm transition-colors ${
                  isActive(to)
                    ? "text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>

          <div className="hidden sm:flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground" aria-label="Notifications">
              <Bell className="h-4 w-4" />
            </Button>
            <DarkModeToggle />
            <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-semibold select-none">
              A
            </div>
          </div>

          <div className="flex sm:hidden items-center gap-1">
            <DarkModeToggle />
            <Button variant="ghost" size="sm" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle menu">
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        {menuOpen && (
          <div className="sm:hidden border-t px-4 py-3 flex flex-col gap-3">
            {NAV_LINKS.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                onClick={() => setMenuOpen(false)}
                className={`text-sm transition-colors ${
                  isActive(to)
                    ? "text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
        )}
      </header>

      <main className="flex-1 container mx-auto px-4 py-6">
        {children}
      </main>

      {/* <Footer /> */}
    </div>
  );
}
