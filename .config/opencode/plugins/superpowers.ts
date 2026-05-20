// superpowers.ts — conditional bootstrap injection for obra/superpowers skills.
//
// Two hooks:
//   1. config        : registers ~/.config/opencode/skills/superpowers as a skills path
//   2. messages.transform : injects using-superpowers methodology into first user message
//                           IFF that message matches the intent regex (or contains <superpowers>)
//
// Token economy: opencode auto-includes skill name+description in system prompt
// for every discovered skill (~80 chars × 14 = ~280 tokens/turn). The full
// bootstrap (~1500 tokens) is injected only on build/debug intent, once per session.
//
// Controls:
//   SUPERPOWERS_OFF=1        plugin inactive (kill switch)
//   SUPERPOWERS_DEBUG=1      log injection decisions to stderr
//   <superpowers> in msg     force inject regardless of intent regex
//
// Pure logic lives in ../lib/superpowers/helpers.ts (kept out of plugins/ so
// opencode's loader doesn't try to treat it as a plugin).

import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

import {
  alreadyInjected,
  buildBootstrap,
  decideInjection,
} from "../lib/superpowers/helpers"

const SKILLS_DIR = resolve(homedir(), ".config/opencode/skills/superpowers")
const BOOTSTRAP_PATH = resolve(SKILLS_DIR, "using-superpowers/SKILL.md")

// Env vars read lazily so tests can toggle them between calls.
const isOff = () => process.env.SUPERPOWERS_OFF === "1"
const isDebug = () => process.env.SUPERPOWERS_DEBUG === "1"

let cachedBootstrap: string | null | undefined = undefined

// Session-ID set used to suppress per-step re-injection. opencode's
// prompt.ts reloads messages from DB at every agent step, dropping any
// previous mutation we made to the parts array. A text-content marker can't
// survive that, but session IDs do — track which sessions we've handled and
// short-circuit on subsequent calls in the same process.
const injectedSessions = new Set<string>()

function loadBootstrapFromDisk(): string | null {
  if (cachedBootstrap !== undefined) return cachedBootstrap
  if (!existsSync(BOOTSTRAP_PATH)) {
    cachedBootstrap = null
    return null
  }
  cachedBootstrap = buildBootstrap(readFileSync(BOOTSTRAP_PATH, "utf-8"))
  return cachedBootstrap
}

function debug(msg: string) {
  if (isDebug()) console.error(`[superpowers] ${msg}`)
}

export const SuperpowersPlugin: Plugin = async () => {
  if (isOff()) {
    debug("SUPERPOWERS_OFF=1 — plugin inactive")
    return {}
  }

  return {
    // Register the synced skills directory so opencode discovers all 14 skills.
    config: async (config) => {
      const cfg = config as unknown as { skills?: { paths?: string[] } }
      cfg.skills ??= {}
      cfg.skills.paths ??= []
      if (existsSync(SKILLS_DIR) && !cfg.skills.paths.includes(SKILLS_DIR)) {
        cfg.skills.paths.push(SKILLS_DIR)
        debug(`registered skills path: ${SKILLS_DIR}`)
      }
    },

    // Conditional bootstrap injection into first user message.
    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output.messages
      if (!messages?.length) return

      const firstUser = messages.find((m) => m.info.role === "user")
      if (!firstUser?.parts?.length) return

      // Belt-and-braces guards:
      //   (1) text-marker guard catches double-injection within one hook call
      //   (2) session-ID guard catches re-injection across agent steps where
      //       opencode reloads messages from DB (dropping the marker)
      const sessionID = (firstUser.info as { sessionID?: string }).sessionID
      if (sessionID && injectedSessions.has(sessionID)) return
      if (alreadyInjected(firstUser.parts as { type: string; text?: string }[])) {
        if (sessionID) injectedSessions.add(sessionID)
        return
      }

      const firstText =
        ((firstUser.parts.find((p) => p.type === "text") as { text?: string })?.text) ?? ""

      const decision = decideInjection(firstText)
      if (decision === "skip") {
        debug(`skip — no intent match: ${JSON.stringify(firstText.slice(0, 80))}`)
        // Cache the "no injection" decision too — otherwise we re-evaluate
        // the regex on every agent step for the entire session.
        if (sessionID) injectedSessions.add(sessionID)
        return
      }

      const bootstrap = loadBootstrapFromDisk()
      if (!bootstrap) {
        debug(`bootstrap missing at ${BOOTSTRAP_PATH}`)
        return
      }

      const ref = firstUser.parts[0]
      firstUser.parts.unshift({ ...ref, type: "text", text: bootstrap } as typeof ref)
      if (sessionID) injectedSessions.add(sessionID)
      debug(`injected ${bootstrap.length} bytes (${decision}) session=${sessionID ?? "?"}`)
    },
  }
}
