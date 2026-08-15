# Runtime api-proxy bridge replaces the mandatory host patch

## Context

The host image gate rejects "image + text-only model" inside `apiProxy.sessions.prompt` before any plugin hook fires. ADR-0001 solved this with a host patch that adds an `apiproxy/prompt-content` waterfall, plus a plugin listener. That still requires users to patch the installed `@deepseek-ai/dsh-host-apiproxy` package before the plugin can bridge composer images.

## Decision

The plugin now installs a runtime bridge: during `apply`, when the host exposes the `apiProxy` service, the plugin wraps `apiProxy.sessions.prompt`.

For an incoming `session.prompt` that contains raw image blocks:

1. Resolve the session-local current model through the existing `session.models` route.
2. Ask `ctx.llm.resolveModelInfo` whether that model declares image input.
3. For a text-only model, validate and save each image through the public attachments service (`validateImage` then `saveImage`), index the returned `ImageAttachmentRef` in memory, and rewrite the image block into a user-visible text note carrying the attachment id.
4. For a vision-capable model (or when the model cannot be determined), leave the prompt untouched and let the host behave normally.

The existing `apiproxy/prompt-content` listener stays as a compatibility path for hosts that already have the seam from ADR-0001; the runtime wrapper runs first, so both paths never rewrite the same block twice.

## Consequences

- Installing the plugin is sufficient to recognize composer-pasted images on web profiles; no host patch is required.
- The bridge is process-local and memory-indexed, so the ADR-0001 restart limitation still applies: after a server restart, historical attachment ids cannot be read back and the image must be pasted again.
- The wrapper depends on stable public service surfaces (`apiProxy.sessions.prompt`, `session.models`, `attachments.validateImage/saveImage`, `llm.resolveModelInfo`). If the host service shape changes, the wrapper falls back to the host path (and to the seam when present), so the failure mode is the pre-bridge behavior, not a crash.
