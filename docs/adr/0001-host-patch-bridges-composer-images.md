# Host patch + plugin bridge composer images for text-only models

A text-only model cannot receive a composer-pasted image: the DeepSeek Harness host rejects the prompt at the apiproxy image gate before any plugin hook fires, so no pure plugin can intercept it. We therefore patch the harness host to add an inbound content-transform seam (`apiproxy/prompt-content` waterfall, run after image save and before the image gate), and the analyze-image-tool plugin listens on it: for a text-only model it rewrites each image block into a user-visible text note carrying the attachment id, and `analyze_image` reads that attachment back by id and forwards it to the configured vision endpoint.

Considered alternatives: a pure plugin (impossible — the gate precedes every hook), a client-side change to the web UI (touches host frontend, not a plugin), and auto-switching the model (rejected: keeps the model-dependent on a vision route). The patch is applied locally and is not upstreamed.
