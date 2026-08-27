// stow-drift - detect files in $HOME that should be stow symlinks but are real files.
//
// Walks the dotfiles tree (respecting .stow-local-ignore), maps each source
// file to its expected $HOME target, and classifies:
//
//	LINKED    target resolves (through symlinks, incl. folded dir links) to src
//	MISSING   target does not exist
//	DRIFT     target exists as a real file, or a link pointing elsewhere
//
// Stow-ignored real-file exceptions listed in compareOnly (e.g. opencode.json,
// which pi-mcp-bridge reads from $HOME while dotfiles tracks the backup copy)
// get a byte-compare pass instead: identical counts as LINKED, differing is
// DRIFT, missing live copy is MISSING.
//
// MISSING is normally benign (a file that belongs to another machine's profile,
// or simply not stowed yet), so it is hidden and non-fatal. The exception is
// liveTrees: directories a harness auto-loads BY DIRECTORY LISTING. A repo file
// there with no live symlink is DEAD CONFIG that reads as working - the code is
// committed, tests pass, and the thing never runs. That is UNLINKED: always
// printed, always exit 1.
//
// Incident that added it (2026-08-27): ai-tell-guard.ts was written, tested,
// committed and documented, but never stow-linked. `~/.pi/agent/extensions/` is
// a real dir of per-file symlinks (only `lib/` is a folded dir link, which
// masked it), so the guard could not have loaded on any restart. stow-drift
// already knew - it reported "1 missing", hidden, exit 0.
//
// Exit 1 if any DRIFT or UNLINKED found. Usage: stow-drift [--verbose]
package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// liveTrees are repo dirs whose LIVE counterpart a harness enumerates at
// startup: a file present in the repo but absent from $HOME is not "not yet
// installed", it is committed code that cannot run. Each entry is a repo-
// relative dir prefix; only direct children are checked, because that is the
// depth the loaders scan (pi requires a default factory from every top-level
// extension file and deliberately ignores lib/ and index.ts, so a helper under
// extensions/lib/ is NOT a live-tree member).
//
// Deliberately NOT listed: .pi/agent/skills (dir-level link, and per-skill
// symlinks into .claude/skills are curated by hand - see the agent-surface
// routing rules about never promoting private-corpus skills to the work
// harness), and .claude/hooks (a folded dir link, so children cannot go
// missing individually).
var liveTrees = []string{
	".pi/agent/extensions",
	".pi/agent/prompts",
}

// inLiveTree reports whether rel is a DIRECT child of a liveTrees dir.
func inLiveTree(rel string) bool {
	dir := filepath.Dir(rel)
	for _, t := range liveTrees {
		if dir == t {
			return true
		}
	}
	return false
}

// compareOnly lists stow-ignored real-file exceptions (see .stow-local-ignore)
// whose live $HOME copy must stay content-identical to the tracked dotfiles
// copy. The normal walk skips them via the ignore file, so they get their own
// compare pass in run(). Empty since the opencode.json exception retired with
// opencode (2026-08-15); the mechanism stays for the next real-file exception -
// add its repo-relative path here.
var compareOnly []string

const (
	Linked  = "LINKED"
	Missing = "MISSING"
	Drift   = "DRIFT"
)

// classify compares a dotfiles source path with its $HOME target.
// realpath resolution handles stow's folded directory links: a file inside a
// symlinked dir (e.g. ~/.pi/agent/skills -> dotfiles/.../skills) counts as
// LINKED even though the file itself is not a symlink.
func classify(src, dst string) string {
	if _, err := os.Lstat(dst); os.IsNotExist(err) {
		return Missing
	}
	srcReal, err1 := filepath.EvalSymlinks(src)
	dstReal, err2 := filepath.EvalSymlinks(dst)
	if err1 == nil && err2 == nil && srcReal == dstReal {
		return Linked
	}
	if fi, err := os.Lstat(dst); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return Drift + ":link-points-elsewhere"
	}
	return Drift + ":real-file"
}

func loadIgnore(path string) ([]*regexp.Regexp, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var pats []*regexp.Regexp
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		re, err := regexp.Compile(line)
		if err != nil {
			return nil, fmt.Errorf(".stow-local-ignore %q: %w", line, err)
		}
		pats = append(pats, re)
	}
	return pats, nil
}

func ignored(rel string, pats []*regexp.Regexp) bool {
	for _, p := range pats {
		if p.MatchString(rel) {
			return true
		}
	}
	return false
}

// run walks dotfiles, classifies every non-ignored file, prints the report to
// out, and returns the process exit code (1 if any drift).
func run(dotfiles, home string, verbose bool, out io.Writer) int {
	pats, err := loadIgnore(filepath.Join(dotfiles, ".stow-local-ignore"))
	if err != nil {
		fmt.Fprintln(out, "error:", err)
		return 2
	}
	dotfiles, _ = filepath.Abs(dotfiles)
	home, _ = filepath.Abs(home)

	var drift, missing, unlinked []string
	linked := 0

	err = filepath.WalkDir(dotfiles, func(src string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(dotfiles, src)
		if err != nil {
			return err
		}
		if rel == ".stow-local-ignore" || ignored(rel, pats) {
			return nil
		}
		dst := filepath.Join(home, rel)
		switch r := classify(src, dst); {
		case r == Linked:
			linked++
		case r == Missing && inLiveTree(rel):
			unlinked = append(unlinked, rel)
		case r == Missing:
			missing = append(missing, rel)
		default:
			drift = append(drift, rel+"  ("+r+")")
		}
		return nil
	})
	if err != nil {
		fmt.Fprintln(out, "error:", err)
		return 2
	}

	// Real-file exceptions: byte-compare live vs repo copy.
	for _, rel := range compareOnly {
		srcB, srcErr := os.ReadFile(filepath.Join(dotfiles, rel))
		dstB, dstErr := os.ReadFile(filepath.Join(home, rel))
		switch {
		case os.IsNotExist(srcErr) && os.IsNotExist(dstErr):
			// absent both sides - nothing to keep in sync
		case dstErr != nil:
			missing = append(missing, rel+"  (real-file-exception)")
		case srcErr != nil:
			drift = append(drift, rel+"  (real-file-exception:no-repo-copy)")
		case !bytes.Equal(srcB, dstB):
			drift = append(drift, rel+"  (real-file-exception:content-differs)")
		default:
			linked++
		}
	}

	sort.Strings(drift)
	sort.Strings(missing)
	sort.Strings(unlinked)
	for _, d := range drift {
		fmt.Fprintln(out, "DRIFT ", d)
	}
	// Never hidden: an unlinked file in an auto-loaded tree is silently inert.
	for _, u := range unlinked {
		fmt.Fprintln(out, "UNLINKED ", u, " (in an auto-loaded tree - never runs; fix: cd ~ && stow -d ~/dotfiles -t ~ -v .)")
	}
	if verbose {
		for _, m := range missing {
			fmt.Fprintln(out, "MISS  ", m)
		}
	}
	tail := ""
	if !verbose && len(missing) > 0 {
		tail = " (MISS hidden, --verbose to show)"
	}
	fmt.Fprintf(out, "---\n%d linked, %d drifted, %d unlinked, %d missing%s\n",
		linked, len(drift), len(unlinked), len(missing), tail)
	if len(drift) > 0 || len(unlinked) > 0 {
		return 1
	}
	return 0
}

func main() {
	verbose := false
	for _, a := range os.Args[1:] {
		if a == "--verbose" {
			verbose = true
		}
	}
	dotfiles := os.Getenv("DOTFILES_DIR")
	if dotfiles == "" {
		home, _ := os.UserHomeDir()
		dotfiles = filepath.Join(home, "dotfiles")
	}
	home, _ := os.UserHomeDir()
	os.Exit(run(dotfiles, home, verbose, os.Stdout))
}
