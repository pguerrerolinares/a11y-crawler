import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type IssueResponse } from "@/lib/api";
import { Pagination } from "@/components/pagination";

const impactColors: Record<string, string> = {
  critical: "bg-red-500/15 text-red-700 dark:text-red-400",
  serious: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  moderate: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  minor: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
};

const sourceColors: Record<string, string> = {
  axe: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
  interactive: "bg-teal-500/15 text-teal-700 dark:text-teal-400",
  llm: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400",
};

const sourceLabels: Record<string, string> = {
  axe: "axe-core",
  interactive: "Interactive",
  llm: "LLM",
};

interface IssueTableProps {
  auditId: string;
  pageId?: string;
}

export function IssueTable({ auditId, pageId }: IssueTableProps) {
  const [impact, setImpact] = useState("");
  const [source, setSource] = useState("");
  const [rule, setRule] = useState("");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const limit = 20;

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (impact) params.set("impact", impact);
  if (rule) params.set("rule", rule);

  const fetcher = pageId
    ? () => api.issues.byPage(pageId, params.toString())
    : () => api.issues.byAudit(auditId, params.toString());

  const { data, isLoading } = useQuery({
    queryKey: ["issues", auditId, pageId, impact, rule, offset],
    queryFn: fetcher,
  });

  // Client-side source filter (DB doesn't have this filter)
  const filtered = data
    ? { ...data, data: source ? data.data.filter((i: IssueResponse) => i.checkSource === source) : data.data }
    : data;

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <Select value={impact} onValueChange={(v: string | null) => { setImpact(!v || v === "all" ? "" : v); setOffset(0); }}>
          <SelectTrigger className="w-36" aria-label="Filter by impact"><SelectValue placeholder="Impact" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All impacts</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
            <SelectItem value="serious">Serious</SelectItem>
            <SelectItem value="moderate">Moderate</SelectItem>
            <SelectItem value="minor">Minor</SelectItem>
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={(v: string | null) => { setSource(!v || v === "all" ? "" : v); setOffset(0); }}>
          <SelectTrigger className="w-36" aria-label="Filter by source"><SelectValue placeholder="Source" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="axe">axe-core</SelectItem>
            <SelectItem value="interactive">Interactive</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Filter by rule..."
          value={rule}
          onChange={(e) => { setRule(e.target.value); setOffset(0); }}
          className="w-48"
        />
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {filtered && (
        <>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rule</TableHead>
                  <TableHead>Impact</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="hidden md:table-cell">Category</TableHead>
                  <TableHead className="hidden lg:table-cell">Suggested Fix</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.data.map((issue: IssueResponse) => (
                  <Fragment key={issue.id}>
                    <TableRow
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => setExpanded(expanded === issue.id ? null : issue.id)}
                    >
                      <TableCell className="font-mono text-xs">{issue.rule}</TableCell>
                      <TableCell>
                        <Badge className={impactColors[issue.impact] ?? ""} variant="secondary">
                          {issue.impact}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={sourceColors[issue.checkSource] ?? ""} variant="secondary">
                          {sourceLabels[issue.checkSource] ?? issue.checkSource}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs">{issue.category ?? "—"}</TableCell>
                      <TableCell className="hidden lg:table-cell text-xs max-w-xs truncate">
                        {issue.suggestedFix ?? "—"}
                      </TableCell>
                    </TableRow>
                    {expanded === issue.id && (
                      <TableRow key={`${issue.id}-detail`}>
                        <TableCell colSpan={5} className="bg-muted/30">
                          <div className="space-y-2 text-xs p-2">
                            <p><strong>Description:</strong> {issue.description}</p>
                            <p><strong>Selector:</strong> <code className="bg-muted px-1 rounded">{issue.selector}</code></p>
                            {issue.html && (
                              <pre className="bg-muted p-2 rounded overflow-x-auto text-[10px]">{issue.html}</pre>
                            )}
                            {issue.suggestedFix && (
                              <p><strong>Fix:</strong> {issue.suggestedFix}</p>
                            )}
                            {issue.helpUrl && (
                              <a href={issue.helpUrl} target="_blank" rel="noopener" className="text-blue-500 underline">
                                Learn more
                              </a>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
                {filtered.data.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      No issues found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{filtered.data.length}{source ? ` (filtered from ${data?.total ?? 0})` : ""} total issues</span>
            {!source && <Pagination total={data?.total ?? 0} limit={limit} offset={offset} onChange={setOffset} />}
          </div>
        </>
      )}
    </div>
  );
}
