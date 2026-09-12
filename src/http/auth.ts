import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { MoonanDatabase } from "../storage/database.js";

const scrypt = promisify(scryptCallback);

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string, salt = randomBytes(16).toString("hex")): Promise<{ hash: string; salt: string }> {
  if (password.length < 12) throw new Error("密码至少需要12个字符");
  const derived = await scrypt(password, salt, 64) as Buffer;
  return { hash: derived.toString("hex"), salt };
}

export async function verifyPassword(password: string, expectedHash: string, salt: string): Promise<boolean> {
  const actual = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class WebAuth {
  constructor(private readonly db: MoonanDatabase) {}

  async ensurePassword(preferred?: string): Promise<string | null> {
    if (this.db.getAdminAuth()) return null;
    const password = preferred || randomBytes(18).toString("base64url");
    const value = await hashPassword(password);
    this.db.setAdminAuth(value.hash, value.salt);
    return password;
  }

  async login(password: string): Promise<string | null> {
    const auth = this.db.getAdminAuth();
    if (!auth || !(await verifyPassword(password, auth.hash, auth.salt))) return null;
    const token = randomBytes(32).toString("base64url");
    this.db.createWebSession(tokenHash(token), Date.now() + 30 * 24 * 60 * 60_000);
    return token;
  }

  authenticated(token: string | undefined): boolean {
    return Boolean(token && this.db.hasWebSession(tokenHash(token)));
  }

  logout(token: string | undefined): void {
    if (token) this.db.deleteWebSession(tokenHash(token));
  }

  async resetPassword(password?: string): Promise<string> {
    const next = password || randomBytes(18).toString("base64url");
    const value = await hashPassword(next);
    this.db.setAdminAuth(value.hash, value.salt);
    this.db.sqlite.prepare("DELETE FROM web_sessions").run();
    return next;
  }
}
