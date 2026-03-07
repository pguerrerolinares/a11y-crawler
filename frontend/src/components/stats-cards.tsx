import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, AlertOctagon, AlertCircle, Info, Globe } from "lucide-react";

interface StatsCardsProps {
  summary: {
    totalIssues: number;
    totalPages: number;
    issuesByImpact: Record<string, number>;
  };
}

const impactConfig = [
  { key: "critical", label: "Critical", icon: AlertOctagon, color: "text-red-600 dark:text-red-400" },
  { key: "serious", label: "Serious", icon: AlertTriangle, color: "text-orange-600 dark:text-orange-400" },
  { key: "moderate", label: "Moderate", icon: AlertCircle, color: "text-yellow-600 dark:text-yellow-400" },
  { key: "minor", label: "Minor", icon: Info, color: "text-blue-600 dark:text-blue-400" },
];

export function StatsCards({ summary }: StatsCardsProps) {
  return (
    <div className="grid gap-4 grid-cols-2 lg:grid-cols-5">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
            <Globe className="h-3 w-3" /> Total
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold">{summary.totalIssues}</p>
          <p className="text-xs text-muted-foreground">{summary.totalPages} pages</p>
        </CardContent>
      </Card>
      {impactConfig.map(({ key, label, icon: Icon, color }) => (
        <Card key={key}>
          <CardHeader className="pb-2">
            <CardTitle className={`text-xs flex items-center gap-1 ${color}`}>
              <Icon className="h-3 w-3" /> {label}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${color}`}>{summary.issuesByImpact[key] ?? 0}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
