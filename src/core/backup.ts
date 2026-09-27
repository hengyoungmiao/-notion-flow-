import { join } from 'node:path'
import type { DidaProject, DidaTask, NotionPage } from './types'
import { writeJsonAtomic } from './sync/state'

/** 首次同步前的备份：Notion 任务库页面 + 滴答任务快照 */
export async function writeBackup(
  dir: string,
  workspaceName: string,
  data: { pages: NotionPage[]; tasks: DidaTask[]; projects: DidaProject[] },
  now = new Date()
): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const safeName = workspaceName.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'workspace'
  const path = join(dir, `backup-${safeName}-${stamp}.json`)
  await writeJsonAtomic(path, { createdAt: now.toISOString(), workspace: workspaceName, ...data })
  return path
}
