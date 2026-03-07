import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Shield, ScrollText, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DarkModeToggle } from "@/components/dark-mode-toggle";

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const navLink = (to: string, label: string, icon?: React.ReactNode) => (
    <Link
      to={to}
      onClick={() => setMenuOpen(false)}
      className={`text-sm flex items-center gap-1 ${location.pathname === to ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
    >
      {icon}
      {label}
    </Link>
  );

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="container mx-auto flex h-14 items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <Shield className="h-5 w-5" />
            <span>a11y Crawler</span>
          </Link>
          <nav className="hidden sm:flex items-center gap-4">
            {navLink("/", "Audits")}
            {navLink("/logs", "Logs", <ScrollText className="h-4 w-4" />)}
            <DarkModeToggle />
          </nav>
          <div className="flex sm:hidden items-center gap-1">
            <DarkModeToggle />
            <Button variant="ghost" size="sm" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle menu">
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>
        {menuOpen && (
          <div className="sm:hidden border-t px-4 py-3 flex flex-col gap-3">
            {navLink("/", "Audits")}
            {navLink("/logs", "Logs", <ScrollText className="h-4 w-4" />)}
          </div>
        )}
      </header>
      <main className="container mx-auto px-4 py-6">
        {children}
      </main>
    </div>
  );
}
