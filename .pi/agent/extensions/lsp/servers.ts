/**
 * Per-language LSP server registry. Subset of opencode's
 * ~/opencode/packages/opencode/src/lsp/server.ts adapted for Pi.
 *
 * Each entry describes:
 *   - id: stable identifier used to cache spawned processes
 *   - languageIds: which document-language-ids this server handles
 *   - rootMarkers: filenames whose presence (walking up from the file)
 *                  identifies the workspace root for this server
 *   - which/command/args: how to look up + spawn the server (must speak LSP on stdio)
 *   - install: how to auto-install when binary is missing (see install.ts)
 *   - initializationOptions: LSP initializationOptions to send on init
 *   - indexWaitMs: how long to wait after `initialized` before the first
 *                  request (rust-analyzer/gopls need cargo/go.mod indexing)
 */

import type { InstallSpec } from "./install.ts";

export interface ServerConfig {
  id: string;
  languageIds: string[];
  rootMarkers: string[];
  which: string;
  command: string;
  args: string[];
  install?: InstallSpec;
  indexWaitMs?: number;
  initializationOptions?: Record<string, unknown>;
}

export const SERVERS: ServerConfig[] = [
  // ── TypeScript / JavaScript ────────────────────────────────────────────
  {
    id: "deno",
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    rootMarkers: ["deno.json", "deno.jsonc"],
    which: "deno",
    command: "deno",
    args: ["lsp"],
    install: { type: "manual", hint: "Install deno: https://deno.land/manual/getting_started/installation" },
    indexWaitMs: 1000,
  },
  {
    id: "typescript",
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
    which: "typescript-language-server",
    command: "typescript-language-server",
    args: ["--stdio"],
    install: { type: "bun-global", pkg: "typescript-language-server typescript" },
    indexWaitMs: 2000,
    initializationOptions: {
      preferences: { includeInlayParameterNameHints: "none" },
    },
  },

  // ── Python ─────────────────────────────────────────────────────────────
  {
    id: "pyright",
    languageIds: ["python"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "pyrightconfig.json", ".git"],
    which: "pyright-langserver",
    command: "pyright-langserver",
    args: ["--stdio"],
    install: { type: "bun-global", pkg: "pyright" },
    indexWaitMs: 1500,
  },
  {
    id: "pylsp",
    languageIds: ["python"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", ".git"],
    which: "pylsp",
    command: "pylsp",
    args: [],
    install: { type: "manual", hint: "pip install python-lsp-server" },
    indexWaitMs: 1500,
  },

  // ── Rust ───────────────────────────────────────────────────────────────
  {
    id: "rust-analyzer",
    languageIds: ["rust"],
    rootMarkers: ["Cargo.toml", "Cargo.lock", ".git"],
    which: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    install: { type: "rustup-component", component: "rust-analyzer" },
    indexWaitMs: 10_000,
  },

  // ── Go ─────────────────────────────────────────────────────────────────
  {
    id: "gopls",
    languageIds: ["go"],
    rootMarkers: ["go.mod", "go.work", ".git"],
    which: "gopls",
    command: "gopls",
    args: ["serve"],
    install: { type: "go-install", module: "golang.org/x/tools/gopls@latest" },
    indexWaitMs: 3000,
  },

  // ── C / C++ ────────────────────────────────────────────────────────────
  {
    id: "clangd",
    languageIds: ["c", "cpp"],
    rootMarkers: ["compile_commands.json", "CMakeLists.txt", "Makefile", ".git"],
    which: "clangd",
    command: "clangd",
    args: [],
    install: { type: "manual", hint: "Install clangd via your distro (e.g. sudo pacman -S clang)" },
    indexWaitMs: 2000,
  },

  // ── Lua ────────────────────────────────────────────────────────────────
  {
    id: "lua-language-server",
    languageIds: ["lua"],
    rootMarkers: [".luarc.json", ".luarc.jsonc", "stylua.toml", ".git"],
    which: "lua-language-server",
    command: "lua-language-server",
    args: [],
    install: { type: "manual", hint: "In nvim: :MasonInstall lua-language-server (Mason bin dir is on PATH), or your distro package" },
    indexWaitMs: 1000,
  },

  // ── Bash ───────────────────────────────────────────────────────────────
  {
    id: "bash-language-server",
    languageIds: ["shellscript"],
    rootMarkers: [".git"],
    which: "bash-language-server",
    command: "bash-language-server",
    args: ["start"],
    install: { type: "bun-global", pkg: "bash-language-server" },
    indexWaitMs: 500,
  },

  // ── JSON / YAML / TOML / CSS / HTML (vscode-langservers-extracted bundle) ─
  {
    id: "vscode-json-language-server",
    languageIds: ["json", "jsonc"],
    rootMarkers: [".git", "package.json"],
    which: "vscode-json-language-server",
    command: "vscode-json-language-server",
    args: ["--stdio"],
    install: { type: "bun-global", pkg: "vscode-langservers-extracted" },
    indexWaitMs: 500,
  },
  {
    id: "yaml-language-server",
    languageIds: ["yaml"],
    rootMarkers: [".git"],
    which: "yaml-language-server",
    command: "yaml-language-server",
    args: ["--stdio"],
    install: { type: "bun-global", pkg: "yaml-language-server" },
    indexWaitMs: 500,
  },
  {
    id: "taplo",
    languageIds: ["toml"],
    rootMarkers: [".git"],
    which: "taplo",
    command: "taplo",
    args: ["lsp", "stdio"],
    install: { type: "cargo-install", crate: "taplo-cli", features: ["lsp"] },
    indexWaitMs: 500,
  },
  {
    id: "vscode-css-language-server",
    languageIds: ["css", "scss", "less"],
    rootMarkers: [".git", "package.json"],
    which: "vscode-css-language-server",
    command: "vscode-css-language-server",
    args: ["--stdio"],
    install: { type: "bun-global", pkg: "vscode-langservers-extracted" },
    indexWaitMs: 500,
  },
  {
    id: "vscode-html-language-server",
    languageIds: ["html"],
    rootMarkers: [".git", "package.json"],
    which: "vscode-html-language-server",
    command: "vscode-html-language-server",
    args: ["--stdio"],
    install: { type: "bun-global", pkg: "vscode-langservers-extracted" },
    indexWaitMs: 500,
  },

  // ── Terraform / HCL ────────────────────────────────────────────────────
  {
    id: "terraform-ls",
    languageIds: ["terraform", "terraform-vars", "hcl"],
    rootMarkers: [".terraform", "main.tf", ".git"],
    which: "terraform-ls",
    command: "terraform-ls",
    args: ["serve"],
    install: { type: "manual", hint: "In nvim: :MasonInstall terraform-ls (Mason bin dir is on PATH), or https://github.com/hashicorp/terraform-ls/releases" },
    indexWaitMs: 1000,
  },

  // ── Astro ──────────────────────────────────────────────────────────────
  // astro-ls needs a TypeScript SDK path; the project's own node_modules is
  // preferred by editors, but the table is static, so point at the bun-global
  // typescript that typescript-language-server already depends on.
  {
    id: "astro",
    languageIds: ["astro"],
    rootMarkers: ["astro.config.mjs", "astro.config.ts", "astro.config.js", "package.json", ".git"],
    which: "astro-ls",
    command: "astro-ls",
    args: ["--stdio"],
    install: { type: "bun-global", pkg: "@astrojs/language-server" },
    indexWaitMs: 2000,
    initializationOptions: {
      typescript: { tsdk: `${process.env.HOME ?? ""}/.bun/install/global/node_modules/typescript/lib` },
    },
  },

  // ── Markdown ───────────────────────────────────────────────────────────
  // Same server nvim runs (markdown_oxide). Mason installs it; the Mason bin
  // dir is on PATH via .zshrc.
  {
    id: "markdown-oxide",
    languageIds: ["markdown"],
    rootMarkers: [".git"],
    which: "markdown-oxide",
    command: "markdown-oxide",
    args: [],
    install: { type: "manual", hint: "In nvim: :MasonInstall markdown-oxide (Mason bin dir is on PATH)" },
    indexWaitMs: 1000,
  },

  // ── Dockerfile ─────────────────────────────────────────────────────────
  {
    id: "dockerfile-language-server",
    languageIds: ["dockerfile"],
    rootMarkers: [".git"],
    which: "docker-langserver",
    command: "docker-langserver",
    args: ["--stdio"],
    install: { type: "bun-global", pkg: "dockerfile-language-server-nodejs" },
    indexWaitMs: 500,
  },

  // ── SQL ────────────────────────────────────────────────────────────────
  // sqlls, as in nvim. Its parser chokes on Postgres-specific syntax and
  // reports diagnostics we ignore anyway; symbols and references still work.
  {
    id: "sql-language-server",
    languageIds: ["sql"],
    rootMarkers: [".sqllsrc.json", ".git"],
    which: "sql-language-server",
    command: "sql-language-server",
    args: ["up", "--method", "stdio"],
    install: { type: "bun-global", pkg: "sql-language-server" },
    indexWaitMs: 500,
  },

  // ── GraphQL ────────────────────────────────────────────────────────────
  {
    id: "graphql",
    languageIds: ["graphql"],
    rootMarkers: [".graphqlrc", ".graphqlrc.yml", ".graphqlrc.yaml", ".graphqlrc.json", ".graphqlrc.ts", "graphql.config.ts", "package.json", ".git"],
    which: "graphql-lsp",
    command: "graphql-lsp",
    args: ["server", "-m", "stream"],
    install: { type: "bun-global", pkg: "graphql-language-service-cli" },
    indexWaitMs: 1000,
  },

  // ── Nix ────────────────────────────────────────────────────────────────
  {
    id: "nixd",
    languageIds: ["nix"],
    rootMarkers: ["flake.nix", "default.nix", ".git"],
    which: "nixd",
    command: "nixd",
    args: [],
    install: { type: "manual", hint: "nix-env -iA nixpkgs.nixd" },
    indexWaitMs: 1000,
  },
];

export function candidatesFor(languageId: string): ServerConfig[] {
  return SERVERS.filter((s) => s.languageIds.includes(languageId));
}
