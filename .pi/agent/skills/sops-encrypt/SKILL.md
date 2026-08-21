---
name: sops-encrypt
description: Use when a file holding secrets, customer identifiers, credentials, or any sensitive prose needs to be committed to a git repo with a remote - encrypting before commit so plaintext never reaches the remote. Fires on "encrypt this", "encrypt them before committing", "encrypt the file", "sops", "age encrypt", "this has secrets/keys/customer names, commit it". NOT for app-level secret storage in a deployed service (that is the target repo's own pattern) or for the confidential-write classification decision (the AGENTS.md rule and confidential_terms tool own that).
---

# sops-encrypt - encrypt files with sops+age before commit

## Overview

The dotfiles ship zsh helpers in `functions.d/crypto.zsh` that encrypt files in-place with
`sops` + `age`. Use those. Do NOT hand-roll `age -o file.age file` or `openssl enc` - the
established path encrypts **in place** (same filename, sops metadata embedded), which is what
the repo's pre-commit hook and the rest of the tooling expect.

**Core principle: encrypt in place with `encrypt <file>`, never produce a separate `.age`/`.enc`
sidecar, and never commit the plaintext.** A sidecar file leaves the plaintext next to it and
breaks the convention every other repo follows.

## The command

```bash
encrypt <file>        # encrypt one file in place
encrypt <dir>         # encrypt every file in a directory, in place
encrypt_all           # alias for `encrypt .` (current dir)
decrypt <file|dir>    # reverse, in place
decrypt_all           # alias for `decrypt .`
encrypt_tf / decrypt_tf   # terraform secrets.tfvars / terraform.tfvars / *.tfstate* etc.
encrypt_k3s_secret <file> # only the data/stringData fields of a K8s Secret YAML
```

Requires `SOPS_AGE_KEYS` to hold an `AGE-SECRET-KEY-...` line and its `age1...` public key -
the helpers extract both from there (`_sops_age_public_key` / `_sops_age_private_key`). If it
is unset in the current shell, `encrypt` fails with "No AGE-SECRET-KEY found"; source the shell
config to pick it up.

**Never print the key material.** Do not `cat`/`echo`/`printenv` `SOPS_AGE_KEYS` or the keys file
to "check" it - that puts the private key into the session transcript and any synced store. To
confirm it is set without revealing it: `env | grep ^SOPS_AGE_KEYS | sed 's/=.*/=<set>/'`. The
public half is safe to derive and show (`age-keygen -y <keys-file>`); the `AGE-SECRET-KEY-...`
line is not.

## Workflow (sensitive file into a repo with a remote)

1. Write/edit the file with its real contents (customer names, keys, whatever it legitimately holds).
2. `encrypt path/to/file` - same path, now sops-encrypted.
3. `git add` + commit the encrypted file. The pre-commit hook blocks unencrypted secrets, so an
   encrypted file passes and plaintext would fail.
4. To read or edit later: `decrypt path/to/file`, edit, `encrypt` again before committing.

`.allow-unencrypted` at a repo root skips the hook's checks entirely;
`.allow-unencrypted-paths` (one glob per line) skips specific paths. Use for files that look
sensitive to the scanner but are not.

## Common mistakes

- **Hand-rolling `age -o file.age file`.** Produces a sidecar, leaves plaintext beside it, and
  is not the in-place sops convention the hook expects. Use `encrypt`.
- **`rm`/cleanup with a broad glob that also matches the encrypted output.** A glob like
  `*project*` deletes the file you just encrypted. `encrypt` is in-place, so there is normally
  no separate plaintext to remove at all.
- **Committing before encrypting.** The remote keeps history; encrypting after a plaintext push
  does not scrub it. Encrypt first, then commit.
- **Assuming a file is encrypted without checking.** Look for the sops metadata block
  (`sops:` / `sops_age__list_`) rather than trusting the filename.
