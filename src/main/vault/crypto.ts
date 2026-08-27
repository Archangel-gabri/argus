import { argon2id } from 'hash-wasm'

// Deliberately strong, interactive-friendly params (64 MiB, 3 passes).
export const ARGON2 = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536, // KiB → 64 MiB
  hashLength: 32 // 256-bit → SQLCipher raw key
} as const

/**
 * Derive a 32-byte raw key (hex) from the master password + per-vault salt.
 * The hex string is fed to SQLCipher as a raw key, so SQLCipher skips its own KDF.
 */
export async function deriveKeyHex(password: string, salt: Buffer | Uint8Array): Promise<string> {
  return argon2id({
    password,
    salt,
    parallelism: ARGON2.parallelism,
    iterations: ARGON2.iterations,
    memorySize: ARGON2.memorySize,
    hashLength: ARGON2.hashLength,
    outputType: 'hex'
  })
}
