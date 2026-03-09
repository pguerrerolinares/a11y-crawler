import { memo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Dialog, DialogContent, DialogClose } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { statusColor, formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Eye,
  ArrowUpFromLine,
  ArrowDownToLine,
  List,
  Clock,
  Monitor,
  FileText,
  X,
} from "lucide-react";

type Section = "overview" | "request" | "response" | "headers" | "timing" | "user-agent";
type InitialTab = "general" | "request" | "response";

const TAB_TO_SECTION: Record<InitialTab, Section> = {
  general: "overview",
  request: "request",
  response: "response",
};

const SECTIONS: { id: Section; label: string; icon: React.ElementType }[] = [
  { id: "overview", label: "Overview", icon: Eye },
  { id: "request", label: "Request", icon: ArrowUpFromLine },
  { id: "response", label: "Response", icon: ArrowDownToLine },
  { id: "headers", label: "Headers", icon: List },
  { id: "timing", label: "Timing", icon: Clock },
  { id: "user-agent", label: "User Agent", icon: Monitor },
];

function tryPrettyJson(data: unknown): string {
  if (typeof data === "string") {
    try { return JSON.stringify(JSON.parse(data), null, 2); } catch { return data; }
  }
  return JSON.stringify(data, null, 2);
}

function JsonBlock({ data }: { data: unknown }) {
  if (!data) return <p className="text-sm text-muted-foreground">No data</p>;
  return (
    <pre className="text-xs bg-zinc-950 dark:bg-zinc-900 text-zinc-200 rounded-md p-3 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-all max-h-64 w-full">
      {tryPrettyJson(data)}
    </pre>
  );
}

function FieldRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
      <div className="text-sm font-medium break-words">{value ?? "—"}</div>
    </div>
  );
}

function HeaderKV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-3 px-3 py-2">
      <span className="font-mono text-xs text-muted-foreground w-36 shrink-0 truncate">{k}</span>
      <span className="font-mono text-xs truncate">{v}</span>
    </div>
  );
}

function SectionHeading({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2 pb-2">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <h3 className="text-sm font-semibold">{title}</h3>
    </div>
  );
}

function parseUserAgent(ua: string | null) {
  if (!ua) return null;
  let browser = "Unknown";
  if (ua.includes("Edg/") || ua.includes("Edge/")) {
    const m = ua.match(/Edg(?:e)?\/(\d+)/);
    browser = `Edge ${m?.[1] ?? ""}`.trim();
  } else if (ua.includes("Firefox/")) {
    const m = ua.match(/Firefox\/(\d+)/);
    browser = `Firefox ${m?.[1] ?? ""}`.trim();
  } else if (ua.includes("Chrome/")) {
    const m = ua.match(/Chrome\/(\d+)/);
    browser = `Chrome ${m?.[1] ?? ""}`.trim();
  } else if (ua.includes("Safari/") && ua.includes("Version/")) {
    const m = ua.match(/Version\/(\d+)/);
    browser = `Safari ${m?.[1] ?? ""}`.trim();
  }
  const device = /Mobile|Android|iPhone|iPad/.test(ua) ? "Mobile" : "Desktop";
  let os = "Unknown";
  if (ua.includes("Windows NT")) {
    const m = ua.match(/Windows NT ([\d.]+)/);
    const v: Record<string, string> = { "10.0": "10/11", "6.3": "8.1", "6.2": "8", "6.1": "7" };
    os = `Windows ${v[m?.[1] ?? ""] ?? m?.[1] ?? ""}`.trim();
  } else if (ua.includes("Mac OS X")) {
    const m = ua.match(/Mac OS X ([\d_]+)/);
    os = `macOS ${(m?.[1] ?? "").replace(/_/g, ".")}`.trim();
  } else if (ua.includes("Android")) {
    const m = ua.match(/Android ([\d.]+)/);
    os = `Android ${m?.[1] ?? ""}`.trim();
  } else if (ua.includes("Linux")) {
    os = "Linux";
  }
  let engine = "Unknown";
  if (ua.includes("AppleWebKit/")) engine = "WebKit / Blink";
  else if (ua.includes("Gecko/")) engine = "Gecko";
  return { browser, device, os, engine };
}

export interface LogDetailModalProps {
  logId: number | null;
  initialTab?: InitialTab;
  onClose: () => void;
}

export const LogDetailModal = memo(function LogDetailModal({
  logId,
  initialTab = "general",
  onClose,
}: LogDetailModalProps) {
  const [activeSection, setActiveSection] = useState<Section>(
    TAB_TO_SECTION[initialTab] ?? "overview"
  );

  const { data: log, isLoading } = useQuery({
    queryKey: ["log-detail", logId],
    queryFn: () => api.logs.get(logId!),
    enabled: logId !== null,
  });

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  const handleCopyCurl = () => {
    if (!log) return;
    navigator.clipboard.writeText(`curl -X ${log.method} "https://yourhost${log.path}"`).catch(() => {});
  };

  const handleCopyId = () => {
    if (!log) return;
    navigator.clipboard.writeText(String(log.id)).catch(() => {});
  };

  const ua = parseUserAgent(log?.userAgent ?? null);

  return (
    <Dialog open={logId !== null} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[860px] h-[90vh] sm:h-[85vh] p-0 gap-0 flex flex-col overflow-hidden"
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between border-b px-4 py-3 gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-7 w-7 rounded bg-muted flex items-center justify-center shrink-0">
              <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="font-medium text-sm leading-none">Request Details</p>
              {log && (
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {log.path} · {new Date(log.createdAt).toLocaleString()}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
            {log && (
              <>
                <Badge className={statusColor(log.statusCode)} variant="secondary">
                  {log.statusCode} OK
                </Badge>
                <Badge variant="outline" className="text-xs">{log.method}</Badge>
                <Badge variant="outline" className="text-xs">{log.durationMs}ms</Badge>
              </>
            )}
            <DialogClose render={
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            } />
          </div>
        </div>

        {/* ── Body ── */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Mobile horizontal tabs */}
          <div className="sm:hidden flex border-b overflow-x-auto shrink-0 bg-background">
            {SECTIONS.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setActiveSection(id)}
                className={cn(
                  "px-4 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors shrink-0",
                  activeSection === id
                    ? "border-foreground text-foreground font-medium"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-1 overflow-hidden">
            {/* Desktop side nav */}
            <div className="hidden sm:flex flex-col w-44 border-r p-3 gap-0.5 shrink-0">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-2 pb-2">
                Sections
              </p>
              {SECTIONS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveSection(id)}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left w-full transition-colors",
                    activeSection === id
                      ? "bg-muted text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  {label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-5">
              {isLoading && (
                <div className="space-y-3">
                  <Skeleton className="h-5 w-1/3" />
                  <Skeleton className="h-28 w-full" />
                </div>
              )}

              {log && activeSection === "overview" && (
                <div className="space-y-5">
                  <SectionHeading icon={Eye} title="Overview" />
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
                    <FieldRow label="Timestamp" value={new Date(log.createdAt).toLocaleString()} />
                    <FieldRow label="Method" value={log.method} />
                    <FieldRow label="IP Address" value={<span className="font-mono">{log.ip}</span>} />
                    <FieldRow
                      label="HTTP Status"
                      value={
                        <Badge className={statusColor(log.statusCode)} variant="secondary">
                          {log.statusCode}
                        </Badge>
                      }
                    />
                    <FieldRow
                      label="Duration"
                      value={
                        <span className={log.durationMs >= 500 ? "text-amber-600 dark:text-amber-400" : ""}>
                          {log.durationMs}ms
                        </span>
                      }
                    />
                    <FieldRow label="Response Size" value={formatBytes(log.responseSize)} />
                  </div>
                  <FieldRow
                    label="Endpoint"
                    value={<span className="font-mono text-xs break-all">{log.path}</span>}
                  />
                </div>
              )}

              {log && activeSection === "request" && (
                <div className="space-y-5">
                  <SectionHeading icon={ArrowUpFromLine} title="Request" />
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Query Parameters</p>
                    {log.queryParams && Object.keys(log.queryParams).length > 0 ? (
                      <div className="rounded-md border divide-y text-sm">
                        {Object.entries(log.queryParams).map(([k, v]) => (
                          <div key={k} className="flex gap-3 px-3 py-2">
                            <span className="font-mono font-medium w-36 shrink-0 truncate text-xs">{k}</span>
                            <span className="font-mono text-xs text-muted-foreground">{String(v)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No query parameters</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Request Body</p>
                    <JsonBlock data={log.requestBody} />
                  </div>
                </div>
              )}

              {log && activeSection === "response" && (
                <div className="space-y-5">
                  <SectionHeading icon={ArrowDownToLine} title="Response" />
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={statusColor(log.statusCode)} variant="secondary">
                      {log.statusCode}
                    </Badge>
                    {log.contentType && (
                      <Badge variant="outline" className="text-xs font-mono">
                        {log.contentType.split(";")[0]}
                      </Badge>
                    )}
                    <Badge variant="outline" className="text-xs">
                      {formatBytes(log.responseSize)}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">
                      Response Body
                      {log.responseBody && log.responseSize && log.responseBody.length < log.responseSize && (
                        <span className="ml-2 text-amber-600 dark:text-amber-400">(truncated)</span>
                      )}
                    </p>
                    <JsonBlock data={log.responseBody} />
                  </div>
                  {log.error && (
                    <div className="rounded-md bg-destructive/10 border border-destructive/20 p-4">
                      <p className="text-xs font-medium text-destructive mb-1">Error</p>
                      <p className="text-sm font-mono whitespace-pre-wrap text-destructive/90">{log.error}</p>
                    </div>
                  )}
                </div>
              )}

              {log && activeSection === "headers" && (
                <div className="space-y-5">
                  <SectionHeading icon={List} title="Headers" />
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                      Request Headers
                    </p>
                    <div className="rounded-md border divide-y">
                      {log.userAgent && <HeaderKV k="User-Agent" v={log.userAgent} />}
                      <HeaderKV k="Accept" v="*/*" />
                      <HeaderKV k="Content-Type" v="application/json" />
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                      Response Headers
                    </p>
                    <div className="rounded-md border divide-y">
                      {log.contentType && <HeaderKV k="Content-Type" v={log.contentType} />}
                      <HeaderKV k="X-Request-ID" v={String(log.id)} />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground italic">
                    Full request/response headers are not captured at this log level.
                  </p>
                </div>
              )}

              {log && activeSection === "timing" && (
                <div className="space-y-5">
                  <SectionHeading icon={Clock} title="Timing" />
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">Total Duration</span>
                      <span className="font-bold tabular-nums">{log.durationMs}ms</span>
                    </div>
                    <div className="w-full h-2.5 rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-blue-500 via-violet-500 to-emerald-500 w-full" />
                    </div>
                    <p className="text-xs text-muted-foreground italic">
                      Detailed timing breakdown (DNS, TCP, TTFB) is not captured at this log level.
                    </p>
                  </div>
                </div>
              )}

              {log && activeSection === "user-agent" && (
                <div className="space-y-5">
                  <SectionHeading icon={Monitor} title="User Agent" />
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">Raw String</p>
                    <p className="text-xs font-mono bg-muted/50 rounded-md p-3 break-all leading-relaxed">
                      {log.userAgent ?? "—"}
                    </p>
                  </div>
                  {ua && (
                    <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                      <FieldRow label="Browser" value={ua.browser} />
                      <FieldRow label="Device" value={ua.device} />
                      <FieldRow label="OS" value={ua.os} />
                      <FieldRow label="Engine" value={ua.engine} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="border-t px-4 py-3 flex items-center justify-between shrink-0">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleCopyCurl}>Copy as cURL</Button>
            <Button variant="outline" size="sm" onClick={handleCopyId}>Copy Request ID</Button>
          </div>
          <Button size="sm" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
});
