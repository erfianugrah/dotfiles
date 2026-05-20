// helpers.test.ts — bun:test smoke tests for superpowers plugin helpers.
//
// Run with: bun test lib/superpowers/helpers.test.ts
//
// Covers pure helpers (decideInjection, buildBootstrap, alreadyInjected) and
// integration with the plugin's messages.transform hook.

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import {
  alreadyInjected,
  buildBootstrap,
  decideInjection,
  FORCE_TOKEN,
  INTENT_REGEX,
} from "./helpers"
import { SuperpowersPlugin } from "../../plugins/superpowers"

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("decideInjection", () => {
  test("returns 'intent' on build/implement/debug verbs", () => {
    expect(decideInjection("implement a retry function")).toBe("intent")
    expect(decideInjection("build the auth flow")).toBe("intent")
    expect(decideInjection("fix the bug in login")).toBe("intent")
    expect(decideInjection("debug this crash")).toBe("intent")
    expect(decideInjection("refactor the parser")).toBe("intent")
    expect(decideInjection("add a feature for X")).toBe("intent")
    expect(decideInjection("write unit tests for foo")).toBe("intent")
    expect(decideInjection("create a new component")).toBe("intent")
    expect(decideInjection("TDD this module")).toBe("intent")
  })

  test("returns 'skip' on Q&A / read-only prompts (no false positives)", () => {
    expect(decideInjection("how good is this repo?")).toBe("skip")
    expect(decideInjection("explain this code")).toBe("skip")
    expect(decideInjection("what does this function do")).toBe("skip")
    expect(decideInjection("show me the architecture")).toBe("skip")
    expect(decideInjection("write a summary of this paper")).toBe("skip")
    expect(decideInjection("add some salt to the recipe")).toBe("skip")
    expect(decideInjection("")).toBe("skip")
  })

  test("returns 'forced' when message contains <superpowers>", () => {
    expect(decideInjection("<superpowers> explain this")).toBe("forced")
    expect(decideInjection("just a chat <SUPERPOWERS>")).toBe("forced")
  })

  test("forced beats intent (forced takes precedence)", () => {
    expect(decideInjection("<superpowers> implement X")).toBe("forced")
  })
})

describe("buildBootstrap", () => {
  const SAMPLE = `---
name: using-superpowers
description: bootstrap skill
---

You have superpowers. Use them wisely.`

  test("strips YAML frontmatter", () => {
    const out = buildBootstrap(SAMPLE)
    expect(out).not.toContain("name: using-superpowers")
    expect(out).not.toContain("---\nname:")
    expect(out).toContain("You have superpowers. Use them wisely.")
  })

  test("wraps body in <superpowers-methodology> tags", () => {
    const out = buildBootstrap(SAMPLE)
    expect(out).toContain("<superpowers-methodology>")
    expect(out).toContain("</superpowers-methodology>")
  })

  test("includes injection marker for idempotency", () => {
    const out = buildBootstrap(SAMPLE)
    expect(out).toContain("superpowers-methodology-injected")
  })

  test("appends tool-mapping block", () => {
    const out = buildBootstrap(SAMPLE)
    expect(out).toContain("TodoWrite")
    expect(out).toContain("todowrite")
    expect(out).toContain("opencode subagent")
  })

  test("handles content without frontmatter", () => {
    const out = buildBootstrap("plain body, no frontmatter")
    expect(out).toContain("plain body, no frontmatter")
    expect(out).toContain("<superpowers-methodology>")
  })
})

describe("alreadyInjected", () => {
  test("true when any text part contains marker", () => {
    expect(
      alreadyInjected([
        { type: "text", text: "<!-- superpowers-methodology-injected -->\nfoo" },
      ]),
    ).toBe(true)
  })

  test("false when no parts contain marker", () => {
    expect(alreadyInjected([{ type: "text", text: "hello world" }])).toBe(false)
    expect(alreadyInjected([])).toBe(false)
  })

  test("ignores non-text parts", () => {
    expect(
      alreadyInjected([
        { type: "image" } as { type: string; text?: string },
        { type: "text", text: "hello" },
      ]),
    ).toBe(false)
  })
})

// ── regex hygiene ────────────────────────────────────────────────────────────

describe("INTENT_REGEX hygiene", () => {
  test("doesn't false-positive on 'write a summary'", () => {
    expect(INTENT_REGEX.test("write a summary of this paper")).toBe(false)
  })

  test("doesn't false-positive on 'add a comment'", () => {
    expect(INTENT_REGEX.test("add a comment explaining this")).toBe(false)
  })

  test("matches 'write tests'", () => {
    expect(INTENT_REGEX.test("write tests for the retry function")).toBe(true)
    expect(INTENT_REGEX.test("write a unit test")).toBe(true)
  })
})

describe("FORCE_TOKEN", () => {
  test("case-insensitive", () => {
    expect(FORCE_TOKEN.test("<superpowers>")).toBe(true)
    expect(FORCE_TOKEN.test("<SUPERPOWERS>")).toBe(true)
    expect(FORCE_TOKEN.test("<SuperPowers>")).toBe(true)
  })
})

// ── integration: plugin hooks ────────────────────────────────────────────────

describe("plugin integration", () => {
  const realBootstrap = resolve(
    process.env.HOME ?? "",
    ".config/opencode/skills/superpowers/using-superpowers/SKILL.md",
  )
  const haveRealBootstrap = existsSync(realBootstrap)

  test("kill switch (SUPERPOWERS_OFF=1) returns empty hooks", async () => {
    const prev = process.env.SUPERPOWERS_OFF
    process.env.SUPERPOWERS_OFF = "1"
    try {
      const hooks = await SuperpowersPlugin({} as Parameters<typeof SuperpowersPlugin>[0])
      expect(Object.keys(hooks)).toHaveLength(0)
    } finally {
      if (prev === undefined) delete process.env.SUPERPOWERS_OFF
      else process.env.SUPERPOWERS_OFF = prev
    }
  })

  test("injects on intent match", async () => {
    if (!haveRealBootstrap) {
      console.warn(`  skip: bootstrap not synced at ${realBootstrap}`)
      return
    }
    const hooks = await SuperpowersPlugin({} as Parameters<typeof SuperpowersPlugin>[0])
    const fn = hooks["experimental.chat.messages.transform"]
    expect(fn).toBeDefined()

    const output = {
      messages: [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "implement a retry function" }],
        },
      ],
    } as Parameters<NonNullable<typeof fn>>[1]

    await fn!({} as Parameters<NonNullable<typeof fn>>[0], output)

    const parts = output.messages[0].parts as { type: string; text?: string }[]
    expect(parts.length).toBeGreaterThanOrEqual(2)
    expect(parts[0].text).toContain("superpowers-methodology")
    expect(parts[1].text).toBe("implement a retry function")
  })

  test("skips on Q&A (no intent match)", async () => {
    if (!haveRealBootstrap) return
    const hooks = await SuperpowersPlugin({} as Parameters<typeof SuperpowersPlugin>[0])
    const fn = hooks["experimental.chat.messages.transform"]!

    const output = {
      messages: [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "how good is this repo?" }],
        },
      ],
    } as Parameters<typeof fn>[1]

    await fn({} as Parameters<typeof fn>[0], output)

    expect(output.messages[0].parts.length).toBe(1)
    expect((output.messages[0].parts[0] as { text: string }).text).toBe(
      "how good is this repo?",
    )
  })

  test("idempotent within one call — text marker guard", async () => {
    if (!haveRealBootstrap) return
    const hooks = await SuperpowersPlugin({} as Parameters<typeof SuperpowersPlugin>[0])
    const fn = hooks["experimental.chat.messages.transform"]!

    const output = {
      messages: [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "implement feature X" }],
        },
      ],
    } as Parameters<typeof fn>[1]

    await fn({} as Parameters<typeof fn>[0], output)
    const lenAfterFirst = output.messages[0].parts.length

    await fn({} as Parameters<typeof fn>[0], output)
    const lenAfterSecond = output.messages[0].parts.length

    expect(lenAfterSecond).toBe(lenAfterFirst)
  })

  test("idempotent across DB reloads — session-ID guard suppresses re-inject", async () => {
    // Simulates opencode reloading messages from DB between agent steps:
    // the parts array no longer carries the marker, but the same sessionID
    // does — so we must not inject again.
    if (!haveRealBootstrap) return
    const hooks = await SuperpowersPlugin({} as Parameters<typeof SuperpowersPlugin>[0])
    const fn = hooks["experimental.chat.messages.transform"]!
    const sessionID = `test-session-${Date.now()}`

    const mkOutput = () =>
      ({
        messages: [
          {
            info: { role: "user", sessionID },
            parts: [{ type: "text", text: "implement feature Y" }],
          },
        ],
      }) as Parameters<typeof fn>[1]

    const firstOutput = mkOutput()
    await fn({} as Parameters<typeof fn>[0], firstOutput)
    expect(firstOutput.messages[0].parts.length).toBe(2) // injected

    // Simulate DB reload: brand-new output object with pristine parts.
    const secondOutput = mkOutput()
    await fn({} as Parameters<typeof fn>[0], secondOutput)
    expect(secondOutput.messages[0].parts.length).toBe(1) // NOT re-injected
  })

  test("session-ID guard caches 'skip' decisions too", async () => {
    if (!haveRealBootstrap) return
    const hooks = await SuperpowersPlugin({} as Parameters<typeof SuperpowersPlugin>[0])
    const fn = hooks["experimental.chat.messages.transform"]!
    const sessionID = `test-skip-${Date.now()}`

    const mkOutput = () =>
      ({
        messages: [
          {
            info: { role: "user", sessionID },
            parts: [{ type: "text", text: "what is 2+2" }],
          },
        ],
      }) as Parameters<typeof fn>[1]

    const out1 = mkOutput()
    await fn({} as Parameters<typeof fn>[0], out1)
    expect(out1.messages[0].parts.length).toBe(1) // skipped

    const out2 = mkOutput()
    await fn({} as Parameters<typeof fn>[0], out2)
    expect(out2.messages[0].parts.length).toBe(1) // still skipped (cached)
  })

  test("forced injection via <superpowers> token", async () => {
    if (!haveRealBootstrap) return
    const hooks = await SuperpowersPlugin({} as Parameters<typeof SuperpowersPlugin>[0])
    const fn = hooks["experimental.chat.messages.transform"]!

    const output = {
      messages: [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "<superpowers> explain this" }],
        },
      ],
    } as Parameters<typeof fn>[1]

    await fn({} as Parameters<typeof fn>[0], output)
    const parts = output.messages[0].parts as { type: string; text?: string }[]
    expect(parts.length).toBeGreaterThanOrEqual(2)
    expect(parts[0].text).toContain("superpowers-methodology")
  })

  test("config hook registers skills path", async () => {
    if (!haveRealBootstrap) return
    const hooks = await SuperpowersPlugin({} as Parameters<typeof SuperpowersPlugin>[0])
    const configFn = hooks.config
    expect(configFn).toBeDefined()

    const cfg: { skills?: { paths?: string[] } } = {}
    await configFn!(cfg as Parameters<NonNullable<typeof configFn>>[0])
    expect(cfg.skills?.paths).toBeDefined()
    expect(cfg.skills!.paths!.length).toBeGreaterThan(0)
    expect(cfg.skills!.paths![0]).toContain("superpowers")
  })

  test("config hook is idempotent", async () => {
    if (!haveRealBootstrap) return
    const hooks = await SuperpowersPlugin({} as Parameters<typeof SuperpowersPlugin>[0])
    const configFn = hooks.config!

    const cfg: { skills?: { paths?: string[] } } = {}
    await configFn(cfg as Parameters<typeof configFn>[0])
    const lenAfterFirst = cfg.skills!.paths!.length

    await configFn(cfg as Parameters<typeof configFn>[0])
    expect(cfg.skills!.paths!.length).toBe(lenAfterFirst)
  })
})

// ── edge cases (no real bootstrap required) ──────────────────────────────────

describe("messages.transform edge cases", () => {
  test("empty messages array — no error", async () => {
    const hooks = await SuperpowersPlugin({} as Parameters<typeof SuperpowersPlugin>[0])
    const fn = hooks["experimental.chat.messages.transform"]!
    const output = { messages: [] } as Parameters<typeof fn>[1]
    await expect(fn({} as Parameters<typeof fn>[0], output)).resolves.toBeUndefined()
    expect(output.messages.length).toBe(0)
  })

  test("user message with no parts — no error, no inject", async () => {
    const hooks = await SuperpowersPlugin({} as Parameters<typeof SuperpowersPlugin>[0])
    const fn = hooks["experimental.chat.messages.transform"]!
    const output = {
      messages: [
        { info: { role: "user", sessionID: `empty-parts-${Date.now()}` }, parts: [] },
      ],
    } as Parameters<typeof fn>[1]
    await fn({} as Parameters<typeof fn>[0], output)
    expect(output.messages[0].parts.length).toBe(0)
  })

  test("user message with non-text parts only (image) — no inject", async () => {
    const hooks = await SuperpowersPlugin({} as Parameters<typeof SuperpowersPlugin>[0])
    const fn = hooks["experimental.chat.messages.transform"]!
    const output = {
      messages: [
        {
          info: { role: "user", sessionID: `image-only-${Date.now()}` },
          parts: [{ type: "image" } as { type: string }],
        },
      ],
    } as Parameters<typeof fn>[1]
    await fn({} as Parameters<typeof fn>[0], output)
    expect(output.messages[0].parts.length).toBe(1)
  })

  test("only assistant messages, no user — no error", async () => {
    const hooks = await SuperpowersPlugin({} as Parameters<typeof SuperpowersPlugin>[0])
    const fn = hooks["experimental.chat.messages.transform"]!
    const output = {
      messages: [
        { info: { role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
      ],
    } as Parameters<typeof fn>[1]
    await fn({} as Parameters<typeof fn>[0], output)
    expect(output.messages[0].parts.length).toBe(1)
  })

  test("whitespace-only user message — skipped (no intent)", async () => {
    expect(decideInjection("   \n  \t  ")).toBe("skip")
  })

  test("unicode in user message — regex still works", () => {
    expect(decideInjection("implement émigré café")).toBe("intent")
    expect(decideInjection("debug the 漢字 parser")).toBe("intent")
  })

  test("force token at end of message", () => {
    expect(decideInjection("explain this <superpowers>")).toBe("forced")
  })

  test("force token in middle of message", () => {
    expect(decideInjection("hey <superpowers> btw")).toBe("forced")
  })
})
