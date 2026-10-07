import type { PublicClient } from 'viem'
import { describe, expect, it } from 'vitest'
import { getLogsChunked, isEndpointError, isRangeError } from '../../src/rpc.js'
import { decryptKeystore, loadSigner } from '../../src/signer.js'

// Web3 Secret Storage test vectors (password "testpassword").
const PRIVATE_KEY = '0x7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d'
const PBKDF2 = {
  version: 3,
  crypto: {
    cipher: 'aes-128-ctr',
    cipherparams: { iv: '6087dab2f9fdbbfaddc31a909735c1e6' },
    ciphertext: '5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46',
    kdf: 'pbkdf2',
    kdfparams: { c: 262144, dklen: 32, prf: 'hmac-sha256', salt: 'ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd' },
    mac: '517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2',
  },
}
const SCRYPT = {
  version: 3,
  crypto: {
    cipher: 'aes-128-ctr',
    cipherparams: { iv: '83dbcc02d8ccb40e466191a123791e0e' },
    ciphertext: 'd172bf743a674da9cdad04534d56926ef8358534d458fffccd4e6ad2fbde479c',
    kdf: 'scrypt',
    kdfparams: { dklen: 32, n: 262144, r: 1, p: 8, salt: 'ab0c7876052600dd703518d6fc3fe8984592145b591fc8fb5c6d43190334ba19' },
    mac: '2103ac29920d71da29f15d75b4a16dbe95cfd7ff8faea1056c33131d846e3097',
  },
}

describe('keystore', () => {
  it('decrypts the pbkdf2 test vector', () => {
    expect(decryptKeystore(JSON.stringify(PBKDF2), 'testpassword')).toBe(PRIVATE_KEY)
  })

  it('decrypts the scrypt test vector', () => {
    expect(decryptKeystore(JSON.stringify(SCRYPT), 'testpassword')).toBe(PRIVATE_KEY)
  })

  it('rejects a wrong password', () => {
    expect(() => decryptKeystore(JSON.stringify(PBKDF2), 'nope')).toThrow('wrong keystore password')
  })

  it('loads a raw key with or without 0x and rejects junk', () => {
    const a = loadSigner({ COVEN_PRIVATE_KEY: PRIVATE_KEY })
    const b = loadSigner({ COVEN_PRIVATE_KEY: PRIVATE_KEY.slice(2) })
    expect(a?.address).toBe(b?.address)
    expect(() => loadSigner({ COVEN_PRIVATE_KEY: '0x1234' })).toThrow()
    expect(loadSigner({})).toBeUndefined()
    expect(() => loadSigner({ COVEN_KEYSTORE: '/x' })).toThrow('COVEN_KEYSTORE_PASSWORD')
  })
})

describe('rpc error classes', () => {
  it('separates endpoint trouble from range limits and reverts', () => {
    expect(isEndpointError({ details: 'rate limit exceeded' })).toBe(true)
    expect(isEndpointError({ shortMessage: 'The request timed out.' })).toBe(true)
    expect(isEndpointError({ details: 'execution reverted' })).toBe(false)
    expect(isRangeError({ details: 'query exceeds max results 2000, retry with the range 1-5' })).toBe(true)
    expect(isRangeError({ details: 'requested range too large' })).toBe(true)
    expect(isRangeError({ details: 'execution reverted: range' })).toBe(false)
  })
})

describe('getLogsChunked', () => {
  // A fake node that serves at most 100 blocks per query and fails beyond that.
  function fakeClient(maxSpan: bigint, hint = false) {
    const calls: [bigint, bigint][] = []
    const client = {
      async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
        calls.push([fromBlock, toBlock])
        if (toBlock - fromBlock + 1n > maxSpan) {
          const msg = hint ? `query exceeds max results, retry with the range ${fromBlock}-${fromBlock + maxSpan - 1n}` : 'requested range too large'
          throw Object.assign(new Error(msg), { details: msg })
        }
        const logs = []
        for (let b = fromBlock; b <= toBlock; b++) if (b % 10n === 0n) logs.push({ blockNumber: b })
        return logs
      },
    }
    return { client: client as unknown as PublicClient, calls }
  }

  it('covers the whole range exactly once by splitting', async () => {
    const { client } = fakeClient(100n)
    const logs = await getLogsChunked(client, { events: [], fromBlock: 1n, toBlock: 1000n })
    expect(logs.map((l) => l.blockNumber)).toEqual(Array.from({ length: 100 }, (_, i) => BigInt((i + 1) * 10)))
  })

  it('jumps straight to the span a node suggests', async () => {
    const { client, calls } = fakeClient(37n, true)
    await getLogsChunked(client, { events: [], fromBlock: 0n, toBlock: 999n })
    const failures = calls.filter(([a, b]) => b - a + 1n > 37n)
    // one failure to learn the span, then occasional probes back up after successes
    expect(failures.length).toBeLessThan(calls.length / 2)
  })
})
