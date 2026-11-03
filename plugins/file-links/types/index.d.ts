declare module 'claude-code' {
  interface PluginState {
    'file-links': { files: string[]; dirs: string[]; base: string; asked: string[] }
  }
}
