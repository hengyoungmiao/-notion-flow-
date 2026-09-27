import type { NotionDataSource, NotionPage, NotionQueryResult } from '../types'
import { CliError, RateLimiter, classifyNtnError, runProcess, summarizeStderr, withRetry } from './exec'

export const NOTION_API_VERSION = '2026-03-11'

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface NotionClient {
  whoami(): Promise<{ name: string | null; workspaceName: string | null }>
  search(query: string, objectType: 'page' | 'data_source'): Promise<Array<Record<string, unknown>>>
  getDataSource(id: string): Promise<NotionDataSource>
  updateDataSource(id: string, body: Record<string, unknown>): Promise<NotionDataSource>
  /** 解析数据库 ID 或链接对应的数据源 ID */
  resolveDataSources(databaseId: string): Promise<string[]>
  queryDataSource(
    id: string,
    body: { filter?: unknown; sorts?: unknown; start_cursor?: string; page_size?: number }
  ): Promise<NotionQueryResult<NotionPage>>
  /** 返回 null 表示 404 */
  getPage(id: string): Promise<NotionPage | null>
  createPage(body: Record<string, unknown>): Promise<NotionPage>
  updatePage(id: string, body: Record<string, unknown>): Promise<NotionPage>
  /** 追加子块（最多 100 个）；position 为 page_start 时插到页面最前面 */
  appendBlocks(parentId: string, children: unknown[], position?: { type: 'page_start' } | { type: 'after_block'; after_block: { id: string } }): Promise<{ results: Array<{ id: string; type?: string }> }>
  /** 删除块（进入回收站）；块不存在时视为成功 */
  deleteBlock(id: string): Promise<void>
  listBlocks(id: string): Promise<Array<{ id: string; type: string; has_children?: boolean; [key: string]: unknown }>>
}

export interface NtnCommand {
  command: string
  /** 每个工作空间独立的 NOTION_HOME */
  notionHome: string
  /** 可选：集成 token（优先于 ntn login 的凭据） */
  token?: string
  env?: Record<string, string>
  timeoutMs?: number
}

/** 分页读完一个数据源的查询结果 */
export async function queryAll(
  client: NotionClient,
  dataSourceId: string,
  body: { filter?: unknown; sorts?: unknown } = {},
  limit = 20_000
): Promise<NotionPage[]> {
  const pages: NotionPage[] = []
  let cursor: string | undefined
  do {
    const res = await client.queryDataSource(dataSourceId, { ...body, start_cursor: cursor, page_size: 100 })
    pages.push(...res.results)
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined
  } while (cursor && pages.length < limit)
  return pages
}

export function ntnEnv(cmd: Pick<NtnCommand, 'notionHome' | 'token' | 'env'>): Record<string, string> {
  const env: Record<string, string> = {
    NOTION_HOME: cmd.notionHome,
    NOTION_API_VERSION,
    ...cmd.env
  }
  if (cmd.token) env.NOTION_API_TOKEN = cmd.token
  return env
}

/** 通过官方 ntn CLI 调用 Notion 公共 API（body 走 stdin，固定 API 版本） */
export class NtnNotionClient implements NotionClient {
  private readonly limiter = new RateLimiter(350)

  constructor(private readonly cmd: NtnCommand) {}

  async api<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    return withRetry(async () => {
      await this.limiter.wait()
      const args = ['api', path.replace(/^\//, ''), '-X', method]
      const hasBody = body !== undefined && method !== 'GET'
      if (hasBody) args.push('-d', '@-')
      const res = await runProcess(this.cmd.command, args, {
        env: ntnEnv(this.cmd),
        input: hasBody ? JSON.stringify(body) : undefined,
        timeoutMs: this.cmd.timeoutMs ?? 60_000
      })
      if (res.timedOut) throw new CliError('Notion 请求超时', 'ntn', 'timeout')
      if (res.code !== 0) {
        const { kind, status } = classifyNtnError(res.stderr || res.stdout)
        throw new CliError(summarizeStderr(res.stderr || res.stdout), 'ntn', kind, status, res.stderr)
      }
      const text = res.stdout.trim()
      if (!text) return undefined as T
      try {
        return JSON.parse(text) as T
      } catch {
        throw new CliError(`无法解析 Notion 输出：${text.slice(0, 120)}`, 'ntn', 'unknown')
      }
    })
  }

  async whoami(): Promise<{ name: string | null; workspaceName: string | null }> {
    const me = await this.api<{ name?: string; bot?: { workspace_name?: string; owner?: { user?: { name?: string } } } }>(
      'GET',
      'v1/users/me'
    )
    return {
      name: me?.bot?.owner?.user?.name ?? me?.name ?? null,
      workspaceName: me?.bot?.workspace_name ?? null
    }
  }

  async search(query: string, objectType: 'page' | 'data_source'): Promise<Array<Record<string, unknown>>> {
    const res = await this.api<NotionQueryResult<Record<string, unknown>>>('POST', 'v1/search', {
      query,
      filter: { property: 'object', value: objectType },
      page_size: 50
    })
    return res?.results ?? []
  }

  getDataSource(id: string): Promise<NotionDataSource> {
    return this.api('GET', `v1/data_sources/${id}`)
  }

  updateDataSource(id: string, body: Record<string, unknown>): Promise<NotionDataSource> {
    return this.api('PATCH', `v1/data_sources/${id}`, body)
  }

  async resolveDataSources(databaseId: string): Promise<string[]> {
    const db = await this.api<{ data_sources?: Array<{ id: string }> }>('GET', `v1/databases/${databaseId}`)
    return (db?.data_sources ?? []).map((d) => d.id)
  }

  queryDataSource(
    id: string,
    body: { filter?: unknown; sorts?: unknown; start_cursor?: string; page_size?: number }
  ): Promise<NotionQueryResult<NotionPage>> {
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body)) if (v !== undefined) clean[k] = v
    return this.api('POST', `v1/data_sources/${id}/query`, clean)
  }

  async getPage(id: string): Promise<NotionPage | null> {
    try {
      return await this.api<NotionPage>('GET', `v1/pages/${id}`)
    } catch (e) {
      if (e instanceof CliError && e.kind === 'not_found') return null
      throw e
    }
  }

  createPage(body: Record<string, unknown>): Promise<NotionPage> {
    return this.api('POST', 'v1/pages', body)
  }

  updatePage(id: string, body: Record<string, unknown>): Promise<NotionPage> {
    return this.api('PATCH', `v1/pages/${id}`, body)
  }

  async appendBlocks(
    parentId: string,
    children: unknown[],
    position?: { type: 'page_start' } | { type: 'after_block'; after_block: { id: string } }
  ): Promise<{ results: Array<{ id: string; type?: string }> }> {
    const res = await this.api<{ results?: Array<{ id: string; type?: string }> }>('PATCH', `v1/blocks/${parentId}/children`, {
      children,
      ...(position ? { position } : {})
    })
    return { results: res?.results ?? [] }
  }

  async deleteBlock(id: string): Promise<void> {
    try {
      await this.api('DELETE', `v1/blocks/${id}`)
    } catch (e) {
      if (e instanceof CliError && (e.kind === 'not_found' || /archived|in_trash/i.test(e.message))) return
      throw e
    }
  }

  async listBlocks(id: string): Promise<Array<{ id: string; type: string; has_children?: boolean }>> {
    const out: Array<{ id: string; type: string; has_children?: boolean }> = []
    let cursor: string | undefined
    do {
      const res = await this.api<NotionQueryResult<{ id: string; type: string; has_children?: boolean }>>(
        'GET',
        `v1/blocks/${id}/children${cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : ''}`
      )
      out.push(...(res?.results ?? []))
      cursor = res?.has_more && res.next_cursor ? res.next_cursor : undefined
    } while (cursor)
    return out
  }
}
