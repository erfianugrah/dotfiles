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
// Exit 1 if any DRIFT found. Usage: stow-drift [--verbose]
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

	var drift, missing []string
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
	for _, d := range drift {
		fmt.Fprintln(out, "DRIFT ", d)
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
	fmt.Fprintf(out, "---\n%d linked, %d drifted, %d missing%s\n",
		linked, len(drift), len(missing), tail)
	if len(drift) > 0 {
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
