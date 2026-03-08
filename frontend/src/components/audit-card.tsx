import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Globe, Clock, AlertTriangle } from "lucide-react";

const statusColors: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-400 animate-pulse",
  completed: "bg-green-500/15 text-green-700 dark:text-green-400",
  failed: "bg-red-500/15 text-red-700 dark:text-red-400",
};

interface AuditCardProps {
  audit: {
    id: string;
    url: string;
    status: string;
    createdAt: string;
    summary?: { totalIssues: number; totalPages: number; issuesByImpact?: Record<string, number> } | null;
  };
}

export function AuditCard({ audit }: AuditCardProps) {
  return (
    <Link to={`/audits/${audit.id}`}>
      <Card className="hover:border-foreground/20 transition-colors cursor-pointer">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <Badge className={statusColors[audit.status] ?? statusColors.pending} variant="secondary">
              {audit.status}
            </Badge>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {new Date(audit.createdAt).toLocaleDateString()}
            </span>
          </div>
          <CardTitle className="text-sm font-medium flex items-center gap-2 mt-2">
            <Globe className="h-4 w-4 shrink-0" />
            <span className="truncate">{audit.url}</span>
          </CardTitle>
        </CardHeader>
        {audit.summary && (
          <CardContent className="pt-0">
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{audit.summary.totalPages} pages</span>
              <span className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {audit.summary.totalIssues} issues
              </span>
              {audit.summary.issuesByImpact?.critical ? (
                <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                  {audit.summary.issuesByImpact.critical} critical
                </Badge>
              ) : null}
            </div>
          </CardContent>
        )}
      </Card>
    </Link>
  );
}
