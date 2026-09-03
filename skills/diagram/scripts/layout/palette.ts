import type { Palette, Role } from "./spec.ts";

export interface Ink {
  stroke: string;
  fill: string;
  dashed: boolean;
}

export interface Theme {
  roles: Record<Role, Ink>;
  title: string;
  zoneTitle: string;
  zoneStroke: string;
  label: string;
  note: string;
  edgeLabel: string;
}

/** Both tables are the house palettes from references/elements.md, unaltered. */
const DARK: Theme = {
  roles: {
    neutral: { stroke: "#eeeeee", fill: "#1b1d22", dashed: false },
    start: { stroke: "#f5a742", fill: "#2a2410", dashed: false },
    success: { stroke: "#79a8e7", fill: "#152438", dashed: false },
    decision: { stroke: "#f5a742", fill: "transparent", dashed: false },
    agent: { stroke: "#b197fc", fill: "#1d1636", dashed: false },
    inactive: { stroke: "#9aa0aa", fill: "transparent", dashed: true },
    error: { stroke: "#e06c75", fill: "#2a1512", dashed: false },
    evidence: { stroke: "#2a2d34", fill: "#0a0a0c", dashed: false },
  },
  title: "#eeeeee",
  zoneTitle: "#eeeeee",
  zoneStroke: "#9aa0aa",
  label: "#eeeeee",
  note: "#9aa0aa",
  edgeLabel: "#9aa0aa",
};

const LIGHT: Theme = {
  roles: {
    neutral: { stroke: "#1e1e1e", fill: "#a5d8ff", dashed: false },
    start: { stroke: "#1e1e1e", fill: "#fed7aa", dashed: false },
    success: { stroke: "#1e1e1e", fill: "#b2f2bb", dashed: false },
    decision: { stroke: "#1e1e1e", fill: "#ffec99", dashed: false },
    agent: { stroke: "#1e1e1e", fill: "#ddd6fe", dashed: false },
    inactive: { stroke: "#748ffc", fill: "transparent", dashed: true },
    error: { stroke: "#1e1e1e", fill: "#ffc9c9", dashed: false },
    evidence: { stroke: "#1e293b", fill: "#1e293b", dashed: false },
  },
  title: "#1e40af",
  zoneTitle: "#1e40af",
  zoneStroke: "#64748b",
  label: "#1e1e1e",
  note: "#64748b",
  edgeLabel: "#64748b",
};

export function theme(palette: Palette): Theme {
  return palette === "dark" ? DARK : LIGHT;
}

/** Evidence panels carry light ink so their label stays legible on the dark plate. */
export function labelInk(t: Theme, role: Role): string {
  return role === "evidence" ? "#eeeeee" : t.label;
}
