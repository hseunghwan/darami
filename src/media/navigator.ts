/**
 * exifr reads `navigator.userAgent.includes(...)` while it loads whenever `navigator` is an object.
 * React Native has a navigator without a userAgent, so the import threw on Hermes. An empty string
 * keeps exifr off its iPad and iPhone canvas paths, which only matter in a browser.
 */

const nav = (globalThis as { navigator?: { userAgent?: unknown } }).navigator;
if (typeof nav === 'object' && nav !== null && typeof nav.userAgent !== 'string') {
  Object.defineProperty(nav, 'userAgent', { value: '', configurable: true });
}
