import { useQuery } from "@tanstack/react-query";
import { api, type LogDetail } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface LogDetailModalProps {
  logId: number | null;
  onClose: () => void;
}

function statusColor(code: number) {
  if (code < 300) return "bg-green-500/15 text-green-700 dark:text-green-400";
  if (code < 400) return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
  if (code < 500) return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400";
  return "bg-red-500/15 text-red-700 dark:text-red-400";
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function JsonBlock({ data }: { data: unknown }) {
  if (!data) return <p className="text-sm text-muted-foreground">No data</p>;
  return (
    <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-80 overflow-y-auto">
      {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
    </pre>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground w-24 shrink-0">{label}</span>
      <span className="text-sm break-all">{value ?? "—"}</span>
    </div>
  );
}

export function LogDetailModal({ logId, onClose }: LogDetailModalProps) {
  const { data: log, isLoading } = useQuery({
    queryKey: ["log-detail", logId],
    queryFn: () => api.logs.get(logId!),
    enabled: logId !== null,
  });

  return (
    <Dialog open={logId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-sm">
            {log && (
              <>
                <Badge className={statusColor(log.statusCode)} variant="secondary">{log.statusCode}</Badge>
                <span>{log.method}</span>
                <span className="text-muted-foreground truncate">{log.path}</span>
              </>
            )}
            {!log && "Log Detail"}
          </DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}

        {log && (
          <Tabs defaultValue="general">
            <TabsList>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="request">Request</TabsTrigger>
              <TabsTrigger value="response">Response</TabsTrigger>
              {log.error && <TabsTrigger value="error">Error</TabsTrigger>}
            </TabsList>

            <TabsContent value="general" className="mt-3 space-y-1">
              <InfoRow label="Method" value={log.method} />
              <InfoRow label="Path" value={<span className="font-mono">{log.path}</span>} />
              <InfoRow label="Status" value={<Badge className={statusColor(log.statusCode)} variant="secondary">{log.statusCode}</Badge>} />
              <InfoRow label="Duration" value={`${log.durationMs}ms`} />
              <InfoRow label="IP" value={log.ip} />
              <InfoRow label="User-Agent" value={log.userAgent} />
              <InfoRow label="Time" value={new Date(log.createdAt).toLocaleString()} />
            </TabsContent>

            <TabsContent value="request" className="mt-3 space-y-4">
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2">Query Parameters</h4>
                {log.queryParams && Object.keys(log.queryParams).length > 0 ? (
                  <div className="bg-muted/50 rounded-md p-3 space-y-1">
                    {Object.entries(log.queryParams).map(([k, v]) => (
                      <div key={k} className="flex gap-2 text-xs">
                        <span className="font-mono font-medium">{k}:</span>
                        <span className="font-mono text-muted-foreground">{v}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No query parameters</p>
                )}
              </div>
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2">Request Body</h4>
                <JsonBlock data={log.requestBody} />
              </div>
            </TabsContent>

            <TabsContent value="response" className="mt-3 space-y-4">
              <div className="flex flex-col gap-1">
                <InfoRow label="Content-Type" value={log.contentType} />
                <InfoRow label="Size" value={formatBytes(log.responseSize)} />
              </div>
              <div>
                <h4 className="text-xs font-medium text-muted-foreground mb-2">
                  Response Body
                  {log.responseBody && log.responseBody.length >= 2048 && (
                    <span className="ml-2 text-yellow-600 dark:text-yellow-400">(truncated to 2KB)</span>
                  )}
                </h4>
                <JsonBlock data={log.responseBody} />
              </div>
            </TabsContent>

            {log.error && (
              <TabsContent value="error" className="mt-3">
                <div className="bg-red-500/10 border border-red-500/20 rounded-md p-4">
                  <p className="text-sm text-red-700 dark:text-red-400 font-mono whitespace-pre-wrap">{log.error}</p>
                </div>
              </TabsContent>
            )}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
