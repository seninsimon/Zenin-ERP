// A tab left open across an update (or a restart of the dev server) can ask
// for code files that no longer exist, or mix old and new ones, the first
// time it opens a page whose code loads on demand (the Spreadsheet view,
// settings pages). The fix is a fresh load, so Zenin does that by itself,
// once. If it fails again within a minute, the error screen shows as usual,
// so a real bug never turns into endless reloading.

const KEY = "zenin.reloadedForUpdate";

// "couldn't load this page's code", or the crash that two copies of React cause
const STALE = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Loading (CSS )?chunk .* failed/i,
  /Outdated Optimize Dep/i,
  /Invalid hook call/i,
  /reading '(useState|useContext|useRef|useMemo|useEffect)'/i,
];

export const isStaleCodeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return STALE.some((re) => re.test(message));
};

// Reloads the page unless it already did so in the last minute. Returns
// whether it's reloading.
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false; // no storage (private mode): show the error screen instead
  }
  window.location.reload();
  return true;
}
