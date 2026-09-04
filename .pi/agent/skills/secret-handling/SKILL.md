---
name: secret-handling
description: Use when a task needs to compare, verify, rotate, or hand a credential to a program - "is the key in the repo the one the container is running", "did the rotation propagate", "check these match", "set this secret", or any point where you are about to read a credential's VALUE to answer a question about it. Fires when you catch yourself writing `sops -d | grep | cut`, `docker inspect --format '{{json .Config.Env}}'`, `md5sum | cut -c1-16` on a secret, `echo $TOKEN`, or `cat .env`. NOT for encrypting a file at rest (sops-encrypt) or classifying whether a term is confidential (the AGENTS.md rule + confidential_terms tool).
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
secretctl fp --salt-file ~/.secretctl-salt 'docker:router/caddy#TOKEN' > before.txt
# ... rotate + deploy ...
secretctl fp --salt-file ~/.secretctl-salt 'docker:router/caddy#TOKEN' > after.txt
diff before.txt after.txt
```

**An unchanged digest means the rotation did NOT propagate.** This is the whole
value of the loop: "I deployed it" is a claim, a changed digest is evidence.
`secretctl set` prints before/after automatically and says so when they match.

`set` destinations: `dotenv:`, `keyfile:`, `sops:` (re-encrypts to the file's
OWN age recipients, never a .sops.yaml rule), and `bw:` (updates the custom
field when one exists, else upserts a notes `FIELD=value` line; syncs the
daemon's read cache after the PUT so the verify step sees the write).

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

The guard's contract, pinned by `skill-guard-coupling.test.ts` (dotfiles): every
fenced block in this file is annotated `<!-- good -->` or `<!-- bad -->` and fed
through the guard's rules, so the documented escape hatches cannot drift from
what the guard actually enforces (that drift bit live 2026-08-30 - the old
`env | grep ^NAME` escape was blocked by the guard itself).

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
  process. `tool-guard` hard-blocks these. To check one variable WITHOUT its
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

Pattern rules cannot tell a token from a commit hash. The 2026-09-04 leak was a
bare 48-hex token in `~/.config/memledger/env`, printed by the pi `grep` tool
in the same turn the user had said "don't print it"; no format rule, no env
value and none of gitleaks / trufflehog / noseyparker matched that line. What
IS knowable is where the stores are. `~/.config/secretctl/sources` lists them
(globs and `**` allowed; `dotenv:`/`sops:` patterns are content-sniffed so one
glob written with both schemes puts each file in exactly one resolver):

<!-- good -->
```bash
secretctl sources                          # what the registry expands to (labels only)
secretctl digests                          # keyed digest per registered value
secretctl classify ~/infra/x/compose.yaml  # 0 = holds registered material, 1 = clean, 2 = unresolved
secretctl coverage                         # secret-looking files the registry does NOT cover (nightly timer too)
```

The pi guard consumes `secretctl digests --json` (full-width HMACs + the
session salt, held in memory, never printed) and then: a `read`/`grep`/`cat`
aimed at a registered store is blocked; a file whose content holds a registered
value - a compose file with a pasted secret, a dump - is blocked as a COPY; any
registered value that still reaches a tool result is masked, whatever file or
command it came from. A new store is covered the moment it is registered; an
unregistered store is not covered at all, so when you create one, add it.

The registry file is stowed from `dotfiles/.config/secretctl/sources`.

Two more layers ride on the same digest set (added 2026-09-04 after the model
retyped a credential it had seen into its own message, twice in one day):

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

## Failure catalogue (each one happened)

**Redact-on-display instead of count.** A stray 681KB json dump on a shared
host's /tmp held real `"password"` values. Deciding whether to delete it needed
only "is a secret-shaped field populated" - and a `grep -c` had already
answered yes. A second command ran `grep -o` for the field and masked the
result with `sed`, which worked, but carried the plaintext through a pipeline
where one non-matching quote style would have printed it. It also fired no
guard rule: every rule was source-oriented (sops / docker / vault / ssh) and
none knew about grepping an arbitrary file. *Stop at the count; fingerprint the
file with `secretctl fp 'keyfile:PATH'` if you need more. The
SECRET_FIELD_EXTRACT rule now blocks the `-o`-plus-pipe shape.*

**Whole-env transport.** `docker inspect --format '{{json .Config.Env}}'` piped
into a local interpreter to pull one variable. A redaction filter keyed on the
string `SECRET` did not match `MINIO_ROOT_PASSWORD`, and the full value landed
in a transcript that syncs to a searchable store. *Extract on the far host; ship
only a digest.*

**Unkeyed truncated digest.** `md5sum | cut -c1-16` used as the witness. Fine
for a 64-char key, useless for the 4-char one in the same fleet. *Keyed HMAC,
random per-run salt.*

**Inconsistent canonicalisation.** Some comparison legs ran `tr -d '\n'`, others
did not. Different digest, reported as MISMATCH, on identical credentials. *One
canonicalisation rule, applied in one place, printed in the output so a mismatch
can never be quietly blamed on framing.*

**Writer and reader disagreeing.** A `set` path escaped `"` as `\"`; the `fp`
path returned the backslash. A credential that had not changed reported
MISMATCH. *Define the codec's two halves together and round-trip-test them.*

**Cross-implementation key mismatch.** Go keyed an HMAC on a salt's decoded
bytes while the remote `openssl dgst -hmac <hex>` keyed on the hex characters -
so a local and a remote digest of the same credential could never agree. 245
Go-only tests passed, because both sides of every assertion used the same wrong
key. *Test across the boundary, against the real other implementation.*

**Error strings as a leak path.** A parse error quoted its input verbatim; if a
remote host echoed the value instead of a digest, the error printed the
credential. `encoding/hex`'s wrapped error names the offending byte - one
character of the payload. *Error messages are a printed surface; report shapes
and lengths, not contents.*

**Unresolved read as drift.** A typo'd container name reported as MISMATCH
rather than "could not read", which points at rotating a working secret.
*Distinguish MISMATCH (1) from UNRESOLVED (2). An empty resolve is UNRESOLVED -
two empty values digest identically, the most dangerous false MATCH there is.*

**Encrypted framing read as drift.** The router's composer checkout of a
stack's `.env` holds SOPS-ENCRYPTED values (`ENC[AES256_GCM,...]`, ~171B)
while the container runs the decrypted one (48B). Digesting the blob against
plaintext reported MISMATCH on identical credentials. A length delta of
*hundreds* of bytes is framing, not a rotation - check the file's format
before acting. `secretctl`'s `sshenv:` now fails closed on `ENC[` values
with the cause named; the supported path is ciphertext-vs-ciphertext
(`dotenv:` vs `sshenv:`) or fetch-and-`sops:` locally.

**Quote/CRLF framing (fixed 2026-09-02).** `sshenv:` now applies the same
dotenv codec as `dotenv:`/`sops:` on the far side: it trims surrounding
whitespace (a trailing CR from a CRLF file) and strips ONE matched pair of
surrounding quotes. Before this, `KEY="abc"` or a CRLF-edited file reported a
false MISMATCH against an identical plaintext source and cost a needless
rotation. Residual: a double-quoted value with backslash escapes is not
unescaped remotely (rare; `secretctl set` writes single-quoted, which is
exact).

**A boolean probe that prints the line.** `sed -n 's/^KEY=[^E]*/plain/p'`
was meant to classify a line without reading it, but `s///` replaces only
the matched prefix and keeps the rest of the line - the full value went
into the transcript. It was ciphertext (the age key is the boundary, and it
never appeared), but the shape was wrong. *Classify with `grep -q`, `case`,
or a pattern that consumes the whole line (`s/...$/tag/p`), never one that
preserves the tail.*

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
