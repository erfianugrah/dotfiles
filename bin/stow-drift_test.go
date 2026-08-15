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
		"2 linked, 2 drifted, 1 missing",
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
func mkRealFileTree(t *testing.T) (dotfiles, home string) {
	t.Helper()
	root := t.TempDir()
	dotfiles = filepath.Join(root, "dotfiles")
	home = filepath.Join(root, "home")
	for _, d := range []string{
		filepath.Join(dotfiles, ".config", "opencode"),
		filepath.Join(home, ".config", "opencode"),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dotfiles, ".stow-local-ignore"),
		[]byte(".config/opencode/opencode.json\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dotfiles, home
}

func TestCompareOnly(t *testing.T) {
	rel := compareOnly[0]
	write := func(root, s string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, rel), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("identical counts as linked", func(t *testing.T) {
		dotfiles, home := mkRealFileTree(t)
		write(dotfiles, "{}")
		write(home, "{}")
		var buf bytes.Buffer
		if code := run(dotfiles, home, true, &buf); code != 0 {
			t.Errorf("exit = %d, want 0\n%s", code, buf.String())
		}
		if !strings.Contains(buf.String(), "1 linked, 0 drifted, 0 missing") {
			t.Errorf("in-sync exception not counted as linked\n%s", buf.String())
		}
	})

	t.Run("content divergence is drift", func(t *testing.T) {
		dotfiles, home := mkRealFileTree(t)
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
		dotfiles, home := mkRealFileTree(t)
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
		dotfiles, home := mkRealFileTree(t)
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
