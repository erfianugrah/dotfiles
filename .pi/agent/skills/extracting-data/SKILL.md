---
name: extracting-data
description: "Use when about to write a shell pipeline that FINDS or EXTRACTS information - jq/JSON, rg searching, fd file discovery, yq, duckdb, mlr, gron, htmlq, awk/sed, xargs - and when one comes back empty, errors, or looks wrong. Fires on 'parse the response', 'search the codebase for', 'which files contain', 'pull the field out of', 'why did this jq/rg return nothing', 'count the occurrences', any curl piped into jq. NOT for editing code, credential VALUES (secret-handling), or session-history search."
---

# extracting-data

Finding and extracting is the hot path: measured over this agent's own
session history, roughly 60% of tool calls are search or extraction and about
12% are edits. Every behaviour below was executed locally against the
installed versions (`jq-1.8.2`, `rg 15.2.0`, `fd 10.5.0`, `fzf 0.74.3`,
`yq v4.53.3`, `mlr 6.21.0`, `dsq 0.23.0`, `duckdb v1.5.5`, `htmlq 0.4.0`,
`sd 1.0.0`, `ast-grep 0.44.1`, GNU `xargs`; no `xsv`, no `jaq`), not
recalled. Re-verify before porting any of it to another box.

## Three questions before the pipeline

1. **Is the answer already in context?** Endpoint shapes, canonical commands,
   file layouts and earlier tool results usually sit in the prepended rules or
   a loaded SKILL.md. Six calls guessing an API's JSON shape that was written
   in the session's own system prompt is the observed failure.
2. **What shape is the data?** Guessing the shape produces the parse errors
   below.
3. **What is the cheapest probe that discriminates?** Rank probes by cost over
   how much they narrow the space; run the cheapest first even when a costlier
   hypothesis feels likelier.

## JSON

**Probe the shape before writing a filter:**

```bash
curl -sL "$URL" | jq 'type, (if type=="object" then keys else (.[0]|type) end)'
```

```
$ echo '{"a":1}' | jq -c 'type, keys'   -> "object" ["a"]
$ echo '[1,2]'   | jq -c 'type'         -> "array"
```

**A parse error does not mean your path is wrong.** A non-JSON body - 404
page, 307 redirect, rate-limit HTML - fails identically to a bad filter:

```
$ printf '<html>404</html>' | jq -r '.x'
jq: parse error: Invalid numeric literal at EOF at line 1, column 16
```

Look at the BODY first (`head -c 200`), not at the filter. Pass `-L` to curl
(a 307 body is not JSON), and treat a rate limit as **unknown**, never as
absent.

### Exit codes (verified)

`jq -e` sets exit status from the last output, and the codes are not what
"error" intuition suggests:

```
jq -e 'null'   -> 1     # last output was false or null
jq -e '.a=1'   -> 0     # truthy output
jq -e 'empty'  -> 4     # NO output was ever produced
```

Plain jq (no `-e`) exits 2 on usage/system error, 3 on a program compile
error. `halt_error(N)` exits with N (default 5) and prints the input to
stderr raw.

### `//` is not "or" (highest-value gotcha)

`a // b` yields the values of `a` that are neither `false` nor `null`;
only if there are none does it yield `b`. It short-circuits across a
generator, and a pipe changes the answer:

```
$ jq -c '(false,null,1)//42'      -> 1          # LHS produced a truthy value; 42 never evaluated
$ jq -c '(false,null,1)|.//42'    -> 42 42 1    # each value tested separately
```

`false // x` therefore yields `x` - if `false` is a legitimate value in your
data, `//` will silently discard it.

### Shell safety

Never interpolate shell values into a jq program; bind them:

| flag | binds |
|---|---|
| `--arg n v` | `$n` as a **string** (`--arg x 123` gives `"123"`) |
| `--argjson n json` | `$n` as parsed JSON |
| `--rawfile n f` | `$n` = file contents as one string |
| `--slurpfile n f` | `$n` = array of the JSON values in the file |
| `--args` / `--jsonargs` | trailing argv into `$ARGS.positional[]` |
| `$ENV` / `env` | environment (`$ENV` is a snapshot at start) |

`@sh` escapes output for a POSIX shell. In the interpolation form
(`@uri "search?q=\(.q)"`) only the `\(...)` parts are escaped, not the
literal text around them.

### Big inputs

`-s` (slurp) loads everything into memory. For large files use `-n` with
`inputs` (streams document by document), or `--stream` for a single huge
document, which emits `[path, leaf]` pairs plus `[path]` end markers:

```
$ echo '["a",["b"]]' | jq -c --stream '.'
[[0],"a"] [[1,0],"b"] [[1,0]] [[1]]
```

Rebuild with `fromstream(1|truncate_stream(inputs))`. Early exit:
`first(f)`, `limit(n; f)`, and `label $out | ... break $out`.

### Shape discovery and 1.8-era builtins (verified present)

```bash
jq -c '[paths(scalars)]'          # [["a","b"]]  - leaf_paths was REMOVED in 1.7
jq -c 'pick(.a,.b.c)'             # {"a":1,"b":{"c":2}}  - projection (1.7+)
jq -c '[skip(2; 1,2,3,4)]'        # [3,4]  - counterpart to limit (1.8)
jq -c 'trim' / 'toboolean'        # "x" / true  (1.8)
jq '.. | objects | select(has("id"))'
jq 'to_entries|map(...)|from_entries'   # or with_entries(f)
```

`leaf_paths` errors with "not defined" on 1.8 - a model trained on jq 1.6
will emit it. So will `--argfile` (removed) and `recurse_down` (removed).
In 1.8, `index/rindex/indices` count **code points**, not bytes.

**Duplicate object keys are silently dropped** by the normal parser (last
wins). Only `--stream` sees them all.

### NDJSON / JSONL

`jq` reads it natively without `-s`:

```bash
jq -r 'select(.kind=="task") | "\(.preset) \(.metrics.wall_s)"' runs.jsonl
```

**Unknown or deep JSON**: `gron` flattens to greppable assignments,
`gron -u` reverses it: `gron big.json | rg -i error | gron -u`.

**Never full-read a lockfile.** `jq '.packages | keys' package-lock.json`.

## Searching text with rg

### The ignore ladder, measured

Built a tree with a tracked file, a gitignored file, and a hidden file, all
containing the same needle:

| flags | files found |
|---|---|
| *(default)* | `tracked.txt` |
| `--no-ignore-vcs` | `ignored.txt tracked.txt` |
| `-u` | `ignored.txt tracked.txt` |
| `--hidden` | `.hid/h.txt tracked.txt` |
| `-uu` | `.hid/h.txt ignored.txt tracked.txt` |

So `-u` does **not** reveal hidden files - that is `-uu`, and `-uuu` adds
binary files. A default `rg` result means "not in the tracked, non-hidden,
non-binary tree", which is a weaker claim than "not present".

**When rg finds nothing**: drop the most specific term -> `-F` (regex
metacharacters?) -> `-i` -> `--hidden` -> `-u`/`-uu`/`-uuu` -> `--debug`,
which prints why each file was skipped. The upstream GUIDE names the classic
cause: a `*` rule in `$HOME/.gitignore`. `RIPGREP_CONFIG_PATH` can also be
injecting flags you never passed - `--no-config` rules that out.

### Globs: later wins, and one whitelist makes matching mandatory

Verified against a dir holding `a.toml` and `b.rs`:

```
rg -l x gt -g '!*.toml' -g '*.toml'   -> gt/a.toml     # later glob wins
rg -l x gt -g '*.toml' -g '!*.toml'   -> (nothing)
```

Note `b.rs` is absent from the first result: the presence of a non-negated
glob requires every searched file to match at least one glob. (A widely
copied worked example gets this backwards - test it, don't trust it.)

`-t go` / `-T go` filter by type, `--type-list` shows them, `--type-add
'web:*.{ts,css}'` defines one for that invocation only.

### Counting, engines, and machine output

```
rg -c 'a'               -> 1     # matching LINES
rg --count-matches 'a'  -> 3     # individual MATCHES   (file: "a a a" / "b b")
```

Reporting "1 occurrence" when there are 3 is a silent wrong answer.

`-P` enables PCRE2 (available in this build - `rg -P '(?<=a)b'` matches).
It costs real performance: PCRE2 forces the slow line-by-line searcher and
UTF-8 transcoding of every file. Use it only for lookaround/backreferences.
`-U/--multiline` requires the whole file in memory, so avoid it on large
trees. `--sort path` disables all parallelism.

### The `--json` event stream

Parse this instead of regexing the human format. One JSON object per line;
verified against rg 15.2.0 searching a two-line file:

| `.type` | `.data` keys |
|---|---|
| `begin` | `path` |
| `match` | `path`, `lines`, `line_number`, `absolute_offset`, `submatches` |
| `context` | same as `match` |
| `end` | `path`, `binary_offset`, `stats` |
| `summary` | `elapsed_total`, `stats` |

The printer crate's own documentation lists only four types and no
`summary` - the binary emits one anyway, at the end of the whole run
(`stats` keys: `bytes_printed bytes_searched elapsed matched_lines matches
searches searches_with_match`). Trust the binary.

**Every path and text field is a two-shape object**, not a string: `{"text":
"..."}` when the bytes are valid UTF-8, `{"bytes": "<base64>"}` when they are
not. A consumer that reads `.data.path.text` unconditionally silently drops
every non-UTF-8 path. Use `.data.path.text // (.data.path.bytes|@base64d)`.

**Two different offset origins in the same message.** `absolute_offset` is a
byte offset into the FILE; `submatches[].start/end` are byte offsets into
`lines` (half-open, and into the decoded bytes if `lines` came back base64).
Verified: line 1 of `hay needle hay` gives `absolute_offset 0` with submatch
`4..10`; line 2 gives `absolute_offset 15` with submatch `0..6`.

`--stats` appends the same counters in human form.

`--pre CMD` runs a preprocessor per file (PDFs, binaries); always pair it
with `--pre-glob` or it runs on every file - the GUIDE measures a 17x
difference. `-z` searches gzip/bzip2/xz/zstd **single files**, not `.tar.gz`
archive members.

## Finding files

**`rg --files`, not `find`.** On this box `find` hangs on the 18 GB home tree
even with `-maxdepth`; `rg --files` is parallel and ignore-aware.

```bash
rg --files ~/work | rg -i '\.tsx?$'
rg --files -g '*.ts' ./src
```

`fd` for what rg cannot express - and note its flags differ from rg's:

```bash
fd -e go -t f --changed-within 2d src/    # ext / type / mtime
fd -u                                     # = -H -I (hidden + no-ignore). NOT rg's -u
fd -0 -e rs | xargs -0 wc -l              # NUL-safe pairing
fd -x cmd {} \;                           # once PER result, in parallel
fd -X cmd                                 # ONCE with all results as args
```

Placeholders for `-x`/`-X`: `{}` path, `{.}` path minus extension, `{/}`
basename, `{//}` parent dir, `{/.}` basename minus extension. Shell aliases
and functions cannot be invoked this way.

Use `find` only for `-newer`, `-printf`, `-perm`, `-exec` semantics rg and fd
lack, and always with a narrow root.

## xargs

Verified on GNU xargs: **empty input still runs the command once**.

```
printf '' | xargs echo "RAN:"      -> RAN:        # command ran with no args
printf '' | xargs -r echo "RAN:"   -> (nothing)
```

`rg -l pattern | xargs rm` therefore runs `rm` with no arguments when the
search matches nothing. Always `-r`.

- `-0` with `rg --null` / `fd -0` / `find -print0` for paths with spaces.
- `-I{}` implies `-L 1` and newline-delimited input - it silently changes how
  xargs reads, and `-n`/`-L`/`-I` are mutually exclusive (last one wins).
- `-P N` for parallelism, but pair it with `-n` or `-L` or you get one exec.
- Exit codes: 123 (a child exited 1-125), 124 (child exited 255), 125 (child
  signalled), 126 (not executable), 127 (not found). **A child exiting 255
  aborts the whole batch immediately** - silent partial work.

## Choosing the tool for the shape

| shape | tool | one-liner |
|---|---|---|
| JSON, known path | `jq` | `jq -r '.a.b[0]' f.json` |
| JSON, unknown shape | `gron` | `gron f.json \| rg key` |
| YAML / TOML / XML | `yq` | `yq '.services.web.image' compose.yaml` |
| HTML | `htmlq` | `htmlq 'a.link' --attribute href < page.html` |
| CSV/TSV reshaping | `mlr` | `mlr --csv stats1 -a mean,p95 -f ms data.csv` |
| SQL across mixed files | `dsq` | `dsq a.csv b.json 'SELECT ...'` |
| Big CSV/Parquet/JSON(L) | `duckdb` | `duckdb -c "SELECT sum(a) FROM read_json_auto('f.jsonl')"` |
| Code structure | `ast-grep` | `ast-grep --pattern 'foo($A)' -l ts` |
| Symbols / references | the `lsp` tool (pi extension `extensions/lsp/`) | accurate where regex is not; fall back to `ast-grep` where the tool is absent |

`duckdb` reads csv/json/parquet off disk with SQL including globs
(`'logs/*.json'`) - reach for it before writing Python to aggregate.

**fzf is not interactive here.** An agent cannot drive the TUI, but `fzf -f`
is a non-interactive fuzzy filter that exits 1 on no match:

```
$ printf 'src/main.go\nsrc/util_test.go\ndocs/readme.md\n' | fzf -f 'srcgo'
src/main.go
src/util_test.go
```

## awk (gawk 5.4.1 here)

Reach for awk when the job is field arithmetic, grouping, or a conditional
across columns - it beats `cut` (which cannot collapse repeated delimiters)
and beats a Python script for anything a line at a time.

```bash
awk '{s+=$3} END{print s}'                    # sum a column
awk -F, '$3 > 100 {print $1}'                 # filter on a field
awk '{c[$1]++} END{for (k in c) print c[k], k}' | sort -rn   # group-by count
awk 'NR==FNR{seen[$1]; next} $1 in seen' a b  # join/semi-join two files
awk 'NF' file                                 # drop blank lines
awk '{print $NF}'                             # last field
```

**`FS=" "` is a special value, not "a space".** It means "runs of whitespace,
with leading and trailing trimmed". Any other single character delimits
literally, so consecutive delimiters create empty fields:

```
printf '   a   b  \n' | awk '{print NF"|"$1"|"$2}'   -> 2|a|b
printf 'a\t\tb\n'     | awk -F'\t' '{print NF}'       -> 3
```

**OFS is only applied when `$0` is rebuilt.** This is the single most common
awk surprise:

```
printf 'a b c\n' | awk 'BEGIN{OFS=","}{print $1,$2}'    -> a,b     # comma list uses OFS
printf 'a b c\n' | awk 'BEGIN{OFS=","}{print}'          -> a b c   # $0 untouched
printf 'a b c\n' | awk 'BEGIN{OFS=","}{$1=$1; print}'   -> a,b,c   # $1=$1 forces rebuild
```

**Comparison flips between numeric and string depending on the other side.**
A field that looks like a number is a "strnum": numeric against a number,
string against a string literal.

```
$1 > 9      on "10" -> true      # numeric
$1 > "9"    on "10" -> false     # string: "1" < "9"
$1 == 7     on "  007  " -> true   # numeric
$1 == "7"   on "  007  " -> false  # string
```

And verified against gawk 5.4.1, contradicting a claim you will see repeated:
an **empty field does not equal 0**. `$2 == 0` is false for both an empty
field and a nonexistent one; only `$2 == ""` is true for either. Test the
emptiness you actually mean.

Other load-bearing bits: `NR` is the global record number, `FNR` restarts per
file (the `NR==FNR` idiom above depends on it); assigning past `NF` extends
the record and rebuilds `$0`; `for (k in a)` has **no defined order** (pipe to
`sort`); `exit N` sets the status and still runs `END`. `gensub`, `RS` as a
regex, and `delete array` (whole array) are gawk extensions - avoid them in
anything that might run under busybox or mawk.

## sed (GNU sed 4.10 here)

House rule first: **do not use sed to edit source code** - `sd` for plain
text, `ast-grep --rewrite` for structure, the harness's edit tool for one-off
surgical changes. sed earns its place for line-addressed work on streams and
large files.

```bash
sed -n '100,200p' big.log        # print a line range (cheaper than read)
sed -i '99a\new line here' f     # insert after line 99
sed -i '100,200d' f              # delete a range
sed -i '/^DEBUG/d' f             # delete matching lines
sed -n 's/^ver=//p' f            # extract + print only what matched
sed '10q' big.log                # stop after 10 lines - early exit on huge files
```

**`0,/re/` is not `1,/re/`.** The GNU-only zero form lets the END address
match the very first line, which is what you want for "replace the first
occurrence anywhere in the file":

```
seq 10 | sed -n '1,/[0-9]/p'   -> 1 2     # range starts at line 1, ends at the NEXT match
seq 10 | sed -n '0,/[0-9]/p'   -> 1       # range can end on line 1 itself
```

**`q` and `Q` carry an exit code**: `seq 5 | sed '2q5'` exits **5**. Useful
as a cheap test-and-report inside a pipeline (`Q` quits without printing).

**`N` on the last line behaves differently under POSIX.** GNU prints the
pattern space; POSIX mode discards it, silently losing the final line:

```
seq 3 | sed N            -> 1 2 3
seq 3 | sed --posix N    -> 1 2     # line 3 vanished
```

Any script relying on `N` should guard with `$!N` or accept GNU-only.

Also: `-i` takes an OPTIONAL suffix, so `sed -iE` means "backup suffix E",
not `-i -E` (BSD/macOS instead REQUIRES an argument, hence the `sed -i ''`
you see in cross-platform scripts). `-E` for extended regex, `-z` for
NUL-separated records, `-s` to treat multiple files separately, `--debug` to
see the program and per-cycle pattern space. Any character can be the `s`
delimiter - `s#one/two#three/four#` avoids backslash soup.

## Shell traps that produce wrong extractions

- **zsh does not word-split unquoted `$(...)`.** `ssh servarr 'docker stop
  $(cat list)'` passes the whole list as ONE argument, because that host's
  login shell is zsh. Portable fix: `cat list | xargs -r docker stop`.
- **`uniq` only collapses ADJACENT duplicates.** `printf 'b\na\nb\n' | uniq`
  keeps both `b`s. Sort first, or use `sort -u`.
- **`set -o pipefail` + `head` can exit 141** (SIGPIPE) when the producer is
  still writing: `yes | head -2` exits 141, while `rg --files ~/infra | head -2`
  exits 0 because rg finished first. That intermittency is why a pipeline
  works interactively and fails in CI.
- **`cat file | tool` is a wasted process.** `tool < file` or `tool file`.
- **Cap the output.** `| head -50`, `--max-columns 200`, `--max-count 3`.
  Tool output becomes next-turn input tokens.
- **Big intermediates go to a file**, then query the file - do not round-trip
  megabytes through the transcript.

## Extracting near secrets

Answer the question without rendering the value:

```bash
rg -c 'AGE-SECRET-KEY-1[A-Z0-9]{20,}' file     # present? count only
secretctl fp 'sops:.env#KEY'                    # fingerprint, never the value
secretctl cmp 'sops:.env#K' 'docker:HOST/C#K'   # do they match?
```

`rg -o 'PASSWORD=.*'` prints the password into the transcript and the synced
session store. Full method: the `secret-handling` skill.

## Session logs

History search tools are the access path: `session_search` /
`memledger_search` in pi, `search_messages` / `search_ledger` (erfi-toolkit)
in Claude Code. Drop to `jq` on the pi `.jsonl` files only for what an index
cannot answer - tool-call sequencing, timestamps, per-session statistics:

```bash
jq -r 'select(.type=="message" and .message.role=="assistant")
       | .message.content[]? | select(.type=="toolCall") | .name' \
   $(rg --files ~/.pi/agent/sessions -g '*.jsonl' | head -400) \
  | sort | uniq -c | sort -rn
```

## Provenance

Behavioural claims come from the upstream jq manual/FAQ and the ripgrep
GUIDE/FAQ, then re-executed locally on the versions listed at the top; where
a published worked example disagreed with the installed binary (glob
precedence), the binary won. Re-verify on any other machine.
