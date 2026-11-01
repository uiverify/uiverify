/**
 * The shared SVG sprite, rendered once at the app root so `<use href="#id" />` resolves in the same
 * document. Inlining (rather than an external `/sprite.svg`) keeps product art working identically in
 * the app, Storybook, Vitest browser mode, and @uiverify/playwright archives - there is no external
 * resource to fetch or serialize. "p-*" are the soft-white product illustrations; "i-*" the UI icons
 * (stroke = currentColor). Contact shadows are solid low-alpha ellipses, never blur filters (blur
 * rasters non-deterministically and would flake visual diffs).
 */
export function Sprite() {
  return (
    <svg className="sprite" aria-hidden="true" focusable="false">
      {/* products */}
      <symbol id="p-mug" viewBox="0 0 120 120">
        <ellipse cx="60" cy="99" rx="33" ry="6.5" fill="#00000016" />
        <path d="M49 22c-4 5 4 8 0 13" stroke="#ffffffb0" strokeWidth="3.2" fill="none" strokeLinecap="round" />
        <path d="M64 18c-4 5 4 9 0 14" stroke="#ffffffb0" strokeWidth="3.2" fill="none" strokeLinecap="round" />
        <path d="M86 57a15 15 0 0 1 0 22" stroke="#eadfd0" strokeWidth="9" fill="none" strokeLinecap="round" />
        <path d="M33 49h54l-4 35a11 11 0 0 1-11 10H48a11 11 0 0 1-11-10z" fill="#fffdf9" />
        <path d="M33 49h54l-1 8H34z" fill="#f1e9dd" />
        <ellipse cx="60" cy="49" rx="27" ry="7" fill="#f4eee6" />
        <ellipse cx="60" cy="49" rx="20.5" ry="5" fill="#7a4f30" />
      </symbol>
      <symbol id="p-bottle" viewBox="0 0 120 120">
        <ellipse cx="60" cy="103" rx="24" ry="5.5" fill="#00000016" />
        <rect x="52" y="14" width="16" height="12" rx="3" fill="#e7ddcd" />
        <path d="M50 26h20c1 6 6 9 6 18v48a12 12 0 0 1-12 12H56a12 12 0 0 1-12-12V44c0-9 5-12 6-18z" fill="#fffdf9" />
        <path d="M44 52h32v24H44z" fill="#f4c04f" />
        <path d="M44 52h32v7H44z" fill="#f6cf76" />
        <rect x="50" y="60" width="9" height="9" rx="2" fill="#fffdf9" opacity="0.85" />
      </symbol>
      <symbol id="p-plant" viewBox="0 0 120 120">
        <ellipse cx="60" cy="103" rx="28" ry="6" fill="#00000016" />
        <path d="M60 62c0-16-9-26-22-30 3 16 9 25 22 30z" fill="#5cc98a" />
        <path d="M60 62c0-16 9-26 22-30-3 16-9 25-22 30z" fill="#49b978" />
        <path d="M60 66c-2-18 2-30 0-42-3 12-2 26 0 42z" fill="#63d197" />
        <path d="M42 66h36l-5 28a8 8 0 0 1-8 7H55a8 8 0 0 1-8-7z" fill="#fffdf9" />
        <path d="M40 60h40l-2 9H42z" fill="#efe7db" />
      </symbol>
      <symbol id="p-speaker" viewBox="0 0 120 120">
        <ellipse cx="60" cy="102" rx="26" ry="5.5" fill="#00000016" />
        <rect x="34" y="20" width="52" height="78" rx="16" fill="#fffdf9" />
        <rect x="34" y="20" width="52" height="78" rx="16" fill="#00000008" />
        <rect x="37" y="23" width="46" height="72" rx="14" fill="#fbf6ef" />
        <circle cx="60" cy="66" r="18" fill="#e9ddca" />
        <circle cx="60" cy="66" r="11" fill="#c98a5b" />
        <circle cx="60" cy="66" r="4.5" fill="#7c4a2c" />
        <circle cx="60" cy="40" r="6" fill="#e9ddca" />
      </symbol>
      <symbol id="p-tote" viewBox="0 0 120 120">
        <ellipse cx="60" cy="103" rx="30" ry="6" fill="#00000016" />
        <path d="M45 36a15 15 0 0 1 30 0" fill="none" stroke="#e7ddcd" strokeWidth="6" strokeLinecap="round" />
        <path d="M34 40h52l6 50a8 8 0 0 1-8 9H36a8 8 0 0 1-8-9z" fill="#fffdf9" />
        <path d="M34 40h52l1 9H33z" fill="#efe7db" />
        <path d="M52 40v9M68 40v9" stroke="#e2d8c8" strokeWidth="4" strokeLinecap="round" />
        <rect x="49" y="66" width="22" height="8" rx="4" fill="#f4c04f" />
      </symbol>
      <symbol id="p-lamp" viewBox="0 0 120 120">
        <ellipse cx="60" cy="103" rx="26" ry="5.5" fill="#00000016" />
        <path d="M46 100h28l-4-10H50z" fill="#e7ddcd" />
        <rect x="41" y="98" width="38" height="6" rx="3" fill="#efe7db" />
        <rect x="56.5" y="50" width="7" height="42" rx="3.5" fill="#e7ddcd" />
        <path d="M38 50h44L71 22H49z" fill="#fffdf9" />
        <path d="M40 44h40l2 6H38z" fill="#f7cf72" />
        <ellipse cx="60" cy="22" rx="11" ry="3" fill="#f4eee6" />
      </symbol>
      <symbol id="p-headphones" viewBox="0 0 120 120">
        <ellipse cx="60" cy="103" rx="30" ry="6" fill="#00000016" />
        <path d="M28 74V62a32 32 0 0 1 64 0v12" fill="none" stroke="#fffdf9" strokeWidth="10" strokeLinecap="round" />
        <rect x="22" y="66" width="20" height="34" rx="9" fill="#fffdf9" />
        <rect x="78" y="66" width="20" height="34" rx="9" fill="#fffdf9" />
        <rect x="26" y="70" width="12" height="26" rx="6" fill="#f4c04f" />
        <rect x="82" y="70" width="12" height="26" rx="6" fill="#f4c04f" />
      </symbol>
      <symbol id="p-candle" viewBox="0 0 120 120">
        <ellipse cx="60" cy="103" rx="24" ry="5.5" fill="#00000016" />
        <path d="M60 24c6 7 10 12 10 18a10 10 0 0 1-20 0c0-6 4-11 10-18z" fill="#f7b733" />
        <path d="M60 34c3 4 5 7 5 11a5 5 0 0 1-10 0c0-4 2-7 5-11z" fill="#fff1c2" />
        <rect x="40" y="58" width="40" height="44" rx="9" fill="#fffdf9" />
        <rect x="40" y="58" width="40" height="12" rx="9" fill="#f4eee6" />
        <path d="M60 52v6" stroke="#5a4632" strokeWidth="3" strokeLinecap="round" />
      </symbol>

      {/* ui icons (stroke = currentColor, 24-grid, lucide-style) */}
      <symbol id="i-bag" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
        <path d="M3 6h18" />
        <path d="M16 10a4 4 0 0 1-8 0" />
      </symbol>
      <symbol id="i-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </symbol>
      <symbol id="i-cart" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="21" r="1" />
        <circle cx="19" cy="21" r="1" />
        <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
      </symbol>
      <symbol id="i-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.49 4.04 3 5.5l7 7Z" />
      </symbol>
      <symbol id="i-star" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <path d="M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.9 6.19 20.9l1.11-6.47L2.6 9.85l6.5-.95z" />
      </symbol>
      <symbol id="i-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></symbol>
      <symbol id="i-minus" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14" /></symbol>
      <symbol id="i-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></symbol>
      <symbol id="i-arrow-ul" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M8 7h9v9" /></symbol>
      <symbol id="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></symbol>
      <symbol id="i-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></symbol>
      <symbol id="i-truck" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 18V6a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h1" /><path d="M14 9h4l3 3v5a1 1 0 0 1-1 1h-1" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></symbol>
      <symbol id="i-refresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></symbol>
      <symbol id="i-shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></symbol>
      <symbol id="i-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></symbol>
      <symbol id="i-sparkle" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l1.9 5.6L19.5 9.5 13.9 11.4 12 17l-1.9-5.6L4.5 9.5l5.6-1.9z" /></symbol>
    </svg>
  );
}
