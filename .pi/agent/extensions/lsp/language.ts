/**
 * Extension → LSP languageId mapping. Subset of opencode's
 * ~/opencode/packages/opencode/src/lsp/language.ts adapted for Pi.
 *
 * The languageId is sent as part of textDocument/didOpen and lets the LSP
 * server know what grammar/parser to use.
 */

export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",

  ".py": "python",
  ".pyi": "python",

  ".rs": "rust",

  ".go": "go",

  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".cs": "csharp",

  ".java": "java",
  ".kt": "kotlin",
  ".scala": "scala",
  ".swift": "swift",
  ".dart": "dart",

  ".lua": "lua",
  ".rb": "ruby",
  ".php": "php",
  ".pl": "perl",

  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".fish": "fish",

  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",

  ".json": "json",
  ".jsonc": "jsonc",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",

  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "mdx",

  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",

  ".tf": "terraform",
  ".tfvars": "terraform-vars",
  ".hcl": "hcl",

  ".dockerfile": "dockerfile",
  Dockerfile: "dockerfile",

  ".nix": "nix",
  ".zig": "zig",
  ".elm": "elm",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".jl": "julia",
};

export function languageIdFor(filePath: string): string | undefined {
  // Special-case unsuffixed Dockerfile
  if (filePath.endsWith("/Dockerfile") || filePath === "Dockerfile") return "dockerfile";
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = filePath.slice(dot).toLowerCase();
  return LANGUAGE_EXTENSIONS[ext];
}
