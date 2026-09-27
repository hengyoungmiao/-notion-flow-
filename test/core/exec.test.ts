import { describe, expect, it } from 'vitest'
import { classifyDidaError, classifyNtnError, redact, summarizeStderr } from '../../src/core/adapters/exec'

describe('error classification', () => {
  it('classifies dida-cli errors', () => {
    expect(classifyDidaError('DIDA API 错误 401: {"error":"invalid_token"}')).toEqual({ kind: 'auth', status: 401 })
    expect(classifyDidaError('DIDA API 错误 404: not found')).toEqual({ kind: 'not_found', status: 404 })
    expect(classifyDidaError('DIDA API 错误 429: slow down')).toEqual({ kind: 'rate_limit', status: 429 })
    expect(classifyDidaError('DIDA API 错误 502: bad gateway')).toEqual({ kind: 'server', status: 502 })
    expect(classifyDidaError('未找到 access token。请先运行 `dida auth login` 登录。').kind).toBe('auth')
    expect(classifyDidaError('TypeError: fetch failed').kind).toBe('network')
  })

  it('classifies ntn errors', () => {
    expect(classifyNtnError('error: No workspace selected.\n  hint: Run `ntn login` first').kind).toBe('auth')
    expect(classifyNtnError('error: Public API request failed: API token is invalid.').kind).toBe('auth')
    expect(classifyNtnError('error: Public API request failed: Could not find page with ID: abc').kind).toBe('not_found')
    expect(classifyNtnError('error: Public API request failed: You have been rate limited').kind).toBe('rate_limit')
    expect(classifyNtnError('error: body failed validation: properties.x should be defined').kind).toBe('validation')
    expect(classifyNtnError('error: error sending request for url').kind).toBe('network')
  })

  it('redacts tokens', () => {
    expect(redact('Invalid access token: dp_abcdef123456')).not.toContain('abcdef123456')
    expect(redact('token ntn_ABCDEFGHIJKL')).toBe('token ntn_***')
    expect(summarizeStderr('\n\nerror: boom\nmore')).toBe('error: boom')
  })
})
