/**
 * entity-qualifier-nudge - a bare device identifier used as EVIDENCE must
 * name the host it belongs to.
 *
 * STUB. The contract lives in .pi/agent/tests/loop-entity-qualifier.test.ts -
 * read it first, it is the spec. Implement `needsHostQualifier` and wire the
 * message_end nudge; do not edit the tests.
 *
 * Kill switch: PI_ENTITY_NUDGE_OFF=1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Does this text cite a device identifier as evidence without naming its host? */
export function needsHostQualifier(_text: string): boolean {
  return false;
}

export const NUDGE_LINE = "TODO: implement me";

export default function (_pi: ExtensionAPI) {
  // TODO: implement me
}
