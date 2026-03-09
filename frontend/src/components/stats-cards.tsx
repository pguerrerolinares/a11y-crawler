import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

interface StatsCardsProps {
  summary: {
    totalIssues: number;
    totalPages: number;
    issuesByImpact: Record<string, number>;
  };
}

export function StatsCards({ summary }: StatsCardsProps) {
  const { totalIssues, totalPages, issuesByImpact } = summary;

  const critical = issuesByImpact["critical"] ?? 0;
  const warnings = (issuesByImpact["moderate"] ?? 0) + (issuesByImpact["minor"] ?? 0);
  const passed = Math.max(0, totalPages - (issuesByImpact["critical"] ?? 0) - (issuesByImpact["serious"] ?? 0));
  const score = Math.max(0, Math.min(100, Math.round(100 - (totalIssues / Math.max(1, totalPages)) * 10)));

  const radius = 36;
  const strokeWidth = 6;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const ringColor = score >= 80 ? "#22c55e" : score >= 50 ? "#eab308" : "#ef4444";

  return (
    <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
      {/* Issues Found */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Issues Found</p>
              <p className="text-3xl font-bold mt-1">{totalIssues}</p>
              <p className="text-xs text-muted-foreground mt-1">{totalPages} pages scanned</p>
            </div>
            {critical > 0 && (
              <Badge variant="destructive" className="mt-1">
                {critical} critical
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Warnings */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Warnings</p>
              <p className="text-3xl font-bold mt-1 text-yellow-500">{warnings}</p>
              <p className="text-xs text-muted-foreground mt-1">moderate + minor</p>
            </div>
            <div className="bg-yellow-100 dark:bg-yellow-900/30 p-2 rounded-md">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Passed */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Passed</p>
              <p className="text-3xl font-bold mt-1 text-green-500">{passed}</p>
              <p className="text-xs text-muted-foreground mt-1">pages without critical/serious</p>
            </div>
            <div className="bg-green-100 dark:bg-green-900/30 p-2 rounded-md">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* WCAG Score */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">WCAG Score</p>
              <p className="text-3xl font-bold mt-1" style={{ color: ringColor }}>{score}</p>
              <p className="text-xs text-muted-foreground mt-1">out of 100</p>
            </div>
            <svg width="80" height="80" viewBox="0 0 80 80">
              <circle
                cx="40"
                cy="40"
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={strokeWidth}
                className="text-muted/20"
              />
              <circle
                cx="40"
                cy="40"
                r={radius}
                fill="none"
                stroke={ringColor}
                strokeWidth={strokeWidth}
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                strokeLinecap="round"
                transform="rotate(-90 40 40)"
              />
            </svg>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
