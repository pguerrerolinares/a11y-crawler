import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, X } from "lucide-react";

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;

export interface LogFilters {
  method: string[];
  path: string;
  status: string;
  ip: string;
  from: string;
  to: string;
  minDuration: string;
}

export const emptyFilters: LogFilters = {
  method: [],
  path: "",
  status: "",
  ip: "",
  from: "",
  to: "",
  minDuration: "",
};

interface LogFilterBarProps {
  filters: LogFilters;
  onChange: (filters: LogFilters) => void;
  onRefresh: () => void;
}

export function LogFilterBar({ filters, onChange, onRefresh }: LogFilterBarProps) {
  const toggleMethod = (m: string) => {
    const next = filters.method.includes(m)
      ? filters.method.filter(x => x !== m)
      : [...filters.method, m];
    onChange({ ...filters, method: next });
  };

  const hasFilters = filters.method.length > 0 || filters.path || filters.status ||
    filters.ip || filters.from || filters.to || filters.minDuration;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground font-medium shrink-0">Method:</span>
        {METHODS.map(m => (
          <Badge
            key={m}
            variant={filters.method.includes(m) ? "default" : "outline"}
            className="cursor-pointer select-none"
            role="button"
            tabIndex={0}
            onClick={() => toggleMethod(m)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleMethod(m); } }}
          >
            {m}
          </Badge>
        ))}
      </div>

      <div className="grid gap-2 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <Input
          placeholder="Path..."
          value={filters.path}
          onChange={e => onChange({ ...filters, path: e.target.value })}
          className="text-sm"
        />
        <Input
          placeholder="Status (404, 4xx...)"
          value={filters.status}
          onChange={e => onChange({ ...filters, status: e.target.value })}
          className="text-sm"
        />
        <Input
          placeholder="IP..."
          value={filters.ip}
          onChange={e => onChange({ ...filters, ip: e.target.value })}
          className="text-sm"
        />
        <Input
          type="datetime-local"
          value={filters.from}
          onChange={e => onChange({ ...filters, from: e.target.value })}
          className="text-sm"
          title="From date"
        />
        <Input
          type="datetime-local"
          value={filters.to}
          onChange={e => onChange({ ...filters, to: e.target.value })}
          className="text-sm"
          title="To date"
        />
        <Input
          type="number"
          placeholder="Min duration (ms)"
          value={filters.minDuration}
          onChange={e => onChange({ ...filters, minDuration: e.target.value })}
          className="text-sm"
        />
      </div>

      <div className="flex items-center gap-2">
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => onChange(emptyFilters)}>
            <X className="h-3 w-3 mr-1" /> Clear
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-3 w-3 mr-1" /> Refresh
        </Button>
      </div>
    </div>
  );
}
