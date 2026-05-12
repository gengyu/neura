const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLocalHost(host) {
  return LOCAL_HOSTS.has(String(host ?? "").trim().toLowerCase());
}

export function getBearerToken(request) {
  const authorization = request.headers?.authorization;
  if (typeof authorization !== "string") return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function assertBearerToken(request, expectedToken, label = "API") {
  if (!expectedToken) return;
  if (getBearerToken(request) === expectedToken) return;
  const error = new Error(`${label} token is missing or invalid`);
  error.statusCode = 401;
  throw error;
}

export function redactHeaders(headers = {}) {
  const redacted = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = /authorization|cookie|token|key|secret|password/i.test(key)
      ? "[redacted]"
      : value;
  }
  return redacted;
}

export function describeAuthRequirement({ host, token }) {
  if (token) return "token_required";
  if (isLocalHost(host)) return "local_only_without_token";
  return "public_without_token";
}
