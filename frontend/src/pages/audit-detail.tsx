import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type PageResponse, type SharedIssueResponse } from "@/lib/api";
import { ProgressView } from "@/components/progress-view";
import { StatsCards } from "@/components/stats-cards";
import { IssueTable } from "@/components/issue-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/error-boundary";
import { Trash2, ArrowLeft, Globe, Clock, AlertTriangle } from "lucide-react";

export default function AuditDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: audit, isLoading, error, refetch } = useQuery({
    queryKey: ["audit", id],
    queryFn: () => api.audits.get(id!),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "running" || status === "pending" ? 5000 : false;
    },
  });

  const { data: pages } = useQuery({
    queryKey: ["pages", id],
    queryFn: () => api.pages.list(id!, "limit=200"),
    enabled: audit?.status === "completed",
  });

  const { data: shared } = useQuery({
    queryKey: ["shared", id],
    queryFn: () => api.issues.shared(id!),
    enabled: audit?.status === "completed",
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.audits.delete(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["audits"] });
      navigate("/");
    },
  });

  useEffect(() => {
    if (audit?.url) document.title = `${audit.url.replace(/^https?:\/\//, "")} — a11y Crawler`;
    else document.title = "Audit — a11y Crawler";
  }, [audit?.url]);

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64" /></div>;
  }

  if (error) {
    return <QueryError message={error.message} onRetry={() => refetch()} />;
  }

  if (!audit) {
    return <p className="text-muted-foreground">Audit not found</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/")} className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline text-sm">Audits</span>
          </Button>
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Globe className="h-5 w-5" />
              <span className="truncate max-w-md">{audit.url}</span>
            </h1>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
              <Clock className="h-3 w-3" />
              {new Date(audit.createdAt).toLocaleString()}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={audit.status === "completed" ? "default" : audit.status === "failed" ? "destructive" : "secondary"}>
            {audit.status}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => deleteMutation.mutate()}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {audit.status === "failed" && (
        <Card className="border-destructive">
          <CardContent className="pt-4">
            <p className="text-sm text-destructive">{audit.error ?? "Unknown error"}</p>
          </CardContent>
        </Card>
      )}

      {(audit.status === "pending" || audit.status === "running") && (
        <ProgressView auditId={id!} />
      )}

      {audit.status === "completed" && audit.summary && (
        <>
          <StatsCards summary={audit.summary} />

          <Tabs defaultValue="issues">
            <TabsList>
              <TabsTrigger value="issues">Issues</TabsTrigger>
              <TabsTrigger value="pages">Pages</TabsTrigger>
              <TabsTrigger value="shared">Shared</TabsTrigger>
              <TabsTrigger value="summary">Summary</TabsTrigger>
            </TabsList>

            <TabsContent value="issues" className="mt-4">
              <IssueTable auditId={id!} />
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

            <TabsContent value="summary" className="mt-4">
              <Card>
                <CardContent className="pt-4">
                  <pre className="text-xs overflow-x-auto whitespace-pre-wrap">
                    {JSON.stringify({ summary: audit.summary, discovery: audit.discovery, llmUsage: audit.llmUsage }, null, 2)}
                  </pre>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
