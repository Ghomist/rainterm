import type { ITheme } from "@xterm/xterm";

export type Appearance = "dark" | "light";

export interface TermThemeDef {
  id: string;
  name: string;
  appearance: Appearance;
  /** UI accent color (buttons, focus, active states). */
  accent: string;
  theme: ITheme & { background: string; foreground: string };
}

type Palette = [string, string, string, string, string, string, string, string];

function def(
  id: string,
  name: string,
  appearance: Appearance,
  c: {
    bg: string;
    fg: string;
    cursor: string;
    selection: string;
    accent: string;
    normal: Palette;
    bright: Palette;
  },
): TermThemeDef {
  const [black, red, green, yellow, blue, magenta, cyan, white] = c.normal;
  const [bBlack, bRed, bGreen, bYellow, bBlue, bMagenta, bCyan, bWhite] = c.bright;
  const slider = appearance === "dark" ? "255, 255, 255" : "0, 0, 0";
  return {
    id,
    name,
    appearance,
    accent: c.accent,
    theme: {
      background: c.bg,
      foreground: c.fg,
      cursor: c.cursor,
      cursorAccent: c.bg,
      selectionBackground: c.selection,
      scrollbarSliderBackground: `rgba(${slider}, 0.10)`,
      scrollbarSliderHoverBackground: `rgba(${slider}, 0.18)`,
      scrollbarSliderActiveBackground: `rgba(${slider}, 0.24)`,
      black,
      red,
      green,
      yellow,
      blue,
      magenta,
      cyan,
      white,
      brightBlack: bBlack,
      brightRed: bRed,
      brightGreen: bGreen,
      brightYellow: bYellow,
      brightBlue: bBlue,
      brightMagenta: bMagenta,
      brightCyan: bCyan,
      brightWhite: bWhite,
    },
  };
}

export const THEMES: TermThemeDef[] = [
  // ---------------------------------------------------------------- dark
  def("rain", "Rain", "dark", {
    bg: "#17181c", fg: "#d6d9df", cursor: "#7cc4ff", selection: "rgba(124,196,255,0.28)", accent: "#7cc4ff",
    normal: ["#262830", "#f0717a", "#9fd283", "#e8c27a", "#6cb6ff", "#c99cf0", "#67d3d6", "#c8ccd4"],
    bright: ["#5c6370", "#ff8b93", "#b5e39a", "#f5d491", "#8ccaff", "#dab4ff", "#86e6e8", "#f0f2f5"],
  }),
  def("catppuccin-mocha", "Catppuccin Mocha", "dark", {
    bg: "#1e1e2e", fg: "#cdd6f4", cursor: "#f5e0dc", selection: "rgba(88,91,112,0.6)", accent: "#89b4fa",
    normal: ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de"],
    bright: ["#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"],
  }),
  def("catppuccin-macchiato", "Catppuccin Macchiato", "dark", {
    bg: "#24273a", fg: "#cad3f5", cursor: "#f4dbd6", selection: "rgba(91,96,120,0.6)", accent: "#8aadf4",
    normal: ["#494d64", "#ed8796", "#a6da95", "#eed49f", "#8aadf4", "#f5bde6", "#8bd5ca", "#b8c0e0"],
    bright: ["#5b6078", "#ed8796", "#a6da95", "#eed49f", "#8aadf4", "#f5bde6", "#8bd5ca", "#a5adcb"],
  }),
  def("catppuccin-frappe", "Catppuccin Frappé", "dark", {
    bg: "#303446", fg: "#c6d0f5", cursor: "#f2d5cf", selection: "rgba(98,104,128,0.6)", accent: "#8caaee",
    normal: ["#51576d", "#e78284", "#a6d189", "#e5c890", "#8caaee", "#f4b8e4", "#81c8be", "#b5bfe2"],
    bright: ["#626880", "#e78284", "#a6d189", "#e5c890", "#8caaee", "#f4b8e4", "#81c8be", "#a5adce"],
  }),
  def("one-dark", "One Dark", "dark", {
    bg: "#282c34", fg: "#abb2bf", cursor: "#528bff", selection: "rgba(62,68,81,0.9)", accent: "#61afef",
    normal: ["#3f4451", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf"],
    bright: ["#5c6370", "#e9969d", "#b3d39c", "#edd4a6", "#8fc6f4", "#d7a1e7", "#7bc6d0", "#dcdfe4"],
  }),
  def("nord", "Nord", "dark", {
    bg: "#2e3440", fg: "#d8dee9", cursor: "#d8dee9", selection: "rgba(67,76,94,0.9)", accent: "#88c0d0",
    normal: ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0"],
    bright: ["#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"],
  }),
  def("dracula", "Dracula", "dark", {
    bg: "#282a36", fg: "#f8f8f2", cursor: "#f8f8f2", selection: "rgba(68,71,90,0.9)", accent: "#bd93f9",
    normal: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2"],
    bright: ["#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"],
  }),
  def("tokyo-night", "Tokyo Night", "dark", {
    bg: "#1a1b26", fg: "#c0caf5", cursor: "#c0caf5", selection: "rgba(51,70,124,0.7)", accent: "#7aa2f7",
    normal: ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6"],
    bright: ["#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"],
  }),
  def("gruvbox-dark", "Gruvbox Dark", "dark", {
    bg: "#282828", fg: "#ebdbb2", cursor: "#ebdbb2", selection: "rgba(80,73,69,0.9)", accent: "#83a598",
    normal: ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984"],
    bright: ["#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"],
  }),
  def("solarized-dark", "Solarized Dark", "dark", {
    bg: "#002b36", fg: "#839496", cursor: "#93a1a1", selection: "rgba(7,54,66,0.95)", accent: "#268bd2",
    normal: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5"],
    bright: ["#586e75", "#cb4b16", "#859900", "#b58900", "#268bd2", "#6c71c4", "#2aa198", "#fdf6e3"],
  }),
  // ---------------------------------------------------------------- light
  def("rain-light", "Rain Light", "light", {
    bg: "#fbfbfc", fg: "#2b2f36", cursor: "#2f7de1", selection: "rgba(47,125,225,0.18)", accent: "#2f7de1",
    normal: ["#3b3f46", "#d7334a", "#2f8a3f", "#b07a00", "#2f7de1", "#9a4fd1", "#13878f", "#8a9099"],
    bright: ["#6b717b", "#e5536a", "#3fa152", "#c99100", "#4a92ef", "#ae6ae0", "#1fa2ab", "#b8bec7"],
  }),
  def("catppuccin-latte", "Catppuccin Latte", "light", {
    bg: "#eff1f5", fg: "#4c4f69", cursor: "#dc8a78", selection: "rgba(172,176,190,0.5)", accent: "#1e66f5",
    normal: ["#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be"],
    bright: ["#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc"],
  }),
  def("one-light", "Atom One Light", "light", {
    bg: "#fafafa", fg: "#383a42", cursor: "#526fff", selection: "rgba(229,229,230,0.95)", accent: "#4078f2",
    normal: ["#383a42", "#e45649", "#50a14f", "#c18401", "#4078f2", "#a626a4", "#0184bc", "#a0a1a7"],
    bright: ["#4f525e", "#e06c75", "#50a14f", "#c18401", "#4078f2", "#a626a4", "#0184bc", "#ffffff"],
  }),
  def("github-light", "GitHub Light", "light", {
    bg: "#ffffff", fg: "#1f2328", cursor: "#0969da", selection: "rgba(9,105,218,0.15)", accent: "#0969da",
    normal: ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781"],
    bright: ["#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"],
  }),
  def("gruvbox-light", "Gruvbox Light", "light", {
    bg: "#fbf1c7", fg: "#3c3836", cursor: "#3c3836", selection: "rgba(213,196,161,0.7)", accent: "#076678",
    normal: ["#fbf1c7", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64"],
    bright: ["#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836"],
  }),
  def("solarized-light", "Solarized Light", "light", {
    bg: "#fdf6e3", fg: "#657b83", cursor: "#586e75", selection: "rgba(238,232,213,0.95)", accent: "#268bd2",
    normal: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5"],
    bright: ["#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"],
  }),
];

export const themeById = (id: string) => THEMES.find((t) => t.id === id) ?? THEMES[0];

export const darkThemes = THEMES.filter((t) => t.appearance === "dark");
export const lightThemes = THEMES.filter((t) => t.appearance === "light");
