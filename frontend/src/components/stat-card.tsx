import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface StatCardProps {
  title: string;
  value: string | number;
  sub?: string;
  icon?: LucideIcon;
  iconClassName?: string;
  trend?: { label: string; positive?: boolean };
}

export function StatCard({ title, value, sub, icon: Icon, iconClassName, trend }: StatCardProps) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1 min-w-0">
            <p className="text-xs text-muted-foreground font-medium">{title}</p>
            <p className="text-2xl font-bold tabular-nums leading-none">{value}</p>
            {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
            {trend && (
              <p className={cn("text-xs font-medium", trend.positive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400")}>
                {trend.label}
              </p>
            )}
          </div>
          {Icon && (
            <div className={cn("h-8 w-8 rounded-md bg-muted flex items-center justify-center shrink-0", iconClassName)}>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
