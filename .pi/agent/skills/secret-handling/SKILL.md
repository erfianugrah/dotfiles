---
name: secret-handling
description: "Use when a task needs to compare, verify, rotate, or hand a credential to a program, or asks where a secret is stored - 'is the key in the repo the one the container runs', 'did the rotation propagate', 'set this secret', or whenever you are about to read a credential's VALUE. Fires on `sops -d | grep | cut`, `docker inspect` of Config.Env, `md5sum` on a secret, `echo $TOKEN`, `cat .env`. NOT for encrypting a file at rest (sops-encrypt) or confidential-term classification (the AGENTS.md rule)."
---

# Secret handling - answer the question without reading the value

## The core move

Almost every question about a credential is answerable without the credential.

| Question | What you actually need |
|---|---|
| Do these two systems hold the same secret? | a witness that differs when the values differ |
| Did the rotation propagate? | the witness before vs after |
| Is this variable set? | presence, and maybe length |
| Does this program work with this key? | the key inside the program, not on your screen |

Only the last needs the plaintext, and it needs it in a **child process**, not in
your terminal. Reaching for the value to answer any of the first three is the
mistake this skill exists to prevent.

**Use `secretctl` (`~/infra/secretctl`, `make install`).** It exists because the
hand-rolled version of this kept being wrong in ways that were worse than
verbose - see the failure catalogue below.

<!-- good -->
```bash
secretctl cmp 'sops:.env#POSTGRES_PASSWORD' 'docker:servarr/memledger-backup#PGPASSWORD'
# exit 0 = match, 1 = mismatch, 2 = a source could not be read
```

Assert on `$?`. Never parse the table.

## Where secrets live (the one statement other skills point at)

- **Canonical store: the SOPS-encrypted `.env` committed in each stack's git repo.**
  Composer decrypts at deploy. As of the 2026-09-04 fleet conversion the deliberate
  plaintext exceptions are memledger's env file and llm-compose's `.env`. No
  password-manager item is canonical for anything; `bw:` sources exist in secretctl
  for leftovers only.
- **Registry:** `~/.config/secretctl/sources` (stowed from
  `~/dotfiles/.config/secretctl/sources`) lists every store. A store that is not
  listed is not guarded at all. Register a store when you create it;
  `secretctl coverage` finds the gaps.
- **Trust root: the age private keys, never in git.** The shared infra key is
  `~/.config/sops/age/keys.txt` on this workstation and on the MS-01 composer
  host. The drawbridge-only identity is `~/.config/sops/age/drawbridge.txt` on
  this workstation only.
- **Escrow status: OPEN.** Verified: both key files exist here, and the
  drawbridge key's off-box backup is still an unchecked item in
  `~/infra/drawbridge/TODO.md`. Not verified from this machine: that any copy
  of `keys.txt` exists beyond the composer host (older notes name a
  password-manager item; no restore drill from it is recorded). Until a drill is
  recorded, treat losing this workstation and the router together as losing
  every encrypted `.env`.

## Witness levels - pick the weakest that answers the question

From `arrangeactassert.com/posts/log-the-fingerprint-not-the-secret/`:

| Level | Shows | Use when |
|---|---|---|
| `none` | the name resolved | default; you only need "it is configured" |
| `length` | + byte count | **low-entropy values** (a port, a flag, a 4-char key) |
| `fingerprint` | + keyed HMAC digest | comparing or verifying rotation of a real credential |
| masked (`sk_live_...4f91`) | a partial reveal | never in an agent transcript |

**A fingerprint is not safe for a low-entropy value.** An unkeyed digest of
`true`, `8080`, or a four-character access key id is rainbow-tableable in under a
second. That is not hypothetical: one access key id in this fleet turned out to
be exactly four characters. For those, `length` is the correct witness.

`secretctl` keys every digest with a random per-run salt, which removes the
guessing target and makes printed digests useless as a cross-transcript
correlation handle. It prints length alongside every digest for free.

## Rotation: the loop that proves it landed

<!-- good -->
```bash
# <salt-file> is e.g. a mode-600 file under ~/.config/secretctl/
secretctl fp --salt-file <salt-file> 'docker:router/caddy#TOKEN' > before.txt
# ... rotate + deploy ...
secretctl fp --salt-file <salt-file> 'docker:router/caddy#TOKEN' > after.txt
diff before.txt after.txt
```

**An unchanged digest means the rotation did NOT propagate.** This is the whole
value of the loop: "I deployed it" is a claim, a changed digest is evidence.
`secretctl set` prints before/after automatically and says so when they match.

`set` destinations: `dotenv:`, `keyfile:`, `sops:` (re-encrypts to the file's
OWN age recipients, never a .sops.yaml rule); `bw:` remains for the legacy
password-manager leftovers only.

`--salt-file` is required here and only here - comparing across time needs a
stable key. The cost is that those digests become linkable, so treat the salt
file and any recorded digests as sensitive metadata.

## When a program needs the real value

<!-- good -->
```bash
secretctl exec 'sops:.env#POSTGRES_PASSWORD' --as PGPASSWORD -- psql -h db -U postgres
sops exec-env secrets.enc.env 'psql'      # equivalent for a whole file, FIFO-backed
```

Both put the value in the child's environment. Neither renders it. The
alternatives all leave a copy somewhere durable:

- `export PGPASSWORD=$(...)` - shell history, parent env, every later child
- any credential passed as a command-line ARGUMENT - the process table, visible
  to every local user for the life of the process (`ps aux`). Note `psql` itself
  gives you no way to do this: `-W/--password` is a boolean that forces a
  prompt, it takes no value. Tools that DO accept one (`mysql -p<pass>`,
  `curl -u user:pass`) are the hazard.
- writing a temp file - survives a crash, and you will forget the `rm`

Source: /docs/sops/usage/advanced/index.md (`exec-env` / `exec-file`).

## Never

<!-- good -->
```bash
[ -n "${NAME+x}" ] && echo set || echo unset
printenv NAME
docker inspect C --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^VAR=//p'
```

The guard's contract, pinned by `.pi/agent/tests/skill-guard-coupling.test.ts`:
every fenced bash block in this file is annotated `<!-- good -->` or
`<!-- bad -->` and fed through the guard's rules, so a documented escape hatch
cannot drift from what the guard actually enforces. Any new fence here needs
the annotation or the suite fails.

<!-- bad -->
```bash
env | grep ^NAME
docker inspect --format '{{json .Config.Env}}' c
sops -d secrets.enc.env | grep KEY | cut -d= -f2
bw get item MyItem
ssh router 'printenv'
docker exec caddy env
sops -d .env
grep -ohE '"password":"[^"]+"' /tmp/dump.json | sed -E 's/:.*/:REDACTED/'
```

- **`env`, `printenv`, bare `set`, `export -p`** - dumps every credential in the
  process. `secret-output-guard` blocks these (pi: `.pi/agent/extensions/secret-output-guard.ts`;
  Claude Code: `.claude/hooks/secret-output-guard.ts`). To check one variable WITHOUT its
  value: `[ -n "${NAME+x}" ] && echo set || echo unset` (a bare `env | grep`
  is blocked by the guard itself - the chain starts with the dump form).
- **`docker inspect --format '{{json .Config.Env}}'`** - transports the whole
  container environment. Use a field selector, remote-side:
  `--format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^VAR=//p'`.
- **`sops -d file | grep KEY | cut -d= -f2`** - plaintext in a pipeline, and
  `cut -d= -f2` truncates any value containing `=` (base64 padding, connection
  strings), which then reads as drift against a correctly-read copy.
- **Redaction filters keyed on a guessed variable-NAME substring.** Filter on
  the assignment side: `sed 's/=.*$/=<set>/'`. A filter looking for `SECRET`
  sails straight past `MINIO_ROOT_PASSWORD`.
- **Printing a value to "check" a credential.** Test it by USING it:
  `aws s3 ls` with the vars inline, `psql -c 'select 1'` via `exec`.
- **Extracting a value in order to redact it for display.** If the question is
  "does this file hold a live secret" - deciding whether to delete a stray
  dump, say - a COUNT answers it: `grep -c '"password":"[^"]*"' f`. Reaching
  for `grep -o` and masking the result with `sed` buys no extra information
  and puts the plaintext one regex miss from the transcript: different
  whitespace, a nested object or an escaped quote and the mask silently fails
  open. To characterise a whole file without rendering it, fingerprint it:
  `secretctl fp 'keyfile:PATH'` or `secretctl fp 'dotenv:PATH#KEY'`.

## The registry: known values, not patterns

Pattern rules cannot tell a token from a commit hash: a bare 48-hex token in an
env file matched no format rule and none of gitleaks / trufflehog /
noseyparker, and it was printed. What IS knowable is where the stores are.
`~/.config/secretctl/sources` lists them
(globs and `**` allowed; `dotenv:`/`sops:` patterns are content-sniffed so one
glob written with both schemes puts each file in exactly one resolver):

<!-- good -->
```bash
secretctl sources                          # what the registry expands to (labels only)
secretctl digests                          # keyed digest per registered value
secretctl classify ~/infra/<stack>/compose.yaml  # 0 = holds registered material, 1 = clean, 2 = unresolved
secretctl coverage                         # secret-looking files the registry does NOT cover (nightly timer too)
```

The guard (pi extension and Claude Code hook alike) consumes `secretctl digests --json` (full-width HMACs + the
session salt, held in memory, never printed) and then: a `read`/`grep`/`cat`
aimed at a registered store is blocked; a file whose content holds a registered
value - a compose file with a pasted secret, a dump - is blocked as a COPY; any
registered value that still reaches a tool result is masked, whatever file or
command it came from. A new store is covered the moment it is registered; an
unregistered store is not covered at all, so when you create one, add it.

Two more layers ride on the same digest set, because a model that has seen a
value will retype it:

- **Your own text is masked before it is saved.** `message_end` runs the same
  tokenise-and-HMAC pass over the finalized assistant (and user) message, so a
  registered value you retype never reaches the session file, memledger, or
  the next turn's context. The streamed text was already on screen - a pi
  notice says so; treat a shared terminal as exposed.
- **A registered value inside a tool argument is refused.** A command line,
  file body or URL carrying a plaintext registered value is blocked with
  `secret_in_args`, and the persisted call is masked. The fix is `$VAR`,
  `secretctl exec`, or `secretctl set` - never a rewrite.

Pieces are caught too: `secretctl digests` emits digests of every 8-byte
window of each local opaque-token value, and two or more chunk-shaped pieces of
one value in a command or message (or a single piece of 9+ characters) are
refused as an assembly. Encoded spellings are covered too: the base64 and
percent-encoded forms of each local value carry digests, so a base64'd header or
an escaped DSN is masked like the raw value. Residual, by design: pieces shorter
than 8 characters, a value embedded mid-way inside a larger base64 blob, and
values that only exist after a shell runs. The block reason names all of that as a policy violation; doing it anyway
is one. Remote stores are registrable as `docker:HOST/*#*`, `sshenv:HOST/path#*`
and `uci:HOST/config#*` (hashed on the far host, digests only, no fragments).
Registry `exclude` lines keep configuration keys (TZ, LANG, EMAIL...) out of
the digest set so ordinary output is not masked.

## Failure catalogue - the rule each incident left behind

- **Stop at the count.** "Does this file hold a live secret" is answered by
  `grep -c`. A `grep -o` followed by a `sed` mask carries the plaintext through
  a pipeline one regex miss from the transcript. Fingerprint the file
  (`secretctl fp 'keyfile:PATH'`) if you need more; the SECRET_FIELD_EXTRACT
  rule blocks the `-o`-plus-pipe shape.
- **Extract on the far host; ship only a digest.** A whole container env piped
  into a local filter keyed on the string `SECRET` sailed past
  `MINIO_ROOT_PASSWORD`.
- **Keyed HMAC, random per-run salt.** An unkeyed truncated md5 is fine for a
  64-char key and useless for the 4-char one in the same fleet.
- **One canonicalisation rule, applied in one place, printed in the output.**
  Comparison legs that disagreed on stripping a trailing newline reported
  MISMATCH on identical credentials.
- **Distinguish MISMATCH (1) from UNRESOLVED (2).** A typo'd container name
  must not read as drift; an empty resolve is UNRESOLVED, because two empty
  values digest identically - the most dangerous false MATCH there is.
- **A length delta of hundreds of bytes is framing, not a rotation.** A
  SOPS-encrypted value (`ENC[AES256_GCM,...]`, ~171B) digested against its 48B
  plaintext is MISMATCH by construction; `sshenv:` fails closed on `ENC[`
  values. Compare ciphertext with ciphertext (`dotenv:` vs `sshenv:`) or fetch
  the file and use `sops:` locally.
- **Framing is the codec's job.** `sshenv:` applies the same dotenv codec as
  `dotenv:`/`sops:` on the far side (trims whitespace and a trailing CR, strips
  one matched pair of quotes). Residual: a double-quoted value with backslash
  escapes is not unescaped remotely; `secretctl set` writes single-quoted,
  which is exact.
- **Classify a line with `grep -q`, `case`, or a pattern that consumes the
  whole line (`s/...$/tag/p`).** A `sed` substitution that replaces only the
  matched prefix keeps the tail, and the tail is the value.

Implementation-side lessons (the cross-implementation HMAC key mismatch, the
writer/reader codec round-trip, error strings as a leak path) live with the
code in `~/infra/secretctl/AGENTS.md`.

## Interpreting a comparison

- **MATCH, same lengths** - the same credential.
- **MATCH, different lengths** - the same credential, different framing (one
  file has a trailing newline). Harmless now; it will confuse the next reader
  that does not canonicalise.
- **MISMATCH, same length** - genuinely different values. Do not stop here:
  confirm you addressed the right field. Prefix collisions (`AWS_SECRET_ACCESS_KEY`
  vs `AWS_SECRET_ACCESS_KEY_OLD`) and neighbouring keys in one file
  (`POSTGRES_PASSWORD` vs `POSTGREST_PASSWORD`) both produce a true MISMATCH on
  the wrong question.
- **UNRESOLVED** - the comparison did not happen. Conclude nothing about drift.

**Before acting on a MISMATCH, verify by a second independent path.** A
confident wrong MISMATCH costs a needless rotation. `docker exec <c> sh -c
'printf %s "$VAR"'` reads the LIVE process environment where `docker inspect`
reads the container's config - if those two disagree, the container has been
restarted with a changed env and that is itself the finding.

## Escalation

1. Can a digest comparison answer it? -> `secretctl cmp`.
2. Is the value low-entropy? -> use length, not fingerprint.
3. Does a program need it? -> `secretctl exec` / `sops exec-env`.
4. Only if none of the above: think about why the plaintext is needed, and
   whether the answer is really "the credential is wrong" rather than "I need to
   look at it".

## See also

- `~/infra/secretctl/AGENTS.md` - the tool's design invariants and the parity test
- `sops-encrypt` - encrypting a file at rest before commit
- `compose-backups` - where these credentials get consumed
- `validating-empirically` - the same discipline applied to external behaviour
