import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type AuditResponse } from "@/lib/api";
import { StatCard } from "@/components/stat-card";
import { AuditFormDialog } from "@/components/audit-form";
import { QueryError } from "@/components/error-boundary";
import { Pagination } from "@/components/pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Calendar,
  AlertOctagon,
  FileWarning,
  CheckCircle2,
  Download,
  ExternalLink,
} from "lucide-react";

const statusColors: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-400 animate-pulse",
  completed: "bg-green-500/15 text-green-700 dark:text-green-400",
  failed: "bg-red-500/15 text-red-700 dark:text-red-400",
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

export default function Reports() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["audits"],
    queryFn: () => api.audits.list(),
  });

  const stats = useMemo(() => {
    const audits = data?.data ?? [];
    const completed = audits.filter((a) => a.status === "completed");
    const lastScan = audits.length > 0 ? new Date(audits[0].createdAt) : null;
    const critical = completed.reduce(
      (s, a) => s + (a.summary?.issuesByImpact?.critical ?? 0),
      0
    );
    const failing = completed.filter((a) => (a.summary?.totalIssues ?? 0) > 0).length;
    const totalIssues = completed.reduce((s, a) => s + (a.summary?.totalIssues ?? 0), 0);
    return { lastScan, critical, failing, totalIssues, completedCount: completed.length };
  }, [data]);

  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 10;

  const filteredAudits = useMemo(() => {
    const audits = data?.data ?? [];
    if (!search) return audits;
    const q = search.toLowerCase();
    return audits.filter(a => a.url.toLowerCase().includes(q));
  }, [data, search]);

  const paginatedAudits = filteredAudits.slice(offset, offset + limit);

  useEffect(() => { document.title = "Audits — a11y Crawler"; }, []);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Audits</h1>
          <p className="text-muted-foreground text-sm mt-1">
            View and manage all your accessibility audits
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <AuditFormDialog />
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4 mr-1.5" />
            Export All
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Last Scan"
          value={stats.lastScan ? dateFormatter.format(stats.lastScan) : "—"}
          sub={stats.completedCount > 0 ? `${stats.completedCount} scans completed` : "No scans yet"}
          icon={Calendar}
        />
        <StatCard
          title="Critical Issues"
          value={stats.critical}
          icon={AlertOctagon}
          iconClassName="bg-red-50 dark:bg-red-950"
          trend={stats.critical > 0 ? { label: "Needs attention", positive: false } : undefined}
        />
        <Card>
          <CardContent className="p-5 space-y-2">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-muted-foreground font-medium">Pages Failing</p>
                <p className="text-2xl font-bold tabular-nums mt-1">
                  {stats.failing}
                  <span className="text-sm font-normal text-muted-foreground"> / {stats.completedCount} scans</span>
                </p>
              </div>
              <div className="h-8 w-8 rounded-md bg-amber-50 dark:bg-amber-950 flex items-center justify-center shrink-0">
                <FileWarning className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>
            <Progress value={stats.completedCount > 0 ? (stats.failing / stats.completedCount) * 100 : 0} className="h-1.5" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-muted-foreground font-medium">Issues Fixed</p>
                <p className="text-2xl font-bold tabular-nums mt-1">{stats.totalIssues}</p>
                <p className="text-xs text-muted-foreground">across all scans</p>
              </div>
              <div className="h-8 w-8 rounded-md bg-green-50 dark:bg-green-950 flex items-center justify-center shrink-0">
                <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {error && <QueryError message={error.message} onRetry={() => refetch()} />}

      {/* Scan History */}
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-4 py-3 border-b gap-3">
            <h2 className="text-sm font-semibold shrink-0">Scan History</h2>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Search reports..."
                value={search}
                onChange={e => { setSearch(e.target.value); setOffset(0); }}
                className="h-8 text-xs w-48"
              />
              <span className="text-xs text-muted-foreground shrink-0">{filteredAudits.length} reports</span>
            </div>
          </div>

          {isLoading && (
            <div className="p-4 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          )}

          {!isLoading && (data?.data?.length ?? 0) === 0 && (
            <div className="text-center py-12 text-muted-foreground text-sm">
              No scans found. Create your first accessibility audit to get started.
            </div>
          )}

          {!isLoading && (data?.data?.length ?? 0) > 0 && (
            <>
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Website</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-center">WCAG Score</TableHead>
                      <TableHead className="text-center">Critical</TableHead>
                      <TableHead className="text-center">Issues</TableHead>
                      <TableHead className="text-center">Pages</TableHead>
                      <TableHead className="text-center">Status</TableHead>
                      <TableHead className="text-center">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedAudits.map((audit: AuditResponse) => (
                      <TableRow key={audit.id}>
                        <TableCell className="max-w-xs">
                          <div className="font-mono text-xs truncate" title={audit.url}>
                            {audit.url.replace(/^https?:\/\//, "")}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {dateFormatter.format(new Date(audit.createdAt))}
                        </TableCell>
                        <TableCell className="text-center tabular-nums text-sm font-medium">
                          {audit.summary?.totalIssues != null ? Math.max(0, Math.min(100, Math.round(100 - ((audit.summary.totalIssues ?? 0) / Math.max(1, audit.summary.totalPages ?? 1)) * 10))) : "—"}
                        </TableCell>
                        <TableCell className="text-center tabular-nums">
                          {audit.summary?.issuesByImpact?.critical != null ? (
                            <span className={audit.summary.issuesByImpact.critical > 0 ? "text-red-600 dark:text-red-400 font-medium" : ""}>
                              {audit.summary.issuesByImpact.critical}
                            </span>
                          ) : "—"}
                        </TableCell>
                        <TableCell className="text-center tabular-nums text-sm">
                          {audit.summary?.totalIssues ?? "—"}
                        </TableCell>
                        <TableCell className="text-center tabular-nums text-sm">
                          {audit.summary?.totalPages ?? "—"}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge
                            className={statusColors[audit.status] ?? statusColors.pending}
                            variant="secondary"
                          >
                            {audit.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-center">
                          <Link to={`/audits/${audit.id}`}>
                            <Button variant="outline" size="sm" className="h-7 text-xs">
                              <ExternalLink className="h-3 w-3 mr-1" />
                              Report
                            </Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden divide-y">
                {paginatedAudits.map((audit: AuditResponse) => (
                  <Link key={audit.id} to={`/audits/${audit.id}`} className="block px-4 py-3 hover:bg-muted/30 transition-colors">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-mono text-xs truncate font-medium">
                          {audit.url.replace(/^https?:\/\//, "")}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {dateFormatter.format(new Date(audit.createdAt))}
                        </p>
                      </div>
                      <Badge
                        className={`${statusColors[audit.status] ?? statusColors.pending} shrink-0`}
                        variant="secondary"
                      >
                        {audit.status}
                      </Badge>
                    </div>
                    {audit.summary && (
                      <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
                        <span>{audit.summary.totalIssues} issues</span>
                        {audit.summary.issuesByImpact?.critical ? (
                          <span className="text-red-600 dark:text-red-400">
                            {audit.summary.issuesByImpact.critical} critical
                          </span>
                        ) : null}
                        <span>{audit.summary.totalPages} pages</span>
                      </div>
                    )}
                  </Link>
                ))}
              </div>

              {filteredAudits.length > limit && (
                <div className="px-4 py-3 border-t">
                  <Pagination total={filteredAudits.length} limit={limit} offset={offset} onChange={setOffset} />
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
