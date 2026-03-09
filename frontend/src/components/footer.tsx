import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";

export function Footer() {
  return (
    <footer className="bg-[#09090B] text-[#A1A1AA]">
      <div className="container mx-auto px-6 pt-12 pb-8">
        <div className="flex gap-16 flex-col sm:flex-row">
          <div className="sm:w-72 shrink-0 space-y-4">
            <Link to="/" className="flex items-center gap-2 text-white">
              <ShieldCheck className="h-5 w-5" />
              <span className="font-semibold">a11y Crawler</span>
            </Link>
            <p className="text-sm leading-relaxed max-w-xs">
              Making the web accessible for everyone. Scan, analyze, and fix
              accessibility issues with our powerful real-time analysis engine.
            </p>
          </div>
          <div className="flex flex-1 gap-12 flex-wrap">
            <div className="space-y-3 min-w-[110px]">
              <h4 className="text-white text-sm font-medium">Product</h4>
              <ul className="space-y-2 text-sm">
                <li>
                  <Link to="/" className="hover:text-white transition-colors">
                    Scanner
                  </Link>
                </li>
                <li>
                  <Link to="/reports" className="hover:text-white transition-colors">
                    Audits
                  </Link>
                </li>
                <li>
                  <Link to="/logs" className="hover:text-white transition-colors">
                    Logs
                  </Link>
                </li>
              </ul>
            </div>
            <div className="space-y-3 min-w-[110px]">
              <h4 className="text-white text-sm font-medium">Resources</h4>
              <ul className="space-y-2 text-sm">
                <li>Documentation</li>
                <li>WCAG Guidelines</li>
                <li>API Access</li>
                <li>Changelog</li>
                <li>Status</li>
              </ul>
            </div>
            <div className="space-y-3 min-w-[110px]">
              <h4 className="text-white text-sm font-medium">Company</h4>
              <ul className="space-y-2 text-sm">
                <li>About Us</li>
                <li>Careers</li>
                <li>GitHub</li>
                <li>Privacy Policy</li>
                <li>Terms of Service</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
      <div className="border-t border-[#27272A]" />
      <div className="container mx-auto px-6 py-4 flex items-center justify-between text-xs">
        <span>© 2026 a11y Crawler. All rights reserved.</span>
        <span className="border border-[#27272A] rounded px-2 py-1">
          WCAG 2.1 AA Compliant
        </span>
      </div>
    </footer>
  );
}
