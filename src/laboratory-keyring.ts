import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { DomainError } from "./contracts.js";

/** Installation-local wrapping key. Never included in the data backup or tool results. */
export class LaboratoryKeyring {
  constructor(private readonly path: string) {}
  private read(create = false): Buffer {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
        throw new Error("Private key permissions required");
      const key = readFileSync(this.path);
      if (key.length !== 32) throw new Error("Invalid key");
      return key;
    } catch (cause) {
      if (create && (cause as NodeJS.ErrnoException).code === "ENOENT") {
        const key = randomBytes(32);
        writeFileSync(this.path, key, { flag: "wx", mode: 0o600 });
        return key;
      }
      throw new DomainError(
        "LAB_TLS_KEY_UNAVAILABLE",
        "Brak prywatnego klucza laboratorium lub niewłaściwe uprawnienia pliku. Odtwórz klucz tej instalacji oddzielnie od kopii danych.",
        409,
      );
    }
  }
  seal(bytes: ArrayBuffer, identity: string, create = false): string {
    const key = this.read(create),
      iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(identity));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(bytes)),
      cipher.final(),
    ]);
    return JSON.stringify({
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
  }
  open(sealed: string, identity: string): Buffer {
    const key = this.read();
    try {
      const value = JSON.parse(sealed) as Record<string, string>;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(value.iv!, "base64"),
      );
      decipher.setAAD(Buffer.from(identity));
      decipher.setAuthTag(Buffer.from(value.tag!, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext!, "base64")),
        decipher.final(),
      ]);
    } catch {
      throw new DomainError(
        "LAB_TLS_KEY_UNAVAILABLE",
        "Nie można otworzyć klucza certyfikatu tej instalacji.",
        409,
      );
    }
  }
}
