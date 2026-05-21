/**
 * Per-language LSP server registry. Subset of opencode's
 * ~/opencode/packages/opencode/src/lsp/server.ts adapted for Pi.
 *
 * Each entry describes:
 *   - id: stable identifier used to cache spawned processes
 *   - languageIds: which document-language-ids this server handles
 *   - rootMarkers: filenames whose presence (walking up from the file)
 *                  identifies the workspace root for this server
 *   - command + args: how to spawn the server (must speak LSP on stdio)
 *   - which: name of the executable to look up via PATH; if absent the
 *            server is disabled and the lsp tool returns an "install X"
 *            hint instead of trying to spawn.
 *   - initializationOptions: LSP initializationOptions to send on init
 */

export interface ServerConfig {
  id: string;
  languageIds: string[];
  rootMarkers: string[];
  which: string;
  command: string;
  args: string[];
  initializationOptions?: Record<string, unknown>;
}

export const SERVERS: ServerConfig[] = [
  // ── TypeScript / JavaScript ────────────────────────────────────────────
  {
    id: "typescript",
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
    which: "typescript-language-server",
    command: "typescript-language-server",
    args: ["--stdio"],
    initializationOptions: {
      preferences: { includeInlayParameterNameHints: "none" },
    },
  },
  // Fallback to deno's LSP if you're in a deno project (deno.json present)
  {
    id: "deno",
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    rootMarkers: ["deno.json", "deno.jsonc"],
    which: "deno",
    command: "deno",
    args: ["lsp"],
  },

  // ── Python ─────────────────────────────────────────────────────────────
  {
    id: "pyright",
    languageIds: ["python"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "pyrightconfig.json", ".git"],
    which: "pyright-langserver",
    command: "pyright-langserver",
    args: ["--stdio"],
  },
  // Fallback to pylsp if pyright isn't installed
  {
    id: "pylsp",
    languageIds: ["python"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", ".git"],
    which: "pylsp",
    command: "pylsp",
    args: [],
  },

  // ── Rust ───────────────────────────────────────────────────────────────
  {
    id: "rust-analyzer",
    languageIds: ["rust"],
    rootMarkers: ["Cargo.toml", "Cargo.lock", ".git"],
    which: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
  },

  // ── Go ─────────────────────────────────────────────────────────────────
  {
    id: "gopls",
    languageIds: ["go"],
    rootMarkers: ["go.mod", "go.work", ".git"],
    which: "gopls",
    command: "gopls",
    args: ["serve"],
  },

  // ── C / C++ ────────────────────────────────────────────────────────────
  {
    id: "clangd",
    languageIds: ["c", "cpp"],
    rootMarkers: ["compile_commands.json", "CMakeLists.txt", "Makefile", ".git"],
    which: "clangd",
    command: "clangd",
    args: [],
  },

  // ── Lua ────────────────────────────────────────────────────────────────
  {
    id: "lua-language-server",
    languageIds: ["lua"],
    rootMarkers: [".luarc.json", ".luarc.jsonc", "stylua.toml", ".git"],
    which: "lua-language-server",
    command: "lua-language-server",
    args: [],
  },

  // ── Bash ───────────────────────────────────────────────────────────────
  {
    id: "bash-language-server",
    languageIds: ["shellscript"],
    rootMarkers: [".git"],
    which: "bash-language-server",
    command: "bash-language-server",
    args: ["start"],
  },

  // ── JSON / YAML / TOML ─────────────────────────────────────────────────
  {
    id: "vscode-json-language-server",
    languageIds: ["json", "jsonc"],
    rootMarkers: [".git", "package.json"],
    which: "vscode-json-language-server",
    command: "vscode-json-language-server",
    args: ["--stdio"],
  },
  {
    id: "yaml-language-server",
    languageIds: ["yaml"],
    rootMarkers: [".git"],
    which: "yaml-language-server",
    command: "yaml-language-server",
    args: ["--stdio"],
  },
  {
    id: "taplo",
    languageIds: ["toml"],
    rootMarkers: [".git"],
    which: "taplo",
    command: "taplo",
    args: ["lsp", "stdio"],
  },

  // ── Terraform / HCL ────────────────────────────────────────────────────
  {
    id: "terraform-ls",
    languageIds: ["terraform", "terraform-vars", "hcl"],
    rootMarkers: [".terraform", "main.tf", ".git"],
    which: "terraform-ls",
    command: "terraform-ls",
    args: ["serve"],
  },

  // ── Nix ────────────────────────────────────────────────────────────────
  {
    id: "nixd",
    languageIds: ["nix"],
    rootMarkers: ["flake.nix", "default.nix", ".git"],
    which: "nixd",
    command: "nixd",
    args: [],
  },
];

/**
 * Find the best server for a given languageId. Tries each server in order;
 * returns the first one whose executable is on PATH.
 *
 * The "best" depends on context:
 *   - For deno.json projects, deno LSP. Otherwise typescript-language-server.
 *     The caller resolves project root first and can prefer deno.
 *   - For Python, pyright if installed, else pylsp.
 *
 * Caller is expected to filter by languageId first and then resolve which
 * server (of the candidates) is available.
 */
export function candidatesFor(languageId: string): ServerConfig[] {
  return SERVERS.filter((s) => s.languageIds.includes(languageId));
}
