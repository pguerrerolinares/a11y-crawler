export function simhash(text: string, bits = 64): bigint {
  const v = new Array(bits).fill(0);
  for (let i = 0; i < text.length - 2; i++) {
    const token = text.slice(i, i + 3);
    let h = 2166136261n;
    for (let j = 0; j < token.length; j++) {
      h ^= BigInt(token.charCodeAt(j));
      h = BigInt.asUintN(32, h * 16777619n);
    }
    const hash = h ^ (h << 32n);
    for (let b = 0; b < bits; b++) {
      v[b] += (hash >> BigInt(b)) & 1n ? 1 : -1;
    }
  }
  let fingerprint = 0n;
  for (let b = 0; b < bits; b++) {
    if (v[b] > 0) fingerprint |= 1n << BigInt(b);
  }
  return fingerprint;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let dist = 0;
  while (xor > 0n) {
    dist += Number(xor & 1n);
    xor >>= 1n;
  }
  return dist;
}

export function inferUrlPattern(url: string): string {
  const { pathname } = new URL(url);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  const parentSegments = segments.slice(0, -1);
  const lastSegment = segments[segments.length - 1];
  let normalizedLast: string;
  if (/^\d+$/.test(lastSegment)) normalizedLast = ":id";
  else if (/^[0-9a-f-]{36}$/.test(lastSegment)) normalizedLast = ":uuid";
  else if (/^[a-z0-9]+(-[a-z0-9]+){2,}$/.test(lastSegment)) normalizedLast = ":slug";
  else normalizedLast = lastSegment;
  return "/" + [...parentSegments, normalizedLast].join("/");
}

export const NODE_SIGNATURE_FN = `
function nodeSignature(el, depth) {
  if (depth > 6) return "";
  var tag = el.tagName.toLowerCase();
  var leafTags = new Set(["p","span","a","img","strong","em","br","input","button","label","li"]);
  var role = el.getAttribute("role") || "";
  var childCount = el.children.length;
  var sig = tag + "(" + (role ? "r=" + role + "," : "") + "n=" + childCount + ")";
  if (leafTags.has(tag) || depth >= 6) return sig;
  var children = Array.from(el.children)
    .map(function(c) { return nodeSignature(c, depth + 1); })
    .filter(Boolean).join("|");
  return children ? sig + "[" + children + "]" : sig;
}
`;
