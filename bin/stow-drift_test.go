package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mkTree builds a throwaway dotfiles+home pair:
//
//	dotfiles/.zshrc              -> home/.zshrc (direct symlink)
//	dotfiles/.app/config.toml    -> home/.app (folded dir symlink)
//	dotfiles/.drifted            -> home/.drifted (real file, DRIFT)
//	dotfiles/.wrong-link         -> home/.wrong-link (symlink to /etc/hostname)
//	dotfiles/.missing            -> (absent in home)
//	dotfiles/.stow-local-ignore  -> ignores ".secret"
//	dotfiles/.secret             -> home/.secret (real file, but ignored)
func mkTree(t *testing.T) (dotfiles, home string) {
	t.Helper()
	root := t.TempDir()
	dotfiles = filepath.Join(root, "dotfiles")
	home = filepath.Join(root, "home")
	for _, d := range []string{
		filepath.Join(dotfiles, ".app"),
		filepath.Join(home),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(p, s string) {
		t.Helper()
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	link := func(old, new string) {
		t.Helper()
		if err := os.Symlink(old, new); err != nil {
			t.Fatal(err)
		}
	}

	write(filepath.Join(dotfiles, ".zshrc"), "zsh")
	link(filepath.Join(dotfiles, ".zshrc"), filepath.Join(home, ".zshrc"))

	write(filepath.Join(dotfiles, ".app", "config.toml"), "app")
	link(filepath.Join(dotfiles, ".app"), filepath.Join(home, ".app")) // folded

	write(filepath.Join(dotfiles, ".drifted"), "source")
	write(filepath.Join(home, ".drifted"), "drifted")

	write(filepath.Join(dotfiles, ".wrong-link"), "source")
	link("/etc/hostname", filepath.Join(home, ".wrong-link"))

	write(filepath.Join(dotfiles, ".missing"), "gone")

	write(filepath.Join(dotfiles, ".stow-local-ignore"), ".secret\n")
	write(filepath.Join(dotfiles, ".secret"), "x")
	write(filepath.Join(home, ".secret"), "y")

	return dotfiles, home
}

func TestRun(t *testing.T) {
	dotfiles, home := mkTree(t)
	var buf bytes.Buffer
	code := run(dotfiles, home, true, &buf)
	out := buf.String()

	if code != 1 {
		t.Errorf("exit = %d, want 1 (drift present)", code)
	}
	for _, want := range []string{
		"DRIFT  .drifted  (DRIFT:real-file)",
		"DRIFT  .wrong-link  (DRIFT:link-points-elsewhere)",
		"MISS   .missing",
		"2 linked, 2 drifted, 0 unlinked, 1 missing",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q\n--- got ---\n%s", want, out)
		}
	}
	if strings.Contains(out, ".secret") {
		t.Errorf("ignored .secret appeared in output\n%s", out)
	}
	if strings.Contains(out, "config.toml") || strings.Contains(out, ".zshrc") {
		t.Errorf("linked files appeared in output\n%s", out)
	}
}

func TestRunClean(t *testing.T) {
	dotfiles, home := mkTree(t)
	// fix the drift: replace real files with links
	for _, rel := range []string{".drifted", ".wrong-link"} {
		os.Remove(filepath.Join(home, rel))
		if err := os.Symlink(filepath.Join(dotfiles, rel), filepath.Join(home, rel)); err != nil {
			t.Fatal(err)
		}
	}
	var buf bytes.Buffer
	code := run(dotfiles, home, false, &buf)
	if code != 0 {
		t.Errorf("exit = %d, want 0\n%s", code, buf.String())
	}
	if !strings.Contains(buf.String(), "MISS hidden") {
		t.Errorf("non-verbose run should hide MISS\n%s", buf.String())
	}
}

// Regression: the 2026-08-27 ai-tell-guard incident. A repo file inside an
// auto-loaded tree (.pi/agent/extensions) with no live symlink is committed
// code that can never run, so it must be LOUD (printed unconditionally) and
// FATAL (exit 1) - not folded into the hidden, non-fatal MISS bucket.
func TestUnlinkedInLiveTree(t *testing.T) {
	dotfiles, home := mkTree(t)
	extDir := filepath.Join(dotfiles, ".pi", "agent", "extensions")
	if err := os.MkdirAll(filepath.Join(extDir, "lib"), 0o755); err != nil {
		t.Fatal(err)
	}
	// unlinked top-level extension: fatal
	if err := os.WriteFile(filepath.Join(extDir, "new-guard.ts"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// unlinked helper under lib/: NOT a live-tree member (loader ignores lib/)
	if err := os.WriteFile(filepath.Join(extDir, "lib", "helper-core.ts"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	code := run(dotfiles, home, false, &buf)
	out := buf.String()

	if code != 1 {
		t.Errorf("exit = %d, want 1 (unlinked file in an auto-loaded tree)\n%s", code, out)
	}
	if !strings.Contains(out, "UNLINKED") || !strings.Contains(out, "new-guard.ts") {
		t.Errorf("want UNLINKED line naming new-guard.ts (non-verbose)\n%s", out)
	}
	if !strings.Contains(out, "stow -d") {
		t.Errorf("UNLINKED line must name the fix command\n%s", out)
	}
	if strings.Contains(out, "helper-core.ts") {
		t.Errorf("lib/ helper must NOT be treated as a live-tree member\n%s", out)
	}
}

// Once linked, the same tree is clean - guards against a rule that can never
// be satisfied.
func TestLinkedInLiveTreeIsClean(t *testing.T) {
	dotfiles, home := mkTree(t)
	// mkTree plants deliberate DRIFT; this test is about the live-tree rule
	// alone, so repair it first or the exit code proves nothing.
	for _, r := range []string{".drifted", ".wrong-link"} {
		os.Remove(filepath.Join(home, r))
		if err := os.Symlink(filepath.Join(dotfiles, r), filepath.Join(home, r)); err != nil {
			t.Fatal(err)
		}
	}
	rel := filepath.Join(".pi", "agent", "extensions", "new-guard.ts")
	if err := os.MkdirAll(filepath.Dir(filepath.Join(dotfiles, rel)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dotfiles, rel), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(filepath.Join(home, rel)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dotfiles, rel), filepath.Join(home, rel)); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if code := run(dotfiles, home, false, &buf); code != 0 {
		t.Errorf("exit = %d, want 0 once linked\n%s", code, buf.String())
	}
	if strings.Contains(buf.String(), "UNLINKED") {
		t.Errorf("linked file must not be reported UNLINKED\n%s", buf.String())
	}
}

func TestInLiveTree(t *testing.T) {
	yes := []string{
		".pi/agent/extensions/foo.ts",
		".pi/agent/prompts/tool-routing.md",
	}
	no := []string{
		".pi/agent/extensions/lib/foo-core.ts",
		".pi/agent/extensions/tests/foo.test.ts",
		".pi/agent/skills/erfi-voice/SKILL.md",
		".zshrc",
		".claude/hooks/ascii-guard.ts",
	}
	for _, r := range yes {
		if !inLiveTree(r) {
			t.Errorf("inLiveTree(%q) = false, want true", r)
		}
	}
	for _, r := range no {
		if inLiveTree(r) {
			t.Errorf("inLiveTree(%q) = true, want false", r)
		}
	}
}

func TestClassifyFolded(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "dotfiles", ".d", "f")
	os.MkdirAll(filepath.Dir(src), 0o755)
	os.WriteFile(src, []byte("x"), 0o644)
	os.MkdirAll(filepath.Join(root, "home"), 0o755)
	if err := os.Symlink(filepath.Join(root, "dotfiles", ".d"), filepath.Join(root, "home", ".d")); err != nil {
		t.Fatal(err)
	}
	if got := classify(src, filepath.Join(root, "home", ".d", "f")); got != Linked {
		t.Errorf("folded dir link: got %s, want LINKED", got)
	}
}

// mkRealFileTree builds the minimal tree for compareOnly scenarios: the
// exception path is stow-ignored so the walk skips it, leaving the
// byte-compare pass as the only reporter for it.
func mkRealFileTree(t *testing.T, rel string) (dotfiles, home string) {
	t.Helper()
	root := t.TempDir()
	dotfiles = filepath.Join(root, "dotfiles")
	home = filepath.Join(root, "home")
	for _, d := range []string{
		filepath.Join(dotfiles, filepath.Dir(rel)),
		filepath.Join(home, filepath.Dir(rel)),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dotfiles, ".stow-local-ignore"),
		[]byte(rel+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dotfiles, home
}

func TestCompareOnly(t *testing.T) {
	// The production list is empty since the opencode.json exception retired
	// with opencode (2026-08-15); inject a synthetic exception to exercise
	// the mechanism.
	saved := compareOnly
	compareOnly = []string{".fake/exception.json"}
	t.Cleanup(func() { compareOnly = saved })
	rel := compareOnly[0]
	write := func(root, s string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, rel), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("identical counts as linked", func(t *testing.T) {
		dotfiles, home := mkRealFileTree(t, rel)
		write(dotfiles, "{}")
		write(home, "{}")
		var buf bytes.Buffer
		if code := run(dotfiles, home, true, &buf); code != 0 {
			t.Errorf("exit = %d, want 0\n%s", code, buf.String())
		}
		if !strings.Contains(buf.String(), "1 linked, 0 drifted, 0 unlinked, 0 missing") {
			t.Errorf("in-sync exception not counted as linked\n%s", buf.String())
		}
	})

	t.Run("content divergence is drift", func(t *testing.T) {
		dotfiles, home := mkRealFileTree(t, rel)
		write(dotfiles, "{\"a\":1}")
		write(home, "{\"a\":2}")
		var buf bytes.Buffer
		code := run(dotfiles, home, true, &buf)
		if code != 1 {
			t.Errorf("exit = %d, want 1", code)
		}
		if !strings.Contains(buf.String(), "content-differs") {
			t.Errorf("output missing content-differs\n%s", buf.String())
		}
	})

	t.Run("live copy missing is miss not drift", func(t *testing.T) {
		dotfiles, home := mkRealFileTree(t, rel)
		write(dotfiles, "{}")
		var buf bytes.Buffer
		code := run(dotfiles, home, true, &buf)
		if code != 0 {
			t.Errorf("exit = %d, want 0 (missing is not drift)", code)
		}
		if !strings.Contains(buf.String(), rel+"  (real-file-exception)") {
			t.Errorf("output missing real-file-exception MISS\n%s", buf.String())
		}
	})

	t.Run("repo copy missing is drift", func(t *testing.T) {
		dotfiles, home := mkRealFileTree(t, rel)
		write(home, "{}")
		var buf bytes.Buffer
		code := run(dotfiles, home, true, &buf)
		if code != 1 {
			t.Errorf("exit = %d, want 1", code)
		}
		if !strings.Contains(buf.String(), "no-repo-copy") {
			t.Errorf("output missing no-repo-copy\n%s", buf.String())
		}
	})
}

func TestLoadIgnoreBadRegex(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, ".stow-local-ignore")
	os.WriteFile(p, []byte("[unclosed\n"), 0o644)
	if _, err := loadIgnore(p); err == nil {
		t.Error("expected error on bad regex")
	}
}
