import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api, type PageResponse, type SharedIssueResponse } from "@/lib/api";
import { ProgressView } from "@/components/progress-view";
import { StatsCards } from "@/components/stats-cards";
import { IssueTable } from "@/components/issue-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ShieldCheck, AlertTriangle, Loader2, X, Download } from "lucide-react";

export default function Dashboard() {
  const [scanUrl, setScanUrl] = useState("");
  const [maxDepth, setMaxDepth] = useState(3);
  const [maxPages, setMaxPages] = useState(30);
  const [currentAuditId, setCurrentAuditId] = useState<string | null>(null);

  useEffect(() => { document.title = "Scanner — a11y Crawler"; }, []);

  const { mutate: startScan, isPending: isScanning, error: scanError, reset: resetScan } = useMutation({
    mutationFn: (url: string) => api.audits.create({ url, maxPages, maxDepth }),
    onSuccess: (audit) => {
      setCurrentAuditId(audit.id);
    },
  });

  const { data: audit } = useQuery({
    queryKey: ["audit", currentAuditId],
    queryFn: () => api.audits.get(currentAuditId!),
    enabled: !!currentAuditId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "running" || status === "pending" ? 3000 : false;
    },
  });

  const { data: pages } = useQuery({
    queryKey: ["pages", currentAuditId],
    queryFn: () => api.pages.list(currentAuditId!, "limit=200"),
    enabled: audit?.status === "completed",
  });

  const { data: shared } = useQuery({
    queryKey: ["shared", currentAuditId],
    queryFn: () => api.issues.shared(currentAuditId!),
    enabled: audit?.status === "completed",
  });

  const handleScan = (e: React.FormEvent) => {
    e.preventDefault();
    const url = scanUrl.trim();
    if (!url) return;
    startScan(url);
  };

  const handleReset = () => {
    setCurrentAuditId(null);
    setScanUrl("");
    resetScan();
  };

  const isActive = !!currentAuditId;
  const isRunning = audit?.status === "pending" || audit?.status === "running";
  const isCompleted = audit?.status === "completed";
  const isFailed = audit?.status === "failed";

  return (
    <div className="space-y-8">
      {/* Hero */}
      <div className="text-center space-y-4 py-6">
        <h1 className="text-3xl font-bold tracking-tight">Analyze Website Accessibility</h1>
        <p className="text-muted-foreground max-w-xl mx-auto text-sm">
          Paste your URL and scan in real-time to identify and fix WCAG compliance issues.
        </p>
        <form onSubmit={handleScan} className="flex gap-2 max-w-2xl mx-auto">
          <Input
            type="url"
            placeholder="https://example.com"
            value={scanUrl}
            onChange={(e) => setScanUrl(e.target.value)}
            className="flex-1 h-11"
            disabled={isScanning || isActive}
          />
          {isActive ? (
            <Button type="button" variant="outline" onClick={handleReset} className="h-11 px-6 shrink-0">
              <X className="h-4 w-4 mr-2" />
              New Scan
            </Button>
          ) : (
            <Button type="submit" disabled={isScanning || !scanUrl.trim()} className="h-11 px-6 shrink-0">
              {isScanning && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Scan Now
            </Button>
          )}
        </form>
        {!isActive && (
          <div className="flex items-center justify-center gap-6 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5">
              Max depth:
              <Input type="number" min={1} max={10} value={maxDepth} onChange={e => setMaxDepth(Number(e.target.value))} className="w-16 h-7 text-xs" />
            </label>
            <label className="flex items-center gap-1.5">
              Max pages:
              <Input type="number" min={1} max={50} value={maxPages} onChange={e => setMaxPages(Number(e.target.value))} className="w-20 h-7 text-xs" />
            </label>
          </div>
        )}
      </div>

      {/* Scan creation error */}
      {scanError && (
        <Card className="border-destructive">
          <CardContent className="pt-4">
            <p className="text-sm text-destructive">{scanError.message ?? "Failed to start scan. Please try again."}</p>
          </CardContent>
        </Card>
      )}

      {/* Progress */}
      {isActive && isRunning && <ProgressView auditId={currentAuditId!} />}

      {/* Scan failed */}
      {isFailed && (
        <Card className="border-destructive">
          <CardContent className="pt-4">
            <p className="text-sm text-destructive">{audit?.error ?? "The scan failed. Please try again with a different URL."}</p>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {isCompleted && audit?.summary && (
        <>
          <StatsCards summary={audit.summary} />

          <Tabs defaultValue="issues">
            <TabsList>
              <TabsTrigger value="issues">Issues</TabsTrigger>
              <TabsTrigger value="pages">Pages</TabsTrigger>
              <TabsTrigger value="shared">Shared</TabsTrigger>
            </TabsList>

            <TabsContent value="issues" className="mt-4">
              <IssueTable auditId={currentAuditId!} />
            </TabsContent>

            <TabsContent value="pages" className="mt-4">
              <div className="space-y-2">
                {pages?.data?.map((page: PageResponse) => (
                  <Card key={page.id} className="hover:bg-muted/30 transition-colors">
                    <CardContent className="py-3 flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-sm truncate">{page.title || page.url}</p>
                        <p className="text-xs text-muted-foreground truncate">{page.url}</p>
                      </div>
                      <Badge variant="secondary" className="shrink-0 ml-2 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        {page.issueCount ?? 0}
                      </Badge>
                    </CardContent>
                  </Card>
                ))}
                {(!pages?.data || pages.data.length === 0) && (
                  <p className="text-muted-foreground text-sm text-center py-8">No pages</p>
                )}
              </div>
            </TabsContent>

            <TabsContent value="shared" className="mt-4">
              <div className="grid gap-4 md:grid-cols-2">
                {shared?.data?.map((issue: SharedIssueResponse, i: number) => (
                  <Card key={i}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-mono">{issue.rule}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Found on {issue.pageCount} pages
                      </p>
                      {issue.suggestedFix && (
                        <p className="text-xs">{issue.suggestedFix}</p>
                      )}
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {(issue.pageUrls ?? []).slice(0, 3).map((url: string, j: number) => {
                          let label: string;
                          try { label = new URL(url).pathname || "/"; } catch { label = url; }
                          return (
                            <Badge key={j} variant="secondary" className="text-[10px] font-mono max-w-64 truncate">
                              {label}
                            </Badge>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {(!shared?.data || shared.data.length === 0) && (
                  <p className="text-muted-foreground text-sm text-center py-8 col-span-2">No shared issues</p>
                )}
              </div>
            </TabsContent>
          </Tabs>

          <Card>
            <CardContent className="p-6 space-y-4">
              <h2 className="text-lg font-semibold">Accessibility Report</h2>
              <div className="flex gap-8 text-sm">
                <div>
                  <p className="text-2xl font-bold tabular-nums">{audit.summary?.totalPages ?? 0}</p>
                  <p className="text-xs text-muted-foreground">Pages Scanned</p>
                </div>
                <div>
                  <p className="text-2xl font-bold tabular-nums">{audit.summary?.totalIssues ?? 0}</p>
                  <p className="text-xs text-muted-foreground">Issues Found</p>
                </div>
                {audit.finishedAt && audit.startedAt && (
                  <div>
                    <p className="text-2xl font-bold tabular-nums">
                      {Math.round((new Date(audit.finishedAt).getTime() - new Date(audit.startedAt).getTime()) / 1000)}s
                    </p>
                    <p className="text-xs text-muted-foreground">Scan Duration</p>
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button size="sm">
                  <Download className="h-4 w-4 mr-1.5" />
                  Download PDF Report
                </Button>
                <Button variant="outline" size="sm">
                  <Download className="h-4 w-4 mr-1.5" />
                  Export CSV
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Empty state */}
      {!isActive && !scanError && (
        <div className="text-center py-16 text-muted-foreground">
          <ShieldCheck className="h-12 w-12 mx-auto mb-4 opacity-20" />
          <p className="text-lg font-medium">Ready to analyze</p>
          <p className="text-sm mt-1">Enter a URL above to start your accessibility scan.</p>
        </div>
      )}
    </div>
  );
}
