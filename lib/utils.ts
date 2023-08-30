import { readdir, stat } from 'fs/promises'
import { join } from 'path'

export async function walk(
  dir: string,
  parentPath?: string
): Promise<
  {
    path: string
    parentPath?: string
  }[]
> {
  const immediateFiles = await readdir(dir)

  // Check if there's an index.mdx file in the current directory
  const currentIndexMdx = join(dir, 'index.mdx')
  if (immediateFiles.includes('index.mdx')) {
    parentPath = currentIndexMdx
  }

  const recursiveFiles = await Promise.all(
    immediateFiles.map(async (file) => {
      const path = join(dir, file)
      const stats = await stat(path)
      if (stats.isDirectory()) {
        return walk(path, parentPath)
      } else if (stats.isFile()) {
        return [
          {
            path: path,
            parentPath,
          },
        ]
      } else {
        return []
      }
    })
  )

  const flattenedFiles = recursiveFiles.reduce(
    (all, folderContents) => all.concat(folderContents),
    []
  )
  return flattenedFiles.sort((a, b) => a.path.localeCompare(b.path))
}
