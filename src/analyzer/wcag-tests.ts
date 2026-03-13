import type { Page } from "playwright";
import type { Issue, ImpactLevel } from "../types/issue";

function makeIssue(
  url: string,
  rule: string,
  impact: ImpactLevel,
  description: string,
  selector: string,
): Issue {
  return {
    id: crypto.randomUUID(),
    url,
    rule,
    impact,
    description,
    help: description,
    helpUrl: "",
    wcagTags: [],
    selector,
    html: "",
    surroundingHtml: "",
    xpath: "",
    viewportWidth: 0,
    pageTitle: "",
    checkSource: "wcag-custom",
    suggestedFix: null,
    fixConfidence: null,
    llmConfidence: null,
    wcagCriterion: null,
    violationCategory: "visual",
  };
}

/**
 * WCAG 1.4.10 — Reflow: content must be presentable at 320px width
 * without horizontal scrolling (exempt: TABLE, VIDEO, CANVAS, SVG, PRE, CODE).
 */
export async function testReflow(page: Page, url: string): Promise<Issue[]> {
  const originalViewport = page.viewportSize();
  const width = 320;
  const height = originalViewport?.height ?? 768;

  await page.setViewportSize({ width, height });
  // Allow reflow to settle
  await page.waitForTimeout(300);

  const overflowing = await page.evaluate((vpWidth: number) => {
    const exempt = new Set(["TABLE", "VIDEO", "CANVAS", "SVG", "PRE", "CODE"]);
    const tolerance = 2;
    const results: { selector: string; tagName: string; actualWidth: number }[] = [];

    const allElements = document.querySelectorAll("body *");
    for (const el of allElements) {
      if (exempt.has(el.tagName)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > vpWidth + tolerance) {
        const selector =
          el.id ? `#${el.id}` :
          el.className && typeof el.className === "string"
            ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).join(".")}`
            : el.tagName.toLowerCase();
        results.push({ selector, tagName: el.tagName, actualWidth: Math.round(rect.width) });
      }
    }
    return results;
  }, width);

  // Restore original viewport
  if (originalViewport) {
    await page.setViewportSize(originalViewport);
  }

  return overflowing.map((el) =>
    makeIssue(
      url,
      "reflow",
      "serious",
      `Element "${el.selector}" is ${el.actualWidth}px wide, exceeding 320px viewport (WCAG 1.4.10 Reflow)`,
      el.selector,
    ),
  );
}

/**
 * WCAG 1.4.12 — Text Spacing: content must not be clipped when text spacing is increased.
 */
export async function testTextSpacing(page: Page, url: string): Promise<Issue[]> {
  const clipped = await page.evaluate(() => {
    const style = document.createElement("style");
    style.id = "__wcag_text_spacing_test__";
    style.textContent = `
      * {
        line-height: 1.5 !important;
        letter-spacing: 0.12em !important;
        word-spacing: 0.16em !important;
      }
      p { margin-bottom: 2em !important; }
    `;
    document.head.appendChild(style);

    const tolerance = 2;
    const targets = document.querySelectorAll(
      "p, li, h1, h2, h3, h4, h5, h6, span, a, td, th, label, button",
    );
    const results: { selector: string }[] = [];

    for (const el of targets) {
      const computed = getComputedStyle(el);
      if (computed.overflow === "hidden") {
        const htmlEl = el as HTMLElement;
        if (htmlEl.scrollHeight > htmlEl.clientHeight + tolerance) {
          const selector =
            el.id ? `#${el.id}` :
            el.className && typeof el.className === "string"
              ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).join(".")}`
              : el.tagName.toLowerCase();
          results.push({ selector });
        }
      }
    }

    // Remove injected style
    style.remove();
    return results;
  });

  return clipped.map((el) =>
    makeIssue(
      url,
      "text-spacing",
      "serious",
      `Element "${el.selector}" clips content when text spacing is increased (WCAG 1.4.12 Text Spacing)`,
      el.selector,
    ),
  );
}

/**
 * WCAG 1.4.4 — Resize Text: content must be resizable up to 200% without loss of functionality.
 */
export async function testResizeText(page: Page, url: string): Promise<Issue[]> {
  const issues: Issue[] = [];

  // Check meta viewport restrictions
  const metaIssues = await page.evaluate(() => {
    const results: { type: string; content: string }[] = [];
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return results;

    const content = meta.getAttribute("content") ?? "";
    const lower = content.toLowerCase();

    if (/user-scalable\s*=\s*no/i.test(lower)) {
      results.push({ type: "user-scalable-no", content });
    }

    const maxScaleMatch = lower.match(/maximum-scale\s*=\s*([\d.]+)/);
    if (maxScaleMatch) {
      const maxScale = parseFloat(maxScaleMatch[1]);
      if (maxScale < 2) {
        results.push({ type: "max-scale-low", content });
      }
    }

    return results;
  });

  for (const meta of metaIssues) {
    if (meta.type === "user-scalable-no") {
      issues.push(
        makeIssue(
          url,
          "resize-text",
          "critical",
          `Meta viewport disables user scaling: "${meta.content}" (WCAG 1.4.4 Resize Text)`,
          'meta[name="viewport"]',
        ),
      );
    } else if (meta.type === "max-scale-low") {
      issues.push(
        makeIssue(
          url,
          "resize-text",
          "serious",
          `Meta viewport maximum-scale is less than 2: "${meta.content}" (WCAG 1.4.4 Resize Text)`,
          'meta[name="viewport"]',
        ),
      );
    }
  }

  // Simulate 200% zoom by halving viewport width
  const originalViewport = page.viewportSize();
  const currentWidth = originalViewport?.width ?? 1280;
  const height = originalViewport?.height ?? 768;
  const halfWidth = Math.round(currentWidth / 2);

  await page.setViewportSize({ width: halfWidth, height });
  await page.waitForTimeout(300);

  const hasOverflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });

  if (hasOverflow) {
    issues.push(
      makeIssue(
        url,
        "resize-text",
        "serious",
        `Page has horizontal overflow when viewport is halved to simulate 200% zoom (WCAG 1.4.4 Resize Text)`,
        "html",
      ),
    );
  }

  // Restore original viewport
  if (originalViewport) {
    await page.setViewportSize(originalViewport);
  }

  return issues;
}

/**
 * WCAG 1.2.1–1.2.5 — Multimedia: video/audio must have captions/alternatives.
 */
export async function testMultimedia(page: Page, url: string): Promise<Issue[]> {
  const findings = await page.evaluate(() => {
    const results: { type: string; selector: string }[] = [];

    // Video without captions
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      const hasCaptions = video.querySelector(
        'track[kind="captions"], track[kind="subtitles"]',
      );
      if (!hasCaptions) {
        const selector = video.id ? `#${video.id}` : "video";
        results.push({ type: "video-no-captions", selector });
      }
    }

    // Audio without captions
    const audios = document.querySelectorAll("audio");
    for (const audio of audios) {
      const hasCaptions = audio.querySelector(
        'track[kind="captions"], track[kind="subtitles"]',
      );
      if (!hasCaptions) {
        const selector = audio.id ? `#${audio.id}` : "audio";
        results.push({ type: "audio-no-captions", selector });
      }
    }

    // YouTube / Vimeo iframes
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      const src = iframe.getAttribute("src") ?? "";
      if (/youtube\.com|youtu\.be|vimeo\.com/i.test(src)) {
        const selector = iframe.id ? `#${iframe.id}` : `iframe[src*="${src.slice(0, 40)}"]`;
        results.push({ type: "embedded-video", selector });
      }
    }

    return results;
  });

  return findings.map((f) => {
    if (f.type === "video-no-captions") {
      return makeIssue(
        url,
        "multimedia",
        "serious",
        `Video element lacks captions or subtitles track (WCAG 1.2.1–1.2.5)`,
        f.selector,
      );
    } else if (f.type === "audio-no-captions") {
      return makeIssue(
        url,
        "multimedia",
        "serious",
        `Audio element lacks captions or subtitles track (WCAG 1.2.1–1.2.5)`,
        f.selector,
      );
    } else {
      return makeIssue(
        url,
        "multimedia",
        "moderate",
        `Embedded video (YouTube/Vimeo) detected — verify captions are enabled (WCAG 1.2.1–1.2.5)`,
        f.selector,
      );
    }
  });
}

/**
 * WCAG 2.2.1–2.2.2 — Timed Events: detect auto-refresh, marquee, autoplay, carousels.
 */
export async function testTimedEvents(page: Page, url: string): Promise<Issue[]> {
  const findings = await page.evaluate(() => {
    const results: { type: string; selector: string }[] = [];

    // Meta refresh
    const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
    if (metaRefresh) {
      results.push({ type: "meta-refresh", selector: 'meta[http-equiv="refresh"]' });
    }

    // Marquee
    const marquees = document.querySelectorAll("marquee");
    for (const m of marquees) {
      const selector = m.id ? `#${m.id}` : "marquee";
      results.push({ type: "marquee", selector });
    }

    // Autoplay video/audio
    const autoplayVideos = document.querySelectorAll("video[autoplay]");
    for (const v of autoplayVideos) {
      const selector = v.id ? `#${v.id}` : "video[autoplay]";
      results.push({ type: "autoplay-video", selector });
    }

    const autoplayAudios = document.querySelectorAll("audio[autoplay]");
    for (const a of autoplayAudios) {
      const selector = a.id ? `#${a.id}` : "audio[autoplay]";
      results.push({ type: "autoplay-audio", selector });
    }

    // Carousel patterns
    const carouselSelectors = [
      '[aria-roledescription="carousel"]',
      ".carousel",
      ".slider",
      '[data-ride="carousel"]',
    ];
    for (const cs of carouselSelectors) {
      const els = document.querySelectorAll(cs);
      for (const el of els) {
        const selector = el.id ? `#${el.id}` : cs;
        results.push({ type: "carousel", selector });
      }
    }

    return results;
  });

  return findings.map((f) => {
    switch (f.type) {
      case "meta-refresh":
        return makeIssue(
          url,
          "timed-events",
          "critical",
          `Page uses meta refresh which can disorient users (WCAG 2.2.1)`,
          f.selector,
        );
      case "marquee":
        return makeIssue(
          url,
          "timed-events",
          "serious",
          `Marquee element detected — moving content without pause control (WCAG 2.2.2)`,
          f.selector,
        );
      case "autoplay-video":
        return makeIssue(
          url,
          "timed-events",
          "serious",
          `Video with autoplay detected — may lack pause mechanism (WCAG 2.2.2)`,
          f.selector,
        );
      case "autoplay-audio":
        return makeIssue(
          url,
          "timed-events",
          "serious",
          `Audio with autoplay detected — may lack pause mechanism (WCAG 2.2.2)`,
          f.selector,
        );
      case "carousel":
        return makeIssue(
          url,
          "timed-events",
          "serious",
          `Carousel/slider detected — verify it has pause/stop controls (WCAG 2.2.2)`,
          f.selector,
        );
      default:
        return makeIssue(url, "timed-events", "serious", `Timed event detected`, f.selector);
    }
  });
}

/**
 * WCAG 2.5.8 — Target Size: interactive elements must have minimum 24×24px target area.
 * Supplements axe-core's target-size rule by catching inline links, custom role elements.
 */
export async function testTargetSize(page: Page, url: string): Promise<Issue[]> {
  const MIN_SIZE = 24;
  const INTERACTIVE_SELECTOR = [
    "a", "button", "input", "select", "textarea",
    '[role="button"]', '[role="link"]', '[role="checkbox"]',
    '[role="radio"]', '[role="tab"]', '[role="menuitem"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(", ");

  const undersized = await page.evaluate(
    ({ selector, minSize }: { selector: string; minSize: number }) => {
      const results: Array<{ selector: string; html: string; width: number; height: number }> = [];

      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        // Skip hidden elements
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.width < minSize || rect.height < minSize) {
          const css =
            el.id ? `#${el.id}` :
            el.className && typeof el.className === "string"
              ? `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/).join(".")}`
              : el.tagName.toLowerCase();
          results.push({
            selector: css,
            html: el.outerHTML.slice(0, 200),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }
      }
      return results;
    },
    { selector: INTERACTIVE_SELECTOR, minSize: MIN_SIZE },
  );

  return undersized.map((el) =>
    makeIssue(
      url,
      "target-size",
      "serious",
      `Interactive element "${el.selector}" is ${el.width}×${el.height}px, below minimum 24×24px (WCAG 2.5.8 Target Size)`,
      el.selector,
    ),
  );
}

/**
 * WCAG 3.3.1–3.3.3 — Error Identification: forms must provide accessible error messages
 * when submitted without filling required fields.
 *
 * Safety: skips payment/auth forms, detects navigation post-submit, never fills fields.
 */
export async function testErrorIdentification(page: Page, url: string): Promise<Issue[]> {
  const SKIP_ACTIONS = /payment|checkout|stripe|paypal|oauth|login|signin|signup|register|delete|unsubscribe|cancel|settings|account|admin/i;
  const issues: Issue[] = [];

  const forms = await page.$$("form");

  for (const form of forms) {
    // Safety: skip payment/auth forms
    const action = (await form.getAttribute("action")) ?? "";
    if (SKIP_ACTIONS.test(action)) continue;

    // Skip forms without required fields
    const requiredFields = await form.$$('[required], [aria-required="true"]');
    if (requiredFields.length === 0) continue;

    // Find submit button
    const submitBtn = await form.$('button[type="submit"], input[type="submit"], button:not([type])');
    if (!submitBtn) continue;

    // Snapshot URL to detect navigation
    const urlBefore = page.url();

    // Submit without filling fields
    await submitBtn.click();
    await page.waitForTimeout(500);

    // Detect navigation — go back immediately
    if (page.url() !== urlBefore) {
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      issues.push(
        makeIssue(
          url,
          "error-identification",
          "critical",
          `Form (action="${action || "self"}") navigates on empty submission without client-side validation (WCAG 3.3.1 Error Identification)`,
          `form[action="${action}"]`,
        ),
      );
      // If goBack failed, we're on the wrong page — stop processing forms
      if (page.url() !== urlBefore) break;
      continue;
    }

    // Check for accessible error indicators
    const hasAriaInvalid = await form.$$('[aria-invalid="true"]');
    const hasRoleAlert = await form.$$('[role="alert"]');
    const hasAriaDescribedby = await form.$$('[aria-invalid="true"][aria-describedby]');

    if (hasAriaInvalid.length === 0) {
      issues.push(
        makeIssue(
          url,
          "error-identification",
          "serious",
          `Form (action="${action || "self"}") does not set aria-invalid="true" on fields after empty submission (WCAG 3.3.1 Error Identification)`,
          `form[action="${action}"]`,
        ),
      );
    }

    if (hasRoleAlert.length === 0) {
      issues.push(
        makeIssue(
          url,
          "error-identification",
          "serious",
          `Form (action="${action || "self"}") does not announce errors via role="alert" after empty submission (WCAG 3.3.1 Error Identification)`,
          `form[action="${action}"]`,
        ),
      );
    }

    if (hasAriaInvalid.length > 0 && hasAriaDescribedby.length === 0) {
      issues.push(
        makeIssue(
          url,
          "error-identification",
          "moderate",
          `Form (action="${action || "self"}") sets aria-invalid but lacks aria-describedby to describe the error (WCAG 3.3.3 Error Suggestion)`,
          `form[action="${action}"]`,
        ),
      );
    }
  }

  return issues;
}
