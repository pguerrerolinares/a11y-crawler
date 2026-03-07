export type RepresentationTier = "aria-snapshot" | "pruned-html" | "css-heuristic";

export interface PageRepresentation {
  tier: RepresentationTier;
  content: string;
  tokenEstimate: number;
  tierReason: string;
}

export interface NavTarget {
  selector: string;
  description: string;
  expectedBehavior: "navigate" | "expand" | "reveal";
  confidence: number;
}

export interface PageResult {
  url: string;
  title: string;
  issues: Issue[];
  groupedByRule: Record<string, Issue[]>;
  discoveredUrls: string[];
  discoveryMethods: Record<string, "link" | "sitemap" | "interaction">;
  representationTier: RepresentationTier;
  timestamp: string;
  processingMs: number;
}

import type { Issue } from "./issue.ts";
