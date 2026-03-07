import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Zap, Search } from "lucide-react";
import { api } from "@/lib/api";

interface FormData {
  url: string;
  wcagLevel: "A" | "AA" | "AAA";
  maxPages: number;
  maxDepth: number;
  concurrency: number;
}

const QUICK_SCAN: Partial<FormData> = { maxPages: 10, maxDepth: 3, wcagLevel: "AA" };
const FULL_AUDIT: Partial<FormData> = { maxPages: 100, maxDepth: 5, wcagLevel: "AAA" };

export function AuditFormDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormData>({
    url: "",
    wcagLevel: "AA",
    maxPages: 100,
    maxDepth: 5,
    concurrency: 2,
  });
  const [error, setError] = useState("");

  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (data: FormData) => api.audits.create(data),
    onSuccess: (result: any) => {
      queryClient.invalidateQueries({ queryKey: ["audits"] });
      setOpen(false);
      navigate(`/audits/${result.id}`);
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      new URL(form.url);
    } catch {
      setError("Please enter a valid URL");
      return;
    }
    mutation.mutate(form);
  };

  const applyPreset = (preset: Partial<FormData>) => {
    setForm((f) => ({ ...f, ...preset }));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus className="h-4 w-4 mr-2" />
        New Audit
      </DialogTrigger>
      <DialogContent className="max-sm:max-w-[100vw] max-sm:h-[100dvh] max-sm:rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Start New Audit</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Input
              placeholder="https://example.com"
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              required
            />
          </div>

          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => applyPreset(QUICK_SCAN)}>
              <Zap className="h-3 w-3 mr-1" />
              Quick Scan
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => applyPreset(FULL_AUDIT)}>
              <Search className="h-3 w-3 mr-1" />
              Full Audit
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">WCAG Level</label>
              <Select value={form.wcagLevel} onValueChange={(v) => setForm((f) => ({ ...f, wcagLevel: v as any }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="A">Level A</SelectItem>
                  <SelectItem value="AA">Level AA</SelectItem>
                  <SelectItem value="AAA">Level AAA</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Max Pages</label>
              <Input
                type="number"
                min={1}
                max={500}
                value={form.maxPages}
                onChange={(e) => setForm((f) => ({ ...f, maxPages: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Max Depth</label>
              <Input
                type="number"
                min={1}
                max={10}
                value={form.maxDepth}
                onChange={(e) => setForm((f) => ({ ...f, maxDepth: Number(e.target.value) }))}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Concurrency</label>
              <Input
                type="number"
                min={1}
                max={5}
                value={form.concurrency}
                onChange={(e) => setForm((f) => ({ ...f, concurrency: Number(e.target.value) }))}
              />
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={mutation.isPending}>
            {mutation.isPending ? "Starting..." : "Start Audit"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
