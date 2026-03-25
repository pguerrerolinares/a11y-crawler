# Sprinter: Speeding Up High-Fidelity Crawling of the Modern Web

> Source: NSDI 2024 (21st USENIX Symposium on Networked Systems Design and Implementation)
> Authors: Ayush Goel et al. (Princeton University)
> Paper: https://www.usenix.org/system/files/nsdi24-goel.pdf
> GitHub: https://github.com/goelayu/Sprinter
> Date reviewed: 2026-03-25

---

## 1. Problem

Browser-based crawling is needed for modern JS-heavy sites (SPAs, dynamic content), but it's ~10x slower than static crawling due to Chromium compute overhead (JS execution, rendering, layout).

The challenge: how to get browser-level fidelity at static-crawling speed.

## 2. Key Insight: Compute Memoization

Pages on the same site share most of their JS bundles, CSS, and layout logic. If you execute JS on one page with a browser, you can **reuse those computations** on similar pages without a browser.

This is the core innovation: **memoize browser computations and replay them statically**.

## 3. Four-Phase Architecture

```
Phase 1: Static crawl ALL pages (fetch HTML + JS links, no execution)
    → Builds set cover: which JS bundles are shared across pages

Phase 2: Browser crawl SUBSET (set cover representatives)
    → Execute JS in real browser
    → Log execution results in compute cache (shadow heap + shadow DOM)

Phase 3: Static crawl REMAINING pages (reuse cached computations)
    → Shadow heap: key-value map of JS heap properties
    → Shadow DOM: parsed HTML with same read/write APIs as browser DOM
    → For each page: apply cached JS execution results without browser

Phase 4: Browser crawl FAILURES (pages where memoization didn't match)
    → Only pages where static replay diverged from expected behavior
```

## 4. Technical Details

### Compute Cache
- Maintained per-site, not per-page
- Stores JS execution summaries (heap state, DOM mutations, network requests triggered)
- Cache lookup before executing any JS on a browser-crawled page
- Cache miss → execute + store; cache hit → skip execution

### Shadow Heap
- Key-value map from JS heap property paths to values
- Allows static evaluation of JS code that reads heap properties
- Example: `window.config.apiUrl` → cached value reused across pages

### Shadow DOM
- Constructed by parsing page HTML (no browser needed)
- Offers same APIs as browser DOM (querySelector, getAttribute, etc.)
- JS code that only reads/writes DOM can execute against shadow DOM

### Set Cover Optimization
- Phase 1 collects JS file sets per page
- Computes minimum subset of pages whose JS unions cover all unique JS files
- Only these pages need real browser execution (Phase 2)
- Typically 5-15% of total pages

## 5. Results

- **50,000 pages corpus**: 5x faster than browser-only crawling
- **Fidelity**: closely matches browser in resources fetched (>95% match)
- **Phase distribution**: ~80% of pages resolved statically (Phases 1+3), ~20% need browser (Phases 2+4)

## 6. Relevance for a11y-crawler-v2

### What we already do (validated by Sprinter)
- **Template clustering** = their set cover. We group pages by fingerprint, test representative only.
- **Style fingerprint caching** (cvdCache, viewportCache) = their compute memoization. We skip redundant work for same-CSS templates.
- **axeCache** = reusing scan-phase results in probe phase.

### What Sprinter suggests we could add

1. **Cross-audit memoization**: Sprinter caches within one crawl. We could cache across audits — if a page hasn't changed (same content hash), reuse ALL results from previous audit. Like git diff for audits.

2. **Element-level compute reuse**: Sprinter memoizes at page level. We could go deeper — if 10 buttons share the same CSS+role+tag fingerprint, interaction test 1 and amplify to the other 9. Same principle, finer granularity.

3. **Speculative static resolution**: Sprinter's Phase 1 (static crawl all pages) identifies what can skip the browser. We could do the same: `collectManifest` + fingerprint comparison to identify templates that don't need interaction testing (manifest identical to already-tested template).

4. **Phased pipeline**: Their 4-phase alternation (static→browser→static→browser) parallels our tier system (DOM→CSSOM→Interaction→Vision). Both escalate from cheap to expensive only when needed.

### Key difference from Sprinter
Sprinter optimizes **resource fetching** (which URLs to download). We optimize **accessibility testing** (which elements to interact with). The memoization principle is the same, but our "compute" is hover/focus/click/keyboard interaction + viewport mutation + screenshot comparison, not JS execution.

## 7. Related Papers Found During This Research

### STILE (Journal of Systems & Software, 2024)
- **What:** Dependency-aware parallelization of E2E test scripts
- **Key result:** -80% time vs sequential, -50% vs Selenium Grid
- **Relevance:** Confirms that identifying independent test phases and batching them is more effective than naive parallelism
- **Source:** https://www.sciencedirect.com/science/article/pii/S0164121224003480

### BUbiNG (arxiv, 2016)
- **What:** Massive-scale parallel crawler (40,600 pages/sec)
- **Relevance:** Limited — pure static crawling, no testing component
- **Source:** https://arxiv.org/pdf/1601.06919

### Multi-threaded web crawling model (arxiv, 2024)
- **What:** Divides crawl into sub-datasets per thread with buffer queue
- **Relevance:** The buffer queue pattern could apply to our template queue
- **Source:** https://arxiv.org/abs/2407.10440
