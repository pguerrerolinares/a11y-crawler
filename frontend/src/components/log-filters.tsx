import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, X, Braces, ArrowUpFromLine, ArrowDownToLine } from "lucide-react";

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;

const methodActiveColors: Record<string, string> = {
  GET: "bg-green-500/20 text-green-700 dark:text-green-300 border-green-500/40",
  POST: "bg-blue-500/20 text-blue-700 dark:text-blue-300 border-blue-500/40",
  PUT: "bg-yellow-500/20 text-yellow-700 dark:text-yellow-300 border-yellow-500/40",
  DELETE: "bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/40",
  PATCH: "bg-purple-500/20 text-purple-700 dark:text-purple-300 border-purple-500/40",
};

export interface LogFilters {
  method: string[];
  path: string;
  status: string;
  ip: string;
  from: string;
  to: string;
  params: string;
  reqBody: string;
  resBody: string;
}

export const emptyFilters: LogFilters = {
  method: [],
  path: "",
  status: "",
  ip: "",
  from: "",
  to: "",
  params: "",
  reqBody: "",
  resBody: "",
};

interface LogFilterBarProps {
  filters: LogFilters;
  onChange: (filters: LogFilters) => void;
  onRefresh: () => void;
  isFetching?: boolean;
}

export function LogFilterBar({ filters, onChange, onRefresh, isFetching }: LogFilterBarProps) {
  const toggleMethod = (m: string) => {
    const next = filters.method.includes(m)
      ? filters.method.filter(x => x !== m)
      : [...filters.method, m];
    onChange({ ...filters, method: next });
  };

  const hasFilters = !!(filters.method.length > 0 || filters.path || filters.status ||
    filters.ip || filters.from || filters.to || filters.params || filters.reqBody || filters.resBody);

  return (
    <div className="space-y-2">
      {/* Row 1: Method chips + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground font-medium shrink-0">Method</span>
        {METHODS.map(m => {
          const active = filters.method.includes(m);
          return (
            <button
              key={m}
              onClick={() => toggleMethod(m)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleMethod(m); } }}
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                active
                  ? methodActiveColors[m]
                  : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
              }`}
            >
              {m}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-1.5">
          {hasFilters && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onChange(emptyFilters)}>
              <X className="h-3 w-3 mr-1" /> Clear
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={onRefresh}>
            <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      {/* Row 2: Basic filters */}
      <div className="grid gap-2 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
        <Input
          placeholder="Path..."
          value={filters.path}
          onChange={e => onChange({ ...filters, path: e.target.value })}
          className="h-8 text-xs"
        />
        <Input
          placeholder="Status (404, 4xx…)"
          value={filters.status}
          onChange={e => onChange({ ...filters, status: e.target.value })}
          className="h-8 text-xs"
        />
        <Input
          placeholder="IP…"
          value={filters.ip}
          onChange={e => onChange({ ...filters, ip: e.target.value })}
          className="h-8 text-xs"
        />
        <div className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none leading-none">From</span>
          <Input
            type="datetime-local"
            value={filters.from}
            onChange={e => onChange({ ...filters, from: e.target.value })}
            className="h-8 text-xs pl-9"
            aria-label="From date"
          />
        </div>
        <div className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none leading-none">To</span>
          <Input
            type="datetime-local"
            value={filters.to}
            onChange={e => onChange({ ...filters, to: e.target.value })}
            className="h-8 text-xs pl-7"
            aria-label="To date"
          />
        </div>
      </div>

      {/* Row 3: Advanced filters */}
      <div className="grid gap-2 grid-cols-1 md:grid-cols-3">
        <div className="relative">
          <Braces className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search params…"
            value={filters.params}
            onChange={e => onChange({ ...filters, params: e.target.value })}
            className="h-8 text-xs pl-7"
          />
        </div>
        <div className="relative">
          <ArrowUpFromLine className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search req body…"
            value={filters.reqBody}
            onChange={e => onChange({ ...filters, reqBody: e.target.value })}
            className="h-8 text-xs pl-7"
          />
        </div>
        <div className="relative">
          <ArrowDownToLine className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search res body…"
            value={filters.resBody}
            onChange={e => onChange({ ...filters, resBody: e.target.value })}
            className="h-8 text-xs pl-7"
          />
        </div>
      </div>

      {hasFilters && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-muted-foreground font-medium">Active:</span>
          {filters.method.map(m => (
            <span key={m} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
              {m}
              <button onClick={() => onChange({ ...filters, method: filters.method.filter(x => x !== m) })} className="hover:text-foreground">
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          {filters.status && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
              Status: {filters.status}
              <button onClick={() => onChange({ ...filters, status: "" })} className="hover:text-foreground"><X className="h-2.5 w-2.5" /></button>
            </span>
          )}
          {filters.path && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
              Path: {filters.path}
              <button onClick={() => onChange({ ...filters, path: "" })} className="hover:text-foreground"><X className="h-2.5 w-2.5" /></button>
            </span>
          )}
          {filters.ip && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
              IP: {filters.ip}
              <button onClick={() => onChange({ ...filters, ip: "" })} className="hover:text-foreground"><X className="h-2.5 w-2.5" /></button>
            </span>
          )}
          {(filters.from || filters.to) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
              Date range
              <button onClick={() => onChange({ ...filters, from: "", to: "" })} className="hover:text-foreground"><X className="h-2.5 w-2.5" /></button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
