// What a tool call works on, as the one line of a live row names it.

// The input field that says what a call works on, in the order they are tried: a
// Bash call has a command and a description, and the command is the one to show.
const TARGET_FIELDS = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description', 'skill']

const MAX_TARGET_LENGTH = 200

const PATH_FIELDS = ['file_path', 'notebook_path']

const pathSegments = (path: string) => path.split('/').filter(segment => segment !== '')

// A file as `~/project/name`: the folder the session's project root sits in, or for
// a file outside the project the folder the file sits in, then the file's name.
const fileLabel = (path: string, projectRoot: string) => {
  const segments = pathSegments(path)
  const name = segments.at(-1) ?? path
  const isInProject = !path.startsWith('/') || (projectRoot !== '' && path.startsWith(`${projectRoot}/`))
  const folder = isInProject ? pathSegments(projectRoot).at(-1) : segments.at(-2)

  return folder === undefined ? name : `~/${folder}/${name}`
}

// Absolute paths inside a command or pattern, in the style of fileLabel: the project
// root as `~/project`, and any other home folder as `~`.
const HOME_FOLDER = /\/(?:Users|home)\/[^/\s"']+/g

const shortenPaths = (text: string, projectRoot: string) => {
  const project = pathSegments(projectRoot).at(-1)
  const withProject = projectRoot === '' || project === undefined ? text : text.replaceAll(projectRoot, `~/${project}`)

  return withProject.replace(HOME_FOLDER, '~')
}

// What a call works on, as one short line: the first line of the field
// TARGET_FIELDS picks, cut to MAX_TARGET_LENGTH; empty when the input has none.
export const callTarget = (input: unknown, projectRoot: string) => {
  if (typeof input !== 'object' || input === null) {
    return ''
  }

  const fields: Record<string, unknown> = { ...input }
  const field = TARGET_FIELDS.find(name => typeof fields[name] === 'string')
  const value = field === undefined ? '' : String(fields[field])
  const isPath = field !== undefined && PATH_FIELDS.includes(field)
  const firstLine = isPath ? fileLabel(value, projectRoot) : shortenPaths(value.split('\n')[0]?.trim() ?? '', projectRoot)

  return firstLine.length > MAX_TARGET_LENGTH ? `${firstLine.slice(0, MAX_TARGET_LENGTH - 1)}…` : firstLine
}
