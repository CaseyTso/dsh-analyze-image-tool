# analyze-image-tool

A vision bridge for DeepSeek Harness: it lets a text-only model answer questions about images by forwarding them to an OpenAI-compatible vision endpoint.

## Language

**Composer image**:
An image pasted into the Web composer draft and sent as a base64 image block in the outgoing message.
_Avoid_: pasted image, inline image

**Local-path image**:
An image addressed by a filesystem path or an http(s)/data: URL, read by the tool rather than attached to the message.
_Avoid_: file image

**Image gate**:
The harness's fail-closed host check that refuses image content when the routed model does not declare image input.
_Avoid_: route gate, modality check

**Composer-image bridge**:
The plugin's runtime wrapper around `apiProxy.sessions.prompt` that persists pasted images and rewrites them into text notes carrying the attachment id for text-only models.
_Avoid_: inbound transform, prompt seam wrapper

**Vision endpoint**:
An OpenAI-compatible multimodal API identified by a baseURL, a model id, and an apiKey.
_Avoid_: VLM backend, OCR service

**Attachment reference**:
The harness's `ImageAttachmentRef` handle (`attachmentId`, `mediaType`, `bytes`, `width`, `height`, `name`) for a stored image.
_Avoid_: attachment id, image ref
