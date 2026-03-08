export function statusColor(code: number): string {
  if (code < 300) return "bg-green-500/15 text-green-700 dark:text-green-400";
  if (code < 400) return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
  if (code < 500) return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400";
  return "bg-red-500/15 text-red-700 dark:text-red-400";
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
