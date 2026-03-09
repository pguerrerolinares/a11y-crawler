import { useState, useMemo, useCallback, memo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type LogEntry } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Braces, ArrowUpFromLine, ArrowDownToLine, Activity, AlertCircle, Clock, Download } from "lucide-react";
import { Pagination } from "@/components/pagination";
import { LogFilterBar, type LogFilters, emptyFilters } from "@/components/log-filters";
import { LogDetailModal } from "@/components/log-detail-modal";
import { StatCard } from "@/components/stat-card";
import { statusColor, formatBytes } from "@/lib/format";

const methodColors: Record<string, string> = {
  GET: "bg-green-500/15 text-green-700 dark:text-green-400",
  POST: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  DELETE: "bg-red-500/15 text-red-700 dark:text-red-400",
  PUT: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  PATCH: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "medium",
});

function durationClass(ms: number): string {
  if (ms >= 1000) return "text-red-600 dark:text-red-400 font-medium";
  if (ms >= 500) return "text-yellow-600 dark:text-yellow-400";
  return "";
}

function buildParams(filters: LogFilters, limit: number, offset: number): string {
  const p = new URLSearchParams();
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  if (filters.method.length > 0) p.set("method", filters.method.join(","));
  if (filters.path) p.set("path", filters.path);
  if (filters.status) p.set("status", filters.status);
  if (filters.ip) p.set("ip", filters.ip);
  if (filters.from) {
    const d = new Date(filters.from);
    if (!isNaN(d.getTime())) p.set("from", d.toISOString());
  }
  if (filters.to) {
    const d = new Date(filters.to);
    if (!isNaN(d.getTime())) p.set("to", d.toISOString());
  }
  if (filters.params) p.set("params", filters.params);
  if (filters.reqBody) p.set("reqBody", filters.reqBody);
  if (filters.resBody) p.set("resBody", filters.resBody);
  return p.toString();
}

type InitialTab = "general" | "request" | "response";

interface LogSelection {
  id: number;
  initialTab: InitialTab;
}

const LogRow = memo(function LogRow({
  log,
  onSelect,
}: {
  log: LogEntry;
  onSelect: (id: number, tab: InitialTab) => void;
}) {
  return (
    <TableRow className="cursor-pointer hover:bg-muted/50" onClick={() => onSelect(log.id, "general")}>
      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
        {dateFormatter.format(new Date(log.createdAt))}
      </TableCell>
      <TableCell className="min-w-[64px]">
        <Badge className={methodColors[log.method] ?? ""} variant="secondary">
          {log.method}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-xs max-w-xs truncate" title={log.path}>{log.path}</TableCell>
      <TableCell>
        <Badge className={statusColor(log.statusCode)} variant="secondary">
          {log.statusCode}
        </Badge>
      </TableCell>
      <TableCell className={`text-xs tabular-nums ${durationClass(log.durationMs)}`}>
        {log.durationMs}ms
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{log.ip}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{formatBytes(log.responseSize)}</TableCell>
      {/* Icon columns */}
      <TableCell className="w-8 text-center" onClick={e => { if (log.hasQueryParams) { e.stopPropagation(); onSelect(log.id, "request"); } }}>
        {log.hasQueryParams
          ? <Braces className="h-3 w-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 mx-auto" />
          : <span className="text-muted-foreground/30 text-xs">—</span>
        }
      </TableCell>
      <TableCell className="w-8 text-center" onClick={e => { if (log.hasRequestBody) { e.stopPropagation(); onSelect(log.id, "request"); } }}>
        {log.hasRequestBody
          ? <ArrowUpFromLine className="h-3 w-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 mx-auto" />
          : <span className="text-muted-foreground/30 text-xs">—</span>
        }
      </TableCell>
      <TableCell className="w-8 text-center" onClick={e => { if (log.hasResponseBody) { e.stopPropagation(); onSelect(log.id, "response"); } }}>
        {log.hasResponseBody
          ? <ArrowDownToLine className="h-3 w-3 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 mx-auto" />
          : <span className="text-muted-foreground/30 text-xs">—</span>
        }
      </TableCell>
    </TableRow>
  );
});

export default function Logs() {
  const [filters, setFilters] = useState<LogFilters>(emptyFilters);
  const [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<LogSelection | null>(null);
  const limit = 30;

  const queryParams = useMemo(() => buildParams(filters, limit, offset), [filters, offset]);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["logs", queryParams],
    queryFn: () => api.logs.list(queryParams),
  });

  const handleFilterChange = useCallback((f: LogFilters) => {
    setFilters(f);
    setOffset(0);
  }, []);

  const handleSelect = useCallback((id: number, initialTab: InitialTab) => {
    setSelection({ id, initialTab });
  }, []);

  const handleCloseModal = useCallback(() => setSelection(null), []);

  useEffect(() => { document.title = "Logs — a11y Crawler"; }, []);

  const logs = data?.data ?? [];

  const pageStats = useMemo(() => {
    const logs = data?.data ?? [];
    const errors4xx = logs.filter((l) => l.statusCode >= 400 && l.statusCode < 500).length;
    const errors5xx = logs.filter((l) => l.statusCode >= 500).length;
    const avgResponse =
      logs.length > 0
        ? Math.round(logs.reduce((s, l) => s + l.durationMs, 0) / logs.length)
        : 0;
    return { total: data?.total ?? 0, errors4xx, errors5xx, avgResponse };
  }, [data]);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Application Logs</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Monitor and analyze incoming HTTP requests
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4 mr-1.5" />
            Export
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="Total Requests" value={pageStats.total.toLocaleString()} icon={Activity} />
        <StatCard
          title="4xx Errors"
          value={pageStats.errors4xx}
          icon={AlertCircle}
          iconClassName="bg-amber-50 dark:bg-amber-950"
          trend={pageStats.errors4xx > 0 ? { label: "Client errors", positive: false } : undefined}
        />
        <StatCard
          title="5xx Errors"
          value={pageStats.errors5xx}
          icon={AlertCircle}
          iconClassName="bg-red-50 dark:bg-red-950"
          trend={pageStats.errors5xx > 0 ? { label: "Server errors", positive: false } : undefined}
        />
        <StatCard
          title="Avg Response"
          value={`${pageStats.avgResponse}ms`}
          icon={Clock}
        />
      </div>

      <LogFilterBar
        filters={filters}
        onChange={handleFilterChange}
        onRefresh={() => refetch()}
        isFetching={isFetching}
      />

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {!isLoading && (
        <>
          <div className="hidden md:block rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead className="w-8 text-center" title="Query Params">
                    <Braces className="h-3 w-3 text-muted-foreground mx-auto" />
                  </TableHead>
                  <TableHead className="w-8 text-center" title="Request Body">
                    <ArrowUpFromLine className="h-3 w-3 text-muted-foreground mx-auto" />
                  </TableHead>
                  <TableHead className="w-8 text-center" title="Response Body">
                    <ArrowDownToLine className="h-3 w-3 text-muted-foreground mx-auto" />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log: LogEntry) => (
                  <LogRow key={log.id} log={log} onSelect={handleSelect} />
                ))}
                {logs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                      No logs found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden divide-y rounded-md border">
            {logs.map((log: LogEntry) => (
              <div
                key={log.id}
                className="px-4 py-3 hover:bg-muted/30 transition-colors cursor-pointer"
                onClick={() => handleSelect(log.id, "general")}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge className={methodColors[log.method] ?? ""} variant="secondary">
                      {log.method}
                    </Badge>
                    <span className="font-mono text-xs truncate">{log.path}</span>
                  </div>
                  <Badge className={statusColor(log.statusCode)} variant="secondary">
                    {log.statusCode}
                  </Badge>
                </div>
                <div className="flex gap-4 mt-1.5 text-[10px] text-muted-foreground">
                  <span>{dateFormatter.format(new Date(log.createdAt))}</span>
                  <span className={durationClass(log.durationMs)}>{log.durationMs}ms</span>
                  <span>{log.ip}</span>
                </div>
              </div>
            ))}
            {logs.length === 0 && (
              <div className="text-center text-muted-foreground py-8 text-sm">No logs found</div>
            )}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{data?.total ?? 0} total logs</span>
            <Pagination total={data?.total ?? 0} limit={limit} offset={offset} onChange={setOffset} />
          </div>
        </>
      )}

      {selection !== null && (
        <LogDetailModal key={`${selection.id}-${selection.initialTab}`} logId={selection.id} initialTab={selection.initialTab} onClose={handleCloseModal} />
      )}
    </div>
  );
}
