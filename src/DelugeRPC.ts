'use strict';

const fs = require('fs').promises;

const EventEmitter = require('events').EventEmitter;
const pako = require('pako');

import { Socket } from 'net';

import {
  encode,
  decode,
  RencodableData,
  RencodableArray,
  RencodableObject,
} from 'python-rencode';

function newSize(needed: number) {
  return 1 << (needed - 1).toString(2).length;
}

function getDebug(d: boolean | Function | undefined) {
  return typeof d == 'function'
    ? d
    : d === true
    ? (...args: any[]) => console.log('DEBUG:', ...args)
    : () => {};
}

export async function loadFile(file: string) {
  return (<Buffer>await fs.readFile(file)).toString('base64');
}

export default function DelugeRPC(
  socket: Socket,
  options: {
    debug?: boolean | Function;
    protocolVersion?: 0 | 1;
    resolveErrorResponses?: boolean;
  } = {}
) {
  const debug = getDebug(options.debug);
  const protocolVersion = options.protocolVersion || 0;
  const resolveErrorResponses = options.resolveErrorResponses;

  let nextRequestId = 0;
  const resolvers: {
    [x: number]: { reject: Function; resolve: Function };
  } = {};
  let buffer = Buffer.allocUnsafe(0);
  let currentLength = 0;

  const events = new EventEmitter();

  function appendToIncomingBuffer(buff: Buffer) {
    const newLength = currentLength + buff.length;
    if (newLength > buffer.length) {
      const old = buffer;
      buffer = Buffer.allocUnsafe(newSize(newLength));
      old.copy(buffer);
    }
    buff.copy(buffer, currentLength);
    currentLength = newLength;
  }

  function removeBufferBeginning(size: number) {
    buffer.copy(buffer, 0, size, currentLength);
    currentLength -= size;
  }

  function getResolvers(id: number) {
    const ret = resolvers[id];
    delete resolvers[id];
    return ret;
  }

  function saveResolvers(
    id: number,
    p: { reject: Function; resolve: Function }
  ) {
    resolvers[id] = !resolveErrorResponses
      ? p
      : {
          resolve: (response: RencodableData) => {
            p.resolve({ response });
          },
          reject: (error: Error) => {
            p.resolve({ error });
          },
        };
  }

  function handlePayload(payload: RencodableData) {
    const RESPONSE = 1;
    const ERROR = 2;
    const EVENT = 3;

    debug('Decoded Data!');
    debug(payload);

    const [type, id, data] = <[number, number | string, RencodableData]>payload;

    if (type == RESPONSE) {
      getResolvers(<number>id).resolve(data);
    } else if (type == ERROR) {
      getResolvers(<number>id).reject(data);
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
    const slice = buffer.slice(0, currentLength);

    if (header == 0x78) {
      // Detect common zlib header as format from Deluge ^1.0.0
      let payload;
      try {
        payload = decode(Buffer.from(pako.inflate(slice)));
        removeBufferBeginning(currentLength);
      } catch (err) {
        // This is expected if we're receiving a large chunk of data and it got chunked by the network.
        debug('Error inflating data');
        debug(err);
        return;
      }
      handlePayload(payload);
      return;
    }

    if (header == 1) {
      // Deluge ^2.0.0 (under development)
      if (currentLength < 5) return;
      const payloadLength = buffer.readInt32BE(1);
      const packetLength = 5 + payloadLength;
      if (currentLength < packetLength) return;

      // Copy the payload from the working buffer
      const payload = decode(
        Buffer.from(pako.inflate(buffer.slice(5, payloadLength)))
      );
      removeBufferBeginning(packetLength);
      handlePayload(payload);
      return;
    }

    events.emit('decodingError', 'Invalid header received:', header);
  });

  function rawSend(data: RencodableData, cb: Function) {
    let buff = pako.deflate(encode(data));

    if (protocolVersion == 0) {
    } else if (protocolVersion == 1) {
      // TODO: Test this with deluge dev version
      const header = Buffer.allocUnsafe(5);
      header.writeUInt8(protocolVersion, 0);
      header.writeUInt32BE(buff.length, 1);
      buff = Buffer.concat([header, buff]);
    } else {
      throw Error('Unknown protocol version!');
    }

    socket.write(buff, cb);
  }

  // Expected response of default API
  type SentDefault = undefined;
  type ResultDefault<T> = T;

  // Expected response of alternate API
  type SentAlternate = undefined | { error: Error };
  type ResultAlternate<T> = { error: [] | {} | string } | { response: T };

  // TODO: See if we can return Default or Alternate response types based on function arguments
  type Sent = SentDefault | SentAlternate;
  type Result<T> = ResultDefault<T> | ResultAlternate<T>;

  // TODO: T must be one of RencodableData
  type ResponseType<T> = {
    result: Promise<Result<T>>;
    sent: Promise<Sent>;
  };

  function request(
    method: string,
    args: RencodableArray | RencodableObject = [],
    kwargs: RencodableObject = {}
  ): ResponseType<RencodableData> {
    if (!Array.isArray(args)) {
      kwargs = args;
      args = [];
    }

    const id = nextRequestId++;

    const result = new Promise<RencodableData>((resolve, reject) => {
      saveResolvers(id, { resolve, reject });
    });

    const sent = new Promise<Sent>((resolve, reject) => {
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

  type FlatMap = { [x: string]: string };

  type FileDump = Promise<string> | string;

  type TorrentOptions = FlatMap;

  return {
    request,
    events,
    core: {
      addTorrentFile: async (
        filename: string,
        filedump: FileDump,
        torrentOptions: TorrentOptions = {}
      ) =>
        request('core.add_torrent_file', [
          filename,
          await filedump,
          torrentOptions,
        ]),
      addTorrentUrl: (
        url: string,
        torrentOptions: TorrentOptions = {},
        options: { headers?: FlatMap } = {}
      ) => request('core.add_torrent_url', [url, torrentOptions], options),
      addTorrentMagnet: (uri: string, torrentOptions: TorrentOptions = {}) =>
        request('core.add_torrent_magnet', [uri, torrentOptions]),
      removeTorrent: (torrentId: string, removeData: boolean) =>
        request('core.remove_torrent', [torrentId, removeData]),
      getSessionStatus: (keys: string[]) =>
        request('core.get_session_status', [keys]),
      getCacheStatus: () => request('core.get_cache_status'),
      forceReannounce: (torrentIds: string[]) =>
        request('core.force_reannounce', [torrentIds]),
      pauseTorrent: (torrentIds: string[]) =>
        request('core.pause_torrent', [torrentIds]),
      connectPeer: (torrentId: string, ip: string, port: number) =>
        request('core.connect_peer', [torrentId, ip, port]),
      moveStorage: (torrentIds: string[], dest: string) =>
        request('core.move_storage', [torrentIds, dest]),
      pauseAllTorrents: () => request('core.pause_all_torrents'),
      resumeAllTorrents: () => request('core.resume_all_torrents'),
      resumeTorrent: (torrentIds: string[]) =>
        request('core.resume_torrent', [torrentIds]),
      getTorrentStatus: (
        torrentId: string,
        keys: string[],
        options: { diff?: boolean } = {}
      ) => request('core.get_torrent_status', [torrentId, keys], options),
      getTorrentsStatus: (
        filterDict: FlatMap,
        keys: string[],
        options: { diff?: boolean } = {}
      ) => request('core.get_torrents_status', [filterDict, keys], options),
      getFilterTree: (options: { show_zero_hits?: boolean }) =>
        request('core.get_filter_tree', options),
      getSessionState: () =>
        <ResponseType<string[]>>request('core.get_session_state'),
      getConfig: () => request('core.get_config'),
      getConfigValue: (key: string) => request('core.get_config_value', [key]),
      getConfigValues: (keys: string[]) =>
        request('core.get_config_values', [keys]),
      setConfig: (config: FlatMap) => request('core.set_config', [config]),
      getListenPort: () =>
        <ResponseType<number>>request('core.get_listen_port'),
      getNumConnections: () =>
        <ResponseType<number>>request('core.get_num_connections'),
      getAvailablePlugins: () => request('core.get_available_plugins'),
      getEnabledPlugins: () => request('core.get_enabled_plugins'),
      enablePlugin: (plugin: string) => request('core.enable_plugin', [plugin]),
      disablePlugin: (plugin: string) =>
        request('core.disable_plugin', [plugin]),
      forceRecheck: (torrentIds: string[]) =>
        request('core.force_recheck', [torrentIds]),
      setTorrentOptions: (
        torrentIds: string[],
        torrentOptions: TorrentOptions = {}
      ) => request('core.set_torrent_options', [torrentIds, torrentOptions]),
      setTorrentTrackers: (
        torrentId: string,
        trackers: { url: string; tier: string }[]
      ) => request('core.set_torrent_trackers', [torrentId, trackers]),
      getPathSize: (path: string) => request('core.get_path_size', [path]),
      createTorrent: (
        path: string,
        tracker: string,
        piece_length: number,
        comment: string,
        target: string,
        webseeds: [],
        priv: boolean,
        created_by: string,
        trackers: FlatMap[],
        add_to_session: boolean
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
      uploadPlugin: async (filename: string, filedump: FileDump) =>
        request('core.upload_plugin', [filename, await filedump]),
      rescanPlugins: () => request('core.rescan_plugins'),
      renameFiles: () => request('core.rename_files'),
      renameFolder: () => request('core.rename_folder'),
      queueTop: () => request('core.queue_top'),
      queueUp: () => request('core.queue_up'),
      queueDown: () => request('core.queue_down'),
      queueBottom: () => request('core.queue_bottom'),
      glob: () => request('core.glob'),
      testListenPort: () => request('core.test_listen_port'),
      getFreeSpace: () => request('core.get_free_space'),
      getLibtorrentVersion: () => request('core.get_libtorrent_version'),
    },
    daemon: {
      getMethodList: () => request('daemon.get_method_list'),
      info: () => request('daemon.info'),
      shutdown: () => request('daemon.shutdown'),
      login: (username: string, password: string) =>
        request('daemon.login', [username, password]),
    },
  };
}
