const SECRET_KEY_PATTERN = /(?:ANTHROPIC_AUTH_TOKEN|HIL_BENCH|LITELLM.*KEY|CODEX_API_KEY|OPENAI_API_KEY|AWS.*SECRET|.*TOKEN|.*API_KEY)/i;

export function redactString(text = "") {
  let redacted = String(text);
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (!SECRET_KEY_PATTERN.test(key)) continue;
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
}
