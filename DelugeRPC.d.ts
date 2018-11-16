import { EventEmitter } from 'events';

declare function DelugeRPC(
  socket: net.Socket,
  options: { debug?: boolean | function; protocolVersion?: number; resolveErrorResponses?: boolean }
): {
  request: (
    method: String,
    args?: any[],
    kwargs?: {}
  ) => {
    result: Promise<any | ({ error: any } | { response: any })>;
    sent: Promise<undefined | { error: any }>;
  };
  events: EventEmitter;
  core: {
    addTorrentFile: (
      filename: String,
      filedump: String,
      torrentOptions: {}
    ) => {
      result: Promise<String | ({ error: any } | { response: String })>;
      sent: Promise<undefined | { error: any }>;
    };
    addTorrentUrl: (
      url: String,
      torrentOptions: {},
      options: { headers?: {} }
    ) => {
      result: Promise<String | ({ error: any } | { response: String })>;
      sent: Promise<undefined | { error: any }>;
    };
    addTorrentMagnet: (
      uri: String,
      torrentOptions: {}
    ) => {
      result: Promise<String | ({ error: any } | { response: String })>;
      sent: Promise<undefined | { error: any }>;
    };
    removeTorrent: (
      torrentId: String,
      removeData: boolean
    ) => {
      result: Promise<boolean | ({ error: any } | { response: boolean })>;
      sent: Promise<undefined | { error: any }>;
    };
    getSessionStatus: (
      keys: String[]
    ) => {
      result: Promise<{} | ({ error: any } | { response: {} })>;
      sent: Promise<undefined | { error: any }>;
    };
    getCacheStatus: () => {
      result: Promise<{} | ({ error: any } | { response: {} })>;
      sent: Promise<undefined | { error: any }>;
    };
    forceReannounce: (
      torrentIds: String[]
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    pauseTorrent: (
      torrentIds: String[]
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    connectPeer: (
      torrentId: String,
      ip: String,
      port: number
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    moveStorage: (
      torrentIds: String[],
      dest: any
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    pauseAllTorrents: () => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    resumeAllTorrents: () => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    resumeTorrent: (
      torrentIds: String[]
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    getTorrentStatus: (
      torrentId: String,
      keys: String[],
      options: { diff?: boolean }
    ) => {
      result: Promise<{} | ({ error: any } | { response: {} })>;
      sent: Promise<undefined | { error: any }>;
    };
    getTorrentsStatus: (
      filter_dict: {},
      keys: String[],
      options: { diff?: boolean }
    ) => {
      result: Promise<{} | ({ error: any } | { response: {} })>;
      sent: Promise<undefined | { error: any }>;
    };
    getFilterTree: (
      options: { show_zero_hits?: boolean = true; hide_cat?: any }
    ) => {
      result: Promise<any | ({ error: any } | { response: any })>;
      sent: Promise<undefined | { error: any }>;
    };
    getSessionState: () => {
      result: Promise<String[] | ({ error: any } | { response: String[] })>;
      sent: Promise<undefined | { error: any }>;
    };
    getConfig: () => {
      result: Promise<{} | ({ error: any } | { response: {} })>;
      sent: Promise<undefined | { error: any }>;
    };
    getConfigValue: (
      key: any
    ) => {
      result: Promise<any | ({ error: any } | { response: any })>;
      sent: Promise<undefined | { error: any }>;
    };
    getConfigValues: (
      keys: any[]
    ) => {
      result: Promise<{} | ({ error: any } | { response: {} })>;
      sent: Promise<undefined | { error: any }>;
    };
    setConfig: (
      config: {}
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    getListenPort: () => {
      result: Promise<number | ({ error: any } | { response: number })>;
      sent: Promise<undefined | { error: any }>;
    };
    getNumConnections: () => {
      result: Promise<number | ({ error: any } | { response: number })>;
      sent: Promise<undefined | { error: any }>;
    };
    getAvailablePlugins: () => {
      result: Promise<String[] | ({ error: any } | { response: String[] })>;
      sent: Promise<undefined | { error: any }>;
    };
    getEnabledPlugins: () => {
      result: Promise<String[] | ({ error: any } | { response: String[] })>;
      sent: Promise<undefined | { error: any }>;
    };
    enablePlugin: (
      plugin: String
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    disablePlugin: (
      plugin: String
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    forceRecheck: (
      torrentIds: String[]
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentOptions: (
      torrentIds: String[],
      torrentOptions: {}
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentTrackers: (
      torrentId: String,
      trackers: {}[]
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentMaxConnections: (
      torrentId: String,
      value: number
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentMaxUploadSlots: (
      torrentId: String,
      value: number
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentMaxUploadSpeed: (
      torrentId: String,
      value: number
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentMaxDownloadSpeed: (
      torrentId: String,
      value: number
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentFilePriorities: (
      torrentId: String,
      priorities: {}
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentPrioritizeFirstLast: (
      torrentId: String,
      value: boolean
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentAutoManaged: (
      torrentId: String,
      value: boolean
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentStopAtRatio: (
      torrentId: String,
      value: boolean
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentStopRatio: (
      torrentId: String,
      value: number
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentRemoveAtRatio: (
      torrentId: String,
      value: boolean
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentMoveCompleted: (
      torrentId: String,
      value: boolean
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    setTorrentMoveCompletedPath: (
      torrentId: String,
      value: String
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    getPathSize: (
      path: String
    ) => {
      result: Promise<number | ({ error: any } | { response: number })>;
      sent: Promise<undefined | { error: any }>;
    };
    // TODO check args
    createTorrent: (
      path: String,
      tracker: String,
      piece_length: number,
      comment: String,
      target: any,
      webseeds: any,
      private: any,
      created_by: String,
      trackers: {}[],
      add_to_session: boolean
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    uploadPlugin: (
      filename: String,
      filedump: String
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    rescanPlugins: () => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    renameFiles: (
      torrentId: String,
      filenames: [number, String][]
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    renameFolder: (
      torrentId: String,
      folder: String,
      newFolder: String
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    queueTop: (
      torrentIds: String[]
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    queueUp: (
      torrentIds: String[]
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    queueDown: (
      torrentIds: String[]
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    queueBottom: (
      torrentIds: String[]
    ) => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    glob: (
      path: String
    ) => {
      // TODO: Check result
      result: Promise<String[] | ({ error: any } | { response: String[] })>;
      sent: Promise<undefined | { error: any }>;
    };
    testListenPort: () => {
      result: Promise<boolean | ({ error: any } | { response: boolean })>;
      sent: Promise<undefined | { error: any }>;
    };
    getFreeSpace: (
      options: { path?: String }
    ) => {
      result: Promise<number | ({ error: any } | { response: number })>;
      sent: Promise<undefined | { error: any }>;
    };
    getLibtorrentVersion: () => {
      result: Promise<String | ({ error: any } | { response: String })>;
      sent: Promise<undefined | { error: any }>;
    };
  };
  daemon: {
    getMethodList: () => {
      result: Promise<String[] | ({ error: any } | { response: String[] })>;
      sent: Promise<undefined | { error: any }>;
    };
    info: () => {
      result: Promise<String | ({ error: any } | { response: String })>;
      sent: Promise<undefined | { error: any }>;
    };
    shutdown: () => {
      result: Promise<undefined | ({ error: any } | { response: undefined })>;
      sent: Promise<undefined | { error: any }>;
    };
    login: (
      username: String,
      password: String
    ) => {
      result: Promise<number | ({ error: any } | { response: number })>;
      sent: Promise<undefined | { error: any }>;
    };
  };
};
