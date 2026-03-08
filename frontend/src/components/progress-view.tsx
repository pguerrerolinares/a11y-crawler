import { useAuditWebSocket } from "@/hooks/use-websocket";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Loader2, Globe, AlertTriangle, Clock } from "lucide-react";

interface ProgressViewProps {
  auditId: string;
}

export function ProgressView({ auditId }: ProgressViewProps) {
  const { events, isConnected } = useAuditWebSocket(auditId, true);

  const progressEvents = events.filter((e) => e.type === "progress");
  const pageEvents = events.filter((e) => e.type === "page_analyzed");
  const latest = progressEvents[progressEvents.length - 1]?.data;

  const pagesAnalyzed = (latest?.pagesAnalyzed as number) ?? 0;
  const totalDiscovered = (latest?.totalDiscovered as number) ?? 0;
  const elapsed = (latest?.elapsedSeconds as number) ?? 0;
  const progressPct = totalDiscovered > 0 ? Math.min((pagesAnalyzed / totalDiscovered) * 100, 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
        <h2 className="text-lg font-semibold">Audit in Progress</h2>
        <Badge variant={isConnected ? "default" : "secondary"} className="text-[10px]">
          {isConnected ? "Live" : "Connecting..."}
        </Badge>
      </div>

      <Progress value={progressPct} className="h-2" />

      <div className="grid gap-4 grid-cols-2 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
              <Globe className="h-3 w-3" /> Pages Analyzed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{pagesAnalyzed}</p>
            <p className="text-xs text-muted-foreground">{totalDiscovered} discovered</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> Issues Found
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {pageEvents.reduce((sum, e) => sum + ((e.data.issueCount as number) ?? 0), 0)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" /> Elapsed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{elapsed}s</p>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">Recent Activity</h3>
        <div className="max-h-64 overflow-y-auto space-y-1.5">
          {[...pageEvents].reverse().slice(0, 20).map((e, i) => (
            <div key={i} className="text-xs flex items-center gap-2 p-2 rounded bg-muted/50">
              <Globe className="h-3 w-3 shrink-0" />
              <span className="truncate">{e.data.url as string}</span>
              <Badge variant="secondary" className="ml-auto text-[10px] shrink-0">
                {e.data.issueCount as number} issues
              </Badge>
            </div>
          ))}
          {pageEvents.length === 0 && (
            <p className="text-xs text-muted-foreground">Waiting for events...</p>
          )}
        </div>
      </div>
    </div>
  );
}
