import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AuditCard } from "@/components/audit-card";
import { AuditFormDialog } from "@/components/audit-form";
import { QueryError } from "@/components/error-boundary";
import { Skeleton } from "@/components/ui/skeleton";
import { Shield } from "lucide-react";

export default function Dashboard() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["audits"],
    queryFn: () => api.audits.list(),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Audits</h1>
        <AuditFormDialog />
      </div>

      {error && <QueryError message={error.message} onRetry={() => refetch()} />}

      {isLoading && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      )}

      {data?.data?.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <Shield className="h-12 w-12 mx-auto mb-4 opacity-30" />
          <p className="text-lg">No audits yet</p>
          <p className="text-sm">Create your first accessibility audit to get started.</p>
        </div>
      )}

      {data?.data && data.data.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.data.map((audit: any) => (
            <AuditCard key={audit.id} audit={audit} />
          ))}
        </div>
      )}
    </div>
  );
}
