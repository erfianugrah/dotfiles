import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * streaming-thinking-guard - suppress the raw thinking text flood during
 * streaming, showing only a compact "Thinking..." label.
 * The full thinking block renders normally once streaming completes.
 */
export default function (pi: ExtensionAPI) {
  pi.registerMarkdownTransformer(
    (markdown: string, { messageType, isStreaming }: { messageType: string; isStreaming: boolean }) => {
      // Only suppress streaming thinking deltas
      if (messageType === "assistant-thinking" && isStreaming) {
        return "\u25b8 *Thinking...*";
      }
      // Final render: pass-through (styled widget)
      return markdown;
    }
  );
}