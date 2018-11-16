'use strict';

const EventEmitter = require('events').EventEmitter;
const pako = require('pako');
const { encode, decode } = require('python-rencode');

function newSize(needed) {
  return 1 << (needed - 1).toString(2).length;
}

function DelugeRPC(socket, options) {
  options = options || {};

  let debug = options.debug;
  const protocolVersion = options.protocolVersion || 0;
  const resolveErrorResponses = options.resolveErrorResponses;

  let nextRequestId = 0;
  const resolvers = {};
  let buffer = Buffer.allocUnsafe(0);
  let currentLength = 0;

  if (typeof debug == 'function') {
    // All set
  } else if (debug === true) {
    debug = (...args) => {
      console.log('DEBUG:', ...args);
    };
  } else {
    debug = () => {};
  }

  const events = new EventEmitter();

  function appendToIncomingBuffer(buff) {
    const newLength = currentLength + buff.length;
    if (newLength > buffer.length) {
      const old = buffer;
      buffer = Buffer.allocUnsafe(newSize(newLength));
      old.copy(buffer);
    }
    buff.copy(buffer, currentLength);
    currentLength = newLength;
  }

  function removeBufferBeginning(size) {
    buffer.copy(buffer, 0, size, currentLength);
    currentLength -= size;
  }

  function getResolvers(id) {
    const ret = resolvers[id];
    delete resolvers[id];
    return ret;
  }

  function saveResolvers(id, p) {
    resolvers[id] = !resolveErrorResponses
      ? p
      : {
          resolve: response => {
            p.resolve({ response });
          },
          reject: error => {
            p.resolve({ error });
          },
        };
  }

  function handlePayload(buff) {
    const RESPONSE = 1;
    const ERROR = 2;
    const EVENT = 3;
    const decoded = decode(buff, true);

    debug('Decoded Data!');
    debug(decoded);

    const [type, id, data] = decoded;

    if (type == RESPONSE) {
      getResolvers(id).resolve(data);
    } else if (type == ERROR) {
      getResolvers(id).reject(data);
    } else if (type == EVENT) {
      events.emit('delugeEvent', { name: id, data });
    } else {
      events.emit('decodingError', 'Invalid payload type received:', type);
    }
  }

  socket.on('data', data => {
    appendToIncomingBuffer(data);

    if (currentLength < 1) return;

    const header = buffer[0];

    if (header == 0x78) {
      // Detect common zlib header as format from Deluge ^1.0.0
      try {
        const payload = Buffer.from(pako.inflate(new Uint8Array(buffer, 1, currentLength - 1)));
        removeBufferBeginning(currentLength);
        handlePayload(payload);
        return;
      } catch (err) {
        debug('Error inflating data');
        debug(err);

        // This just means we don't have a full packet from the server back yet.
        // TODO: confirm ^^^
        return;
      }
    } else if (header == 1) {
      // Deluge ^2.0.0 (under development)
      if (currentLength < 5) return;
      const payloadLength = buffer.readInt32BE(1);
      const packetLength = 5 + payloadLength;
      if (currentLength < packetLength) return;

      // Copy the payload from the working buffer
      const payload = Buffer.from(pako.inflate(new Uint8Array(buffer, 5, payloadLength)));
      removeBufferBeginning(packetLength);
      handlePayload(payload);
    } else {
      events.emit('decodingError', 'Invalid header received:', header);
    }
  });

  function rawSend(data, cb) {
    let buff = pako.deflate(encode(data));

    if (protocolVersion == 0) {
    } else if (protocolVersion == 1) {
      // TODO: Test this with deluge dev version
      const header = Buffer.allocUnsafe(5);
      header.writeUInt8(protocolVersion, 0);
      header.writeUInt32BE(buff.length, 1);
      buff = Buffer.concat(header, buff);
    } else {
      throw Error('Unknown protocol version!');
    }

    socket.write(buff, cb);
  }

  function request(method, args, kwargs) {
    if (kwargs === undefined && args !== undefined && !Array.isArray(args)) {
      kwargs = args;
      args = undefined;
    }

    if (args === undefined) args = [];
    if (kwargs === undefined) kwargs = {};

    const id = nextRequestId++;

    const result = new Promise((resolve, reject) => {
      saveResolvers(id, { resolve, reject });
    });

    const sent = new Promise((resolve, reject) => {
      reject = resolveErrorResponses ? resolve : reject;
      // TODO: confirm this works as intended
      socket.once('error', reject);

      rawSend([[id, method, args, kwargs]], () => {
        // Clean up after ourselves
        socket.removeListener('error', reject);
        resolve();
      });
    });

    return { result, sent };
  }

  return {
    request,
    events,
    core: {
      addTorrentFile: (filename, filedump, torrentOptions) =>
        request('core.add_torrent_file', [filename, filedump, torrentOptions]),
      addTorrentUrl: (url, torrentOptions, options) => request('core.add_torrent_url', [url, torrentOptions], options),
      addTorrentMagnet: (uri, torrentOptions) => request('core.add_torrent_magnet', [uri, torrentOptions]),
      removeTorrent: (torrentId, removeData) => request('core.remove_torrent', [torrentId, removeData]),
      getSessionStatus: keys => request('core.get_session_status', [keys]),
      getCacheStatus: () => request('core.get_cache_status', []),
      forceReannounce: torrentIds => request('core.force_reannounce', [torrentIds]),
      pauseTorrent: torrentIds => request('core.pause_torrent', [torrentIds]),
      connectPeer: (torrentId, ip, port) => request('core.connect_peer', [torrentId, ip, port]),
      moveStorage: (torrentIds, dest) => request('core.move_storage', [torrentIds, dest]),
      pauseAllTorrents: () => request('core.pause_all_torrents', []),
      resumeAllTorrents: () => request('core.resume_all_torrents', []),
      resumeTorrent: torrentIds => request('core.resume_torrent', [torrentIds]),
      getTorrentStatus: (torrentId, keys, options) => request('core.get_torrent_status', [torrentId, keys], options),
      getTorrentsStatus: (filter_dict, keys, options) =>
        request('core.get_torrents_status', [filter_dict, keys], options),
      getFilterTree: options => request('core.get_filter_tree', options),
      getSessionState: () => request('core.get_session_state', []),
      getConfig: () => request('core.get_config', []),
      getConfigValue: key => request('core.get_config_value', [key]),
      getConfigValues: keys => request('core.get_config_values', [keys]),
      setConfig: config => request('core.set_config', [config]),
      getListenPort: () => request('core.get_listen_port', []),
      getNumConnections: () => request('core.get_num_connections', []),
      getAvailablePlugins: () => request('core.get_available_plugins', []),
      getEnabledPlugins: () => request('core.get_enabled_plugins', []),
      enablePlugin: plugin => request('core.enable_plugin', [plugin]),
      disablePlugin: plugin => request('core.disable_plugin', [plugin]),
      forceRecheck: torrentIds => request('core.force_recheck', [torrentIds]),
      setTorrentOptions: (torrentIds, torrentOptions) =>
        request('core.set_torrent_options', [torrentIds, torrentOptions]),
      setTorrentTrackers: (torrentId, trackers) => request('core.set_torrent_trackers', [torrentId, trackers]),
      setTorrentMaxConnections: (torrentId, value) => request('core.set_torrent_max_connections', [torrentId, value]),
      setTorrentMaxUploadSlots: (torrentId, value) => request('core.set_torrent_max_upload_slots', [torrentId, value]),
      setTorrentMaxUploadSpeed: (torrentId, value) => request('core.set_torrent_max_upload_speed', [torrentId, value]),
      setTorrentMaxDownloadSpeed: (torrentId, value) =>
        request('core.set_torrent_max_download_speed', [torrentId, value]),
      setTorrentFilePriorities: (torrentId, priorities) =>
        request('core.set_torrent_file_priorities', [torrentId, priorities]),
      setTorrentPrioritizeFirstLast: (torrentId, value) =>
        request('core.set_torrent_prioritize_first_last', [torrentId, value]),
      setTorrentAutoManaged: (torrentId, value) => request('core.set_torrent_auto_managed', [torrentId, value]),
      setTorrentStopAtRatio: (torrentId, value) => request('core.set_torrent_stop_at_ratio', [torrentId, value]),
      setTorrentStopRatio: (torrentId, value) => request('core.set_torrent_stop_ratio', [torrentId, value]),
      setTorrentRemoveAtRatio: (torrentId, value) => request('core.set_torrent_remove_at_ratio', [torrentId, value]),
      setTorrentMoveCompleted: (torrentId, value) => request('core.set_torrent_move_completed', [torrentId, value]),
      setTorrentMoveCompletedPath: (torrentId, value) =>
        request('core.set_torrent_move_completed_path', [torrentId, value]),
      getPathSize: path => request('core.get_path_size', [path]),
      createTorrent: (
        path,
        tracker,
        piece_length,
        comment,
        target,
        webseeds,
        priv,
        created_by,
        trackers,
        add_to_session
      ) =>
        request('core.create_torrent', [
          path,
          tracker,
          piece_length,
          comment,
          target,
          webseeds,
          priv,
          created_by,
          trackers,
          add_to_session,
        ]),
      uploadPlugin: (filename, filedump) => request('core.upload_plugin', [filename, filedump]),
      rescanPlugins: () => request('core.rescan_plugins', []),
      renameFiles: () => request('core.rename_files', []),
      renameFolder: () => request('core.rename_folder', []),
      queueTop: () => request('core.queue_top', []),
      queueUp: () => request('core.queue_up', []),
      queueDown: () => request('core.queue_down', []),
      queueBottom: () => request('core.queue_bottom', []),
      glob: () => request('core.glob', []),
      testListenPort: () => request('core.test_listen_port'),
      getFreeSpace: () => request('core.get_free_space', []),
      getLibtorrentVersion: () => request('core.get_libtorrent_version', []),
    },
    daemon: {
      getMethodList: () => request('daemon.get_method_list'),
      info: () => request('daemon.info'),
      shutdown: () => request('daemon.shutdown'),
      login: (username, password) => request('daemon.login', [username, password]),
    },
  };
}

module.exports = DelugeRPC;
