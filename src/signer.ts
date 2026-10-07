import { createDecipheriv, pbkdf2Sync, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { scrypt as nobleScrypt } from '@noble/hashes/scrypt'
import { type Hex, bytesToHex, concat, hexToBytes, keccak256 } from 'viem'
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'

type KeystoreV3 = {
  version: number
  crypto?: KeystoreCrypto
  Crypto?: KeystoreCrypto
}

type KeystoreCrypto = {
  cipher: string
  cipherparams: { iv: string }
  ciphertext: string
  kdf: 'scrypt' | 'pbkdf2'
  kdfparams: { dklen: number; salt: string; n?: number; r?: number; p?: number; c?: number; prf?: string }
  mac: string
}

const bytes = (hex: string) => Buffer.from(hexToBytes(`0x${hex.replace(/^0x/, '')}`))

// Web3 Secret Storage (keystore v3), as written by geth, foundry (`cast wallet new`) and MetaMask.
export function decryptKeystore(json: string, password: string): Hex {
  const ks = JSON.parse(json) as KeystoreV3
  const c = ks.crypto ?? ks.Crypto
  if (ks.version !== 3 || !c) throw new Error('not a v3 keystore')
  if (c.cipher !== 'aes-128-ctr') throw new Error(`unsupported keystore cipher ${c.cipher}`)
  const kp = c.kdfparams
  const salt = bytes(kp.salt)
  let dk: Buffer
  if (c.kdf === 'scrypt') {
    const { n = 0, r = 0, p = 0 } = kp
    const pw = password.normalize('NFKC')
    try {
      // Node's default 32 MB cap rejects geth/foundry keystores (N=2^18, r=8).
      dk = scryptSync(pw, salt, kp.dklen, { N: n, r, p, maxmem: 128 * n * r * (p + 2) })
    } catch {
      // OpenSSL also enforces RFC 7914's N < 2^(16r), which some keystores (including the
      // spec's own test vector) violate. The pure-JS implementation does not.
      dk = Buffer.from(nobleScrypt(pw, salt, { N: n, r, p, dkLen: kp.dklen }))
    }
  } else if (c.kdf === 'pbkdf2') {
    if (kp.prf !== 'hmac-sha256') throw new Error(`unsupported keystore prf ${kp.prf}`)
    dk = pbkdf2Sync(password.normalize('NFKC'), salt, kp.c ?? 0, kp.dklen, 'sha256')
  } else {
    throw new Error(`unsupported keystore kdf ${String(c.kdf)}`)
  }
  const ciphertext = bytes(c.ciphertext)
  const mac = hexToBytes(keccak256(concat([dk.subarray(16, 32), ciphertext])))
  if (!timingSafeEqual(Buffer.from(mac), bytes(c.mac))) throw new Error('wrong keystore password')
  const decipher = createDecipheriv('aes-128-ctr', dk.subarray(0, 16), bytes(c.cipherparams.iv))
  return bytesToHex(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
}

// The signer comes from the environment only, never a flag: flags end up in shell history
// and in pasted logs.
export function loadSigner(env: NodeJS.ProcessEnv = process.env): PrivateKeyAccount | undefined {
  const pk = env.COVEN_PRIVATE_KEY?.trim()
  if (pk) {
    const hex = (pk.startsWith('0x') ? pk : `0x${pk}`) as Hex
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('COVEN_PRIVATE_KEY is not a 32-byte hex key')
    return privateKeyToAccount(hex)
  }
  const path = env.COVEN_KEYSTORE
  if (path) {
    const password = env.COVEN_KEYSTORE_PASSWORD
    if (password === undefined) throw new Error('COVEN_KEYSTORE is set but COVEN_KEYSTORE_PASSWORD is not')
    return privateKeyToAccount(decryptKeystore(readFileSync(path, 'utf8'), password))
  }
  return undefined
}
