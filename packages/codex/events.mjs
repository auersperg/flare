// Only known UI events cross the account-auth boundary. Never forward protocol frames/stderr.
export const EVENT_BYTES = 262144;
export class Redactor {
  constructor(secrets = []) {
    this.secrets = secrets.filter((s) => typeof s === "string" && s.length > 5);
    this.pending = "";
  }
  text(value) {
    for (const secret of this.secrets)
      value = value.split(secret).join("[redacted]");
    return value;
  }
  delta(value, final = false) {
    const text = this.text(this.pending + value);
    this.pending = "";
    if (!final) {
      let hold = 0;
      for (const secret of this.secrets)
        for (let n = Math.min(secret.length - 1, text.length); n > hold; n--)
          if (text.endsWith(secret.slice(0, n))) {
            hold = n;
            break;
          }
      if (hold) {
        this.pending = text.slice(-hold);
        return text.slice(0, -hold);
      }
    }
    return text;
  }
}
export function secretsFrom(auth, mcp) {
  return [mcp, ...Object.values(auth.tokens ?? {})];
}
