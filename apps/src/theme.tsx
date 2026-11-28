// The views' theme: @squonk/ui with the Vine Context brand, in the host's
// colour mode. Inside an MCP Apps host the page colours (background, text,
// borders) come from the host, so a view sits in the chat as if it belonged
// there; everything else (type, controls, tones, spacing) is @squonk/ui's.
// In a plain browser tab (`vine ui`, `vine demo`) it follows the system.

import "@squonk/ui/styles.css";
import "./base.css";
import "./fonts.css";
import { SquonkThemeProvider } from "@squonk/ui/theme-provider";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

/** The part of an MCP Apps host context the theme reads. */
export interface HostLook {
  theme?: "light" | "dark";
  styles?: { variables?: Record<string, string | undefined> };
}

let host: HostLook = {};
const listeners = new Set<() => void>();

/** Called by the bridge whenever the host sends or changes its context. */
export function setHostLook(ctx: HostLook | undefined) {
  if (!ctx) return;
  host = { theme: ctx.theme ?? host.theme, styles: ctx.styles ?? host.styles };
  for (const f of listeners) f();
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

function useSystemDark(): boolean {
  const q = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
  const [dark, setDark] = useState(!!q?.matches);
  useEffect(() => {
    if (!q) return;
    const on = () => setDark(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, [q]);
  return dark;
}

/** Vine green: the leaf of the mark. */
const BRAND = {
  light: { primary: "#1f7a46", primaryGradientStart: "#2f9a5c" },
  dark: { primary: "#7fd39d", primaryGradientStart: "#5fbf86" },
};

// Host style variable → @squonk/ui colour primitive.
const HOST_COLOURS: [string, keyof typeof BRAND.light | string][] = [
  ["--color-background-primary", "backgroundDefault"],
  ["--color-background-primary", "backgroundSurface"],
  ["--color-background-secondary", "backgroundSubtle"],
  ["--color-text-primary", "textPrimary"],
  ["--color-text-secondary", "textSecondary"],
  ["--color-text-tertiary", "textMuted"],
  ["--color-border-secondary", "borderDefault"],
  ["--color-border-primary", "borderStrong"],
];

const PLAIN_COLOUR = /^(#[0-9a-f]{3,8}|rgba?\([^()]*\)|hsla?\([^()]*\))$/i;

/** A host value for one mode: plain colours, or one side of `light-dark(a, b)`. */
function pick(value: string | undefined, dark: boolean): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const ld = /^light-dark\(\s*(.+?)\s*,\s*(.+?)\s*\)$/i.exec(v);
  const one = ld ? (dark ? ld[2] : ld[1]) : v;
  return one && PLAIN_COLOUR.test(one) ? one : undefined;
}

export function VineTheme({ children }: { children: ReactNode }) {
  const look = useSyncExternalStore(subscribe, () => host);
  const systemDark = useSystemDark();
  const dark = look.theme ? look.theme === "dark" : systemDark;

  const fromHost: Record<string, string> = {};
  for (const [name, key] of HOST_COLOURS) {
    const c = pick(look.styles?.variables?.[name], dark);
    if (c) fromHost[key] = c;
  }
  const colours = { ...(dark ? BRAND.dark : BRAND.light), ...fromHost };

  return (
    <SquonkThemeProvider
      mode={dark ? "dark" : "light"}
      withGlobalStyles
      primitives={{
        [dark ? "darkColors" : "colors"]: colours,
        deriveFromPrimary: true,
        neutralTint: 0.15,
        indicatorStyle: "underline",
      }}
    >
      {children}
    </SquonkThemeProvider>
  );
}
