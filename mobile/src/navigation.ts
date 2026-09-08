/** Accept every scheme here so WebView calls our gate instead of opening it in the OS. */
export const WEBVIEW_ORIGIN_WHITELIST = ["*"];
const EMBEDDED_WEBAPP_ROOT = "/android_asset/webapp/";

export function webappOrigin(url: string, development: boolean): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && !(development && parsed.protocol === "http:")) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isTrustedWebUrl(url: string, allowedOrigin: string | null): boolean {
  return allowedOrigin !== null && webappOrigin(url, true) === allowedOrigin;
}

export function isTrustedEmbeddedWebUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const prefix = `file://${EMBEDDED_WEBAPP_ROOT}`;
  if (!url.startsWith(prefix)) return false;

  // React Native's URL implementation does not parse Android asset URLs the
  // same way as browsers. Validate the fixed origin and normalized path here.
  const encodedPath = url.slice(prefix.length).split(/[?#]/, 1)[0] ?? "";
  let path: string;
  try {
    path = decodeURIComponent(encodedPath);
  } catch {
    return false;
  }
  if (path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment !== "." && segment !== "..");
}

export function isTrustedEmbeddedWebMessageUrl(url: unknown): boolean {
  // Android WebMessageListener serializes the opaque origin of a packaged
  // file document as the string "null"; older paths can omit the value.
  // This gate is used only by the embedded build. Navigation remains
  // independently restricted to the exact packaged asset tree.
  return url === "null" || url === null || url === undefined || url === "" || isTrustedEmbeddedWebUrl(url);
}
