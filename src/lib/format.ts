/** Small display helpers shared across pages. */

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const shortId = (id: string): string => id.slice(0, 8);

export const SAFETY_LABEL: Record<string, string> = {
  additive: "additive",
  needs_care: "needs care",
  destructive: "destructive",
};
