import dotenv from "dotenv";

export function loadLocalEnv() {
  dotenv.config({ path: ".env", quiet: true });
  dotenv.config({ path: ".env.local", quiet: true, override: false });
}
