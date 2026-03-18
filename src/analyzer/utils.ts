/**
 * Build a CSS selector for a DOM element, suitable for issue reporting.
 * Prefers #id > tag.class1.class2.class3 > tag
 * Max 3 classes to keep selectors readable.
 */
export function buildCssSelector(tagName: string, id: string, className: string): string {
  if (id) return `#${id}`;
  const tag = tagName.toLowerCase();
  if (className && typeof className === "string") {
    const classes = className.trim().split(/\s+/).slice(0, 3).join(".");
    if (classes) return `${tag}.${classes}`;
  }
  return tag;
}
