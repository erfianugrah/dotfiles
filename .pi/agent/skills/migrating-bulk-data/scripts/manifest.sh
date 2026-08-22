#!/bin/sh
# manifest.sh - independent sha256 proof: hash both sides locally, diff the
# manifests. Produces a permanent evidence artifact (unlike rsync -c, which
# leaves no proof file).
#
# Usage:
#   manifest.sh make  <tree_root> <out.sha256>     # run on each side
#   manifest.sh meta  <tree_root> <out_prefix>     # symlinks/hardlinks/empty-dirs/counts
#   manifest.sh diff  <old.sha256> <new.sha256>    # empty output = identical
#
# ALWAYS export LC_ALL=C on both sides before `make` - sort order differs
# across locales and produces spurious diffs.

set -eu
export LC_ALL=C

cmd=$1; shift
case "$cmd" in
  make)
    root=$1 out=$2
    # resolve out to absolute BEFORE cd, and refuse to write inside the tree
    # (a manifest inside the scanned tree pollutes this and every later run)
    out=$(realpath -m "$out")
    root_abs=$(realpath "$root")
    case "$out" in
      "$root_abs"/*) echo "error: output must be outside the scanned tree" >&2; exit 64;;
    esac
    cd "$root"
    find . -xdev -type f -print0 | sort -z | xargs -0 sha256sum > "$out"
    wc -l "$out"
    ;;
  meta)
    root=$1 out=$2
    find "$root" -xdev -type l -printf '%P -> %l\n' | sort > "$out.symlinks"
    find "$root" -xdev -type f -links +1 -printf '%P\n' | sort > "$out.hardlinked-files"
    find "$root" -xdev -type d -empty -printf '%P\n' | sort > "$out.emptydirs"
    find "$root" -xdev -type f | wc -l > "$out.filecount"
    ;;
  diff)
    diff "$1" "$2" && echo "MANIFEST MATCH: $1 == $2"
    ;;
  *)
    echo "usage: manifest.sh make|meta|diff ..." >&2
    exit 64
    ;;
esac