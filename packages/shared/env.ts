import dotenv from "dotenv";

export function loadLocalEnv() {
  dotenv.config({ path: ".env", quiet: true, override: true });
  dotenv.config({ path: ".env.local", quiet: true, override: true });
}
