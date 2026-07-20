// Channel names shared between the main process and the preload bridge.
export const IPC = {
  connectionsGetAll: 'connections:getAll',
  connectionsSave: 'connections:save',
  connectionsRemove: 'connections:remove',
  connectionsTest: 'connections:test',
  connectionsDisconnect: 'connections:disconnect',
  connectionsAuthorize: 'connections:authorize',
  connectionsExportProfile: 'connections:exportProfile',
  connectionsImportProfile: 'connections:importProfile',

  bookmarksGetAll: 'bookmarks:getAll',
  bookmarksAdd: 'bookmarks:add',
  bookmarksRemove: 'bookmarks:remove',

  fsList: 'fs:list',
  fsStat: 'fs:stat',
  fsDrives: 'fs:drives',
  fsParent: 'fs:parent',
  fsMkdir: 'fs:mkdir',
  fsCreateFile: 'fs:createFile',
  fsDelete: 'fs:delete',
  fsRename: 'fs:rename',
  fsPreview: 'fs:preview',

  transferCheckConflicts: 'transfer:checkConflicts',
  transferEnqueue: 'transfer:enqueue',
  transferGetAll: 'transfer:getAll',
  transferCancel: 'transfer:cancel',
  transferCancelAll: 'transfer:cancelAll',
  transferClearFinished: 'transfer:clearFinished',

  fsFolderSize: 'fs:folderSize',
  fsChecksum: 'fs:checksum',
  fsFolderContents: 'fs:folderContents',

  dialogPickFolder: 'dialog:pickFolder',

  connectionsRevealMount: 'connections:revealMount',
  connectionsCreateDesktopShortcut: 'connections:createDesktopShortcut',

  logsGetRecent: 'logs:getRecent',
  logsWrite: 'logs:write',
  logsOpenFolder: 'logs:openFolder',
  logsExport: 'logs:export',
  logsExportText: 'logs:exportText',
  logsClear: 'logs:clear',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  appGetVersion: 'app:getVersion',

  // main -> renderer push events
  evtTransferUpdate: 'evt:transfer:update',
  evtTransferAdded: 'evt:transfer:added',
  evtLog: 'evt:log'
} as const
