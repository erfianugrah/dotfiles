#!/usr/bin/env python3
"""skills-lint - keep the pi skill corpus honest.

Checks every <skills>/<name>/SKILL.md (default: ~/dotfiles/.pi/agent/skills):
  frontmatter parses; name == directory; description <= 500 chars (warn) and
  <= 1024 (error), starts with "Use when"/"Use ONLY when", no workflow verbs;
  body <= 500 lines; no smart punctuation; no @-force-load links; supporting
  files linked from SKILL.md; ~/paths exist; retired terms absent (config);
  docs-source names exist; sibling-skill refs exist; dated-lesson density;
  metadata.verified age; Claude Code symlink health.

Config: <skills>/.lint.json  {"retired": {"term": "hint"}, "allow": {"skill": ["term"]},
        "max_dates": 8, "verified_max_days": 90}
Exit 1 on any ERROR. `--json` for machine output, `--only skill` to scope.
"""
import sys, re, os, json, datetime, pathlib, argparse

try:
    import yaml
except ImportError:
    sys.exit("skills-lint needs PyYAML (python3 -m pip install pyyaml)")

ap = argparse.ArgumentParser()
ap.add_argument("--skills", default=os.path.expanduser("~/dotfiles/.pi/agent/skills"))
ap.add_argument("--claude", default=os.path.expanduser("~/dotfiles/.claude/skills"))
ap.add_argument("--topics", default=os.path.expanduser("~/.pi/agent/.docs-topics.json"))
ap.add_argument("--only", action="append", default=[])
ap.add_argument("--json", action="store_true")
args = ap.parse_args()

root = pathlib.Path(args.skills)
cfg = {}
cfgp = root / ".lint.json"
if cfgp.exists():
    cfg = json.loads(cfgp.read_text())
RETIRED = cfg.get("retired", {})
ALLOW = cfg.get("allow", {})
MAX_DATES = cfg.get("max_dates", 8)
VERIFIED_MAX = cfg.get("verified_max_days", 90)
TODAY = datetime.date.today()

topics = set()
if os.path.exists(args.topics):
    raw = json.load(open(args.topics)).get("topics", [])
    topics = {t if isinstance(t, str) else (t.get("name") or t.get("id") or t.get("slug")) for t in raw}

skills = sorted(p for p in root.iterdir() if p.is_dir() and (p / "SKILL.md").exists())
names = {p.name for p in skills}
SMART = {0x2014: "em dash", 0x2013: "en dash", 0x2026: "ellipsis", 0x2018: "smart quote", 0x2019: "smart quote", 0x201C: "smart quote", 0x201D: "smart quote", 0xA0: "nbsp"}
WORKFLOW = re.compile(r"(?i)\b(then|first|step \d|finally|after that|covers the|owns the|provides|handles|implements)\b")

findings = {}
def add(skill, level, msg):
    findings.setdefault(skill, []).append((level, msg))

def strip_fences(text):
    out, fence = [], False
    for ln in text.split("\n"):
        if ln.startswith("```"):
            fence = not fence; continue
        if not fence: out.append(ln)
    return "\n".join(out)

for p in skills:
    s = p.name
    if args.only and s not in args.only: continue
    t = (p / "SKILL.md").read_text()
    m = re.match(r"^---\n(.*?)\n---\n", t, re.S)
    if not m:
        add(s, "ERROR", "no YAML frontmatter"); continue
    try:
        fm = yaml.safe_load(m.group(1)) or {}
    except Exception as e:
        add(s, "ERROR", f"frontmatter does not parse: {e}"); continue
    body = t[m.end():]
    desc = str(fm.get("description", "")).strip()
    if fm.get("name") != s: add(s, "ERROR", f"name '{fm.get('name')}' != directory '{s}'")
    if not desc: add(s, "ERROR", "empty description")
    if len(desc) > 1024: add(s, "ERROR", f"description {len(desc)} chars > 1024 (pi refuses to load)")
    elif len(desc) > 500: add(s, "WARN", f"description {len(desc)} chars > 500 (paid every turn)")
    if not (desc.startswith("Use when") or desc.startswith("Use ONLY when")):
        add(s, "WARN", "description does not start with 'Use when'")
    if WORKFLOW.search(desc): add(s, "WARN", "description looks like a workflow/coverage summary, not triggers")
    nlines = body.count("\n")
    if nlines > 500: add(s, "WARN", f"body {nlines} lines > 500; move reference into a linked file")
    prose = strip_fences(t)
    for cp, label in SMART.items():
        c = t.count(chr(cp))
        if c: add(s, "ERROR", f"{c} x {label} (U+{cp:04X}); fold to ASCII")
    for at in re.findall(r"(?<![\w`/])@[\w./-]+\.(?:md|dot|js|ts|py)\b", prose):
        add(s, "WARN", f"@-link force-loads {at}; use a plain filename")
    for f in p.iterdir():
        if f.is_file() and f.name != "SKILL.md" and f.name not in t:
            add(s, "WARN", f"supporting file not referenced from SKILL.md: {f.name}")
    for hp in sorted(set(re.findall(r"(?<![\w/])(~/[\w./+-]+)", t))):
        cand = os.path.expanduser(hp.rstrip(".,);:"))
        if not os.path.exists(cand) and not any(ch in cand for ch in "<>*{}$"):
            add(s, "WARN", f"path does not exist: {hp}")
    for term, hint in RETIRED.items():
        if term in prose and term not in ALLOW.get(s, []):
            add(s, "ERROR", f"retired term '{term}': {hint}")
    dates = re.findall(r"\b20\d\d-\d\d-\d\d\b", body)
    if len(dates) > MAX_DATES:
        add(s, "WARN", f"{len(dates)} dated entries; fold lessons that became defaults")
    for line in t.splitlines():
        if re.search(r"(?i)docs? sources?", line):
            for d in re.findall(r"`([a-z0-9-]+)`", line):
                if topics and d not in topics and d not in names:
                    add(s, "WARN", f"docs source '{d}' is not a docs-mirror topic")
    for ref in set(re.findall(r"`([a-z][a-z0-9-]{3,})` skill", t)):
        if ref not in names: add(s, "ERROR", f"references missing skill '{ref}'")
    meta = fm.get("metadata") or {}
    ver = meta.get("verified") if isinstance(meta, dict) else None
    if ver:
        try:
            d = ver if isinstance(ver, datetime.date) else datetime.date.fromisoformat(str(ver))
            if (TODAY - d).days > VERIFIED_MAX: add(s, "WARN", f"metadata.verified {d} is older than {VERIFIED_MAX} days")
        except ValueError:
            add(s, "WARN", f"metadata.verified '{ver}' is not YYYY-MM-DD")

claude = pathlib.Path(args.claude)
if claude.exists():
    for l in claude.iterdir():
        if l.is_symlink() and not l.exists():
            add("(claude-allowlist)", "ERROR", f"dangling symlink {l.name} -> {os.readlink(l)}")

errors = sum(1 for v in findings.values() for lvl, _ in v if lvl == "ERROR")
warns = sum(1 for v in findings.values() for lvl, _ in v if lvl == "WARN")
if args.json:
    print(json.dumps({k: [{"level": l, "msg": m} for l, m in v] for k, v in findings.items()}, indent=1))
else:
    for k in sorted(findings):
        print(f"{k}:")
        for lvl, msg in findings[k]: print(f"  {lvl:5s} {msg}")
    print(f"\n{len(skills)} skills, {errors} errors, {warns} warnings")
sys.exit(1 if errors else 0)
