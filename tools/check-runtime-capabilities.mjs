import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(':memory:')
try {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Use the Node 24 runtime pinned in .nvmrc.')
  db.exec(
    "CREATE VIRTUAL TABLE runtime_search USING fts5(body); INSERT INTO runtime_search(body) VALUES ('Vantage local search')",
  )
  if (
    db
      .prepare("SELECT count(*) AS matches FROM runtime_search WHERE runtime_search MATCH 'local'")
      .get().matches !== 1
  )
    throw new Error('SQLite FTS5 did not return the expected result.')
  console.log(
    JSON.stringify({
      node: process.version,
      electron: process.versions.electron ?? null,
      sqlite: process.versions.sqlite,
      fts5: true,
    }),
  )
} catch (error) {
  console.error(
    `Unsupported development runtime: ${error.message} File search requires SQLite FTS5. The packaged Electron runtime is checked separately.`,
  )
  process.exitCode = 1
} finally {
  db.close()
}
