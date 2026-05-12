import dotenv from "dotenv";

export function loadLocalEnv() {
  const existing = { ...process.env };
  dotenv.config({ path: ".env", quiet: true, override: false });
  dotenv.config({ path: ".env.local", quiet: true, override: true });
  for (const [key, value] of Object.entries(existing)) {
    if (value !== undefined) process.env[key] = value;
  }
}
