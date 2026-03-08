import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type LogEntry } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { LogFilterBar, type LogFilters, emptyFilters } from "@/components/log-filters";
import { LogDetailModal } from "@/components/log-detail-modal";
import { useLogStream } from "@/hooks/use-log-stream";

const methodColors: Record<string, string> = {
  GET: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  POST: "bg-green-500/15 text-green-700 dark:text-green-400",
  DELETE: "bg-red-500/15 text-red-700 dark:text-red-400",
  PUT: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  PATCH: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
};

function statusColor(code: number) {
  if (code < 300) return "bg-green-500/15 text-green-700 dark:text-green-400";
  if (code < 400) return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
  if (code < 500) return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400";
  return "bg-red-500/15 text-red-700 dark:text-red-400";
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function buildParams(filters: LogFilters, limit: number, offset: number): string {
  const p = new URLSearchParams();
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  if (filters.method.length > 0) p.set("method", filters.method.join(","));
  if (filters.path) p.set("path", filters.path);
  if (filters.status) p.set("status", filters.status);
  if (filters.ip) p.set("ip", filters.ip);
  if (filters.from) p.set("from", new Date(filters.from).toISOString());
  if (filters.to) p.set("to", new Date(filters.to).toISOString());
  if (filters.minDuration) p.set("minDuration", filters.minDuration);
  return p.toString();
}

export default function Logs() {
  const [filters, setFilters] = useState<LogFilters>(emptyFilters);
  const [offset, setOffset] = useState(0);
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const limit = 30;

  const queryParams = useMemo(() => buildParams(filters, limit, offset), [filters, limit, offset]);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["logs", queryParams],
    queryFn: () => api.logs.list(queryParams),
  });

  const { liveLogs, status: wsStatus } = useLogStream();

  const hasFilters = filters.method.length > 0 || filters.path || filters.status ||
    filters.ip || filters.from || filters.to || filters.minDuration;

  // Merge live logs at top only on first page with no active filters
  const displayLogs = useMemo(() => {
    if (offset > 0 || hasFilters || !data?.data) return data?.data ?? [];
    const existingIds = new Set(data.data.map(l => l.id));
    const newLive = liveLogs.filter(l => l.id != null && !existingIds.has(l.id));
    return [...newLive, ...data.data];
  }, [data, liveLogs, offset, hasFilters]);

  const handleFilterChange = (f: LogFilters) => {
    setFilters(f);
    setOffset(0);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Request Logs</h1>
        <div className="flex items-center gap-1.5">
          <div className={`h-2 w-2 rounded-full ${
            wsStatus === "connected" ? "bg-green-500 animate-pulse" :
            wsStatus === "connecting" ? "bg-yellow-500" : "bg-gray-400"
          }`} />
          <span className="text-xs text-muted-foreground">
            {wsStatus === "connected" ? "Live" : wsStatus === "connecting" ? "Connecting..." : "Disconnected"}
          </span>
        </div>
      </div>

      <LogFilterBar filters={filters} onChange={handleFilterChange} onRefresh={() => refetch()} />

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {!isLoading && (
        <>
          <div className="rounded-md border overflow-x-auto">
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayLogs.map((log: LogEntry) => (
                  <TableRow
                    key={log.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setSelectedLogId(log.id)}
                  >
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge className={methodColors[log.method] ?? ""} variant="secondary">
                        {log.method}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs max-w-xs truncate">{log.path}</TableCell>
                    <TableCell>
                      <Badge className={statusColor(log.statusCode)} variant="secondary">
                        {log.statusCode}
                      </Badge>
                    </TableCell>
                    <TableCell className={`text-xs ${log.durationMs > 1000 ? "text-red-600 dark:text-red-400 font-medium" : ""}`}>
                      {log.durationMs}ms
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{log.ip}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatBytes(log.responseSize)}</TableCell>
                  </TableRow>
                ))}
                {displayLogs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                      No logs found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{data?.total ?? 0} total logs</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" disabled={!data || offset + limit >= data.total} onClick={() => setOffset(offset + limit)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}

      <LogDetailModal logId={selectedLogId} onClose={() => setSelectedLogId(null)} />
    </div>
  );
}
