/** DESKTOP | PHONE (user_sessions.device_type); tablets count as PHONE, the closest icon. */
export type DeviceType = 'DESKTOP' | 'PHONE';

export interface DeviceDescription {
  /** "Chrome on Windows", "Safari on iPhone". */
  label: string;
  deviceType: DeviceType;
}

// Order matters: Edge and Opera also say "Chrome", Chrome also says "Safari".
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
  [/\b(?:iPhone|iPad).*AppleWebKit/, 'Safari'],
];

const SYSTEMS: [RegExp, string, DeviceType][] = [
  [/\biPhone\b/, 'iPhone', 'PHONE'],
  [/\biPad\b/, 'iPad', 'PHONE'],
  [/\bAndroid\b/, 'Android', 'PHONE'],
  [/\bWindows\b/, 'Windows', 'DESKTOP'],
  [/\bCrOS\b/, 'ChromeOS', 'DESKTOP'],
  [/\bMac OS X\b|\bMacintosh\b/, 'Mac', 'DESKTOP'],
  [/\bLinux\b/, 'Linux', 'DESKTOP'],
];

/**
 * A readable name for the device a session signed in from. Deliberately small:
 * the big browsers and systems by their User-Agent tokens; anything else is
 * "Unknown browser" / "Unknown device".
 */
export function describeDevice(userAgent: string | null | undefined): DeviceDescription {
  const ua = (userAgent ?? '').slice(0, 512);
  if (!ua.trim()) return { label: 'Unknown device', deviceType: 'DESKTOP' };
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(ua));
  // Android phones say "Mobile"; Android tablets don't, but PHONE is still the closer icon.
  const deviceType: DeviceType = system?.[2] ?? (/\bMobile\b/.test(ua) ? 'PHONE' : 'DESKTOP');
  if (!browser && !system) return { label: 'Unknown device', deviceType };
  return { label: `${browser ?? 'Unknown browser'} on ${system?.[1] ?? 'unknown device'}`, deviceType };
}
