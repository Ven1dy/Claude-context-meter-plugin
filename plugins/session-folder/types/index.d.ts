export type SessionFolderData = {
  start: string | null
  cwd: string | null
  branch: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-folder': {
      data: SessionFolderData
    }
  }
}
