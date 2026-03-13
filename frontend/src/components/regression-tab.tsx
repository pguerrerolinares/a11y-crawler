import type { RegressionDiff } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowUp, ArrowDown, Minus, Plus, Check, AlertTriangle } from "lucide-react";

interface RegressionTabProps {
  regression: RegressionDiff;
}

function ScoreBadge({ change }: { change: number | null }) {
  if (change === null) return <Badge variant="secondary">N/A</Badge>;
  if (change > 0) return <Badge className="bg-green-600 text-white gap-1"><ArrowUp className="h-3 w-3" />+{change}</Badge>;
  if (change < 0) return <Badge variant="destructive" className="gap-1"><ArrowDown className="h-3 w-3" />{change}</Badge>;
  return <Badge variant="secondary" className="gap-1"><Minus className="h-3 w-3" />0</Badge>;
}

export function RegressionTab({ regression }: RegressionTabProps) {
  const { summary, matched, unmatchedNew, unmatchedRemoved, scoreChange, previousAuditDate } = regression;

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Score Change</CardTitle>
          </CardHeader>
          <CardContent>
            <ScoreBadge change={scoreChange} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">New Issues</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold text-destructive">{summary.totalNewIssues}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Resolved Issues</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold text-green-600">{summary.totalResolvedIssues}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Templates</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 text-sm">
              {summary.newTemplates > 0 && <Badge variant="secondary"><Plus className="h-3 w-3 mr-1" />{summary.newTemplates} new</Badge>}
              {summary.removedTemplates > 0 && <Badge variant="secondary"><Minus className="h-3 w-3 mr-1" />{summary.removedTemplates} removed</Badge>}
              {summary.newTemplates === 0 && summary.removedTemplates === 0 && <span className="text-muted-foreground">No changes</span>}
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        Compared against audit from {new Date(previousAuditDate).toLocaleString()}
      </p>

      {/* Matched templates */}
      {matched.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Template Comparison</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {matched.map((m, i) => (
                <div key={i} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-mono">{m.currentTemplateId}</span>
                    <Badge variant="outline" className="text-[10px]">{m.matchMethod}</Badge>
                  </div>
                  {m.newIssues.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-destructive flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" /> New issues
                      </p>
                      {m.newIssues.map((issue, j) => (
                        <div key={j} className="flex items-center gap-2 text-xs pl-4">
                          <Badge variant="destructive" className="text-[10px]">{issue.impact}</Badge>
                          <span className="font-mono">{issue.rule}</span>
                          <span className="text-muted-foreground">&times;{issue.count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {m.resolvedIssues.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-green-600 flex items-center gap-1">
                        <Check className="h-3 w-3" /> Resolved
                      </p>
                      {m.resolvedIssues.map((issue, j) => (
                        <div key={j} className="flex items-center gap-2 text-xs pl-4">
                          <Badge variant="secondary" className="text-[10px]">{issue.impact}</Badge>
                          <span className="font-mono">{issue.rule}</span>
                          <span className="text-muted-foreground">&times;{issue.count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {m.newIssues.length === 0 && m.resolvedIssues.length === 0 && (
                    <p className="text-xs text-muted-foreground">No changes in this template</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Unmatched templates */}
      {(unmatchedNew.length > 0 || unmatchedRemoved.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Unmatched Templates</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {unmatchedNew.map((id) => (
              <div key={id} className="flex items-center gap-2 text-xs">
                <Badge className="bg-blue-600 text-white text-[10px]">NEW</Badge>
                <span className="font-mono">{id}</span>
              </div>
            ))}
            {unmatchedRemoved.map((id) => (
              <div key={id} className="flex items-center gap-2 text-xs">
                <Badge variant="secondary" className="text-[10px]">REMOVED</Badge>
                <span className="font-mono">{id}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
