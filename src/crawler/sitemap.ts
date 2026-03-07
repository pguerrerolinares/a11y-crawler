/**
 * Fetch and parse sitemap.xml URLs. Best-effort, non-blocking.
 */
export async function discoverSitemapUrls(baseUrl: string): Promise<string[]> {
  const urls: string[] = [];
  const sitemapPaths = ["/sitemap.xml", "/sitemap_index.xml"];

  for (const path of sitemapPaths) {
    try {
      const response = await fetch(new URL(path, baseUrl).href, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) continue;

      const xml = await response.text();

      // Check if this is a sitemap index (contains other sitemaps)
      const sitemapRefs = parseSitemapIndex(xml);
      if (sitemapRefs.length > 0) {
        for (const ref of sitemapRefs) {
          try {
            const subResponse = await fetch(ref, {
              signal: AbortSignal.timeout(10000),
            });
            if (!subResponse.ok) continue;
            const subXml = await subResponse.text();
            urls.push(...parseSitemapXml(subXml));
          } catch {
            // Best-effort
          }
        }
      } else {
        urls.push(...parseSitemapXml(xml));
      }
    } catch {
      // Best-effort
    }
  }

  return [...new Set(urls)];
}

/**
 * Parse sitemap XML and extract <loc> URLs.
 */
export function parseSitemapXml(xml: string): string[] {
  const urls: string[] = [];
  const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    if (match[1]) urls.push(match[1].trim());
  }
  return urls;
}

/**
 * Parse sitemap index XML and extract sub-sitemap URLs.
 */
function parseSitemapIndex(xml: string): string[] {
  if (!xml.includes("<sitemapindex")) return [];
  return parseSitemapXml(xml);
}
