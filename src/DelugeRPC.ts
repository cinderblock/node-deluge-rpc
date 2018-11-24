'use strict';

import { EventEmitter } from 'events';
import { Socket } from 'net';
import { promisify } from 'util';
import { readFile } from 'fs';

const camelCaseKeys = require('camelcase-keys-deep');
const snakeCaseKeys = require('snakecase-keys');
const pako = require('pako');

import {
  encode,
  decode,
  RencodableData,
  RencodableObject,
} from 'python-rencode';
import nextPowerOfTwo from 'smallest-power-of-two';

const readFilePromise = promisify(readFile);

function getDebug(d: boolean | Function | undefined) {
  return typeof d == 'function'
    ? d
    : d === true
    ? (...args: any[]) => console.log('DEBUG:', ...args)
    : () => {};
}

type Awaitable<T> = T | Promise<T>;
export type AwaitableRencodedData =
  | Awaitable<RencodableData>
  | AwaitableRencodableArray
  | AwaitableRencodableObject;

export interface AwaitableRencodableObject {
  [k: string]: AwaitableRencodedData;
  [k: number]: AwaitableRencodedData;
}
export interface AwaitableRencodableArray
  extends Array<AwaitableRencodedData> {}

export async function loadFile(file: string) {
  return (<Buffer>await readFilePromise(file)).toString('base64');
}

export default function DelugeRPC(
  socket: Socket,
  options: {
    debug?: boolean | Function;
    protocolVersion?: 0 | 1;
    resolveErrorResponses?: boolean;
    /**
     * Default subject to change. Currently true
     */
    camelCaseResponses?: boolean;
  } = {}
) {
  const debug = getDebug(options.debug);
  const protocolVersion = options.protocolVersion || 0;
  const resolveErrorResponses = options.resolveErrorResponses;
  const camelCaseResponses =
    options.camelCaseResponses === undefined || options.camelCaseResponses;

  function parseResponse(data: RencodableData) {
    if (!camelCaseResponses) return data;
    // Try catch is easy way to handle
    try {
      return camelCaseKeys(data, { deep: true });
    } catch (e) {}
    return data;
  }

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
      buffer = Buffer.allocUnsafe(nextPowerOfTwo(newLength));
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

  function isObject(x: any) {
    if (typeof x !== 'object') return false;
    if (x === null) return false;

    // Might as well keep these
    if (x instanceof RegExp) return false;
    if (x instanceof Error) return false;
    if (x instanceof Date) return false;

    return true;
  }

  async function allPromises(
    data: AwaitableRencodedData
  ): Promise<RencodableData> {
    const dataResolved = await data;

    // Even if dataResolved is a function, null, or some other non RencodableData, let something else error
    if (!isObject(dataResolved)) return <RencodableData>dataResolved;

    if (Array.isArray(dataResolved)) {
      return Promise.all(
        (<AwaitableRencodableArray>dataResolved).map(allPromises)
      );
    }

    const ret: RencodableObject = {};

    const keys = Object.keys(<AwaitableRencodableObject>dataResolved);
    for (let i = 0; i < keys.length; i++) {
      ret[keys[i]] = await allPromises(
        (<AwaitableRencodableObject>dataResolved)[keys[i]]
      );
    }

    return ret;
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
    method: Awaitable<string>,
    args: AwaitableRencodableArray | AwaitableRencodableObject = [],
    kwargs: AwaitableRencodableObject = {}
  ): ResponseType<RencodableData> {
    if (!Array.isArray(args)) {
      kwargs = args;
      args = [];
    }

    const id = nextRequestId++;

    const result = new Promise<RencodableData>((resolve, reject) => {
      saveResolvers(id, {
        resolve: (data: RencodableData) => resolve(parseResponse(data)),
        reject,
      });
    });

    const sent = new Promise<Sent>(async (resolve, reject) => {
      reject = resolveErrorResponses ? resolve : reject;
      // TODO: confirm this works as intended
      socket.once('error', reject);

      try {
        rawSend(await allPromises([[id, method, args, kwargs]]), () => {
          // Clean up after ourselves
          socket.removeListener('error', reject);
          resolve();
        });
      } catch (e) {
        socket.removeListener('error', reject);
        reject(e);
      }
    });

    return { result, sent };
  }

  type FlatMap = { [x: string]: string };

  type FileDump = Promise<string> | Promise<Buffer> | string | Buffer;

  type TorrentOptions = FlatMap;

  async function handleFiledump(dump: FileDump) {
    const content = await dump;
    if (content instanceof Buffer) return content.toString('base64');
    return content;
  }

  const camelCore = {
    addTorrentFile: (
      filename: string,
      filedump: FileDump,
      torrentOptions: TorrentOptions = {}
    ) =>
      request('core.add_torrent_file', [
        filename,
        handleFiledump(filedump),
        snakeCaseKeys(torrentOptions),
      ]),

    addTorrentUrl: (
      url: string,
      torrentOptions: TorrentOptions = {},
      options: { headers?: FlatMap } = {}
    ) =>
      request(
        'core.add_torrent_url',
        [url, snakeCaseKeys(torrentOptions)],
        options
      ),

    addTorrentMagnet: (uri: string, torrentOptions: TorrentOptions = {}) =>
      request('core.add_torrent_magnet', [uri, snakeCaseKeys(torrentOptions)]),

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

    pauseAllTorrents: () =>
      <ResponseType<undefined>>request('core.pause_all_torrents'),

    resumeAllTorrents: () =>
      <ResponseType<undefined>>request('core.resume_all_torrents'),

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

    getFilterTree: (options: { showZeroHits?: boolean; hideCats?: string[] }) =>
      request('core.get_filter_tree', snakeCaseKeys(options)),

    getSessionState: () =>
      <ResponseType<string[]>>request('core.get_session_state'),

    getConfig: () => request('core.get_config'),

    getConfigValue: (key: string) => request('core.get_config_value', [key]),

    getConfigValues: (keys: string[]) =>
      request('core.get_config_values', [keys]),

    setConfig: (config: FlatMap) => request('core.set_config', [config]),

    getListenPort: () => <ResponseType<number>>request('core.get_listen_port'),

    getNumConnections: () =>
      <ResponseType<number>>request('core.get_num_connections'),

    getAvailablePlugins: () =>
      <ResponseType<string[]>>request('core.get_available_plugins'),

    getEnabledPlugins: () =>
      <ResponseType<string[]>>request('core.get_enabled_plugins'),

    enablePlugin: (plugin: string) =>
      <ResponseType<boolean>>request('core.enable_plugin', [plugin]),

    disablePlugin: (plugin: string) =>
      <ResponseType<boolean>>request('core.disable_plugin', [plugin]),

    forceRecheck: (torrentIds: string[]) =>
      <ResponseType<boolean>>request('core.force_recheck', [torrentIds]),

    setTorrentOptions: (
      torrentIds: string[],
      torrentOptions: TorrentOptions = {}
    ) =>
      request('core.set_torrent_options', [
        torrentIds,
        snakeCaseKeys(torrentOptions),
      ]),

    setTorrentTrackers: (
      torrentId: string,
      trackers: { url: string; tier: string }[]
    ) => request('core.set_torrent_trackers', [torrentId, trackers]),

    getPathSize: (path: string) => request('core.get_path_size', [path]),

    createTorrent: (
      path: string,
      tracker: string,
      pieceLength: number,
      comment: string,
      target: string,
      webseeds: [],
      priv: boolean,
      createdBy: string,
      trackers: FlatMap[],
      addToSession: boolean
    ) =>
      request('core.create_torrent', [
        path,
        tracker,
        pieceLength,
        comment,
        target,
        webseeds,
        priv,
        createdBy,
        trackers,
        addToSession,
      ]),

    uploadPlugin: (filename: string, filedump: FileDump) =>
      request('core.upload_plugin', [filename, handleFiledump(filedump)]),

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
  };
  const camelDaemon = {
    getMethodList: () => request('daemon.get_method_list'),
    info: () => request('daemon.info'),
    shutdown: () => request('daemon.shutdown'),
    login: (username: string, password: string) =>
      request('daemon.login', [username, password]),
  };

  // We could do this more programmatically but this help tsc more

  const core = {
    add_torrent_file: camelCore.addTorrentFile,
    addTorrentFile: camelCore.addTorrentFile,
    add_torrent_url: camelCore.addTorrentUrl,
    addTorrentUrl: camelCore.addTorrentUrl,
    add_torrent_magnet: camelCore.addTorrentMagnet,
    addTorrentMagnet: camelCore.addTorrentMagnet,
    remove_torrent: camelCore.removeTorrent,
    removeTorrent: camelCore.removeTorrent,
    get_session_status: camelCore.getSessionStatus,
    getSessionStatus: camelCore.getSessionStatus,
    get_cache_status: camelCore.getCacheStatus,
    getCacheStatus: camelCore.getCacheStatus,
    force_reannounce: camelCore.forceReannounce,
    forceReannounce: camelCore.forceReannounce,
    pause_torrent: camelCore.pauseTorrent,
    pauseTorrent: camelCore.pauseTorrent,
    connect_peer: camelCore.connectPeer,
    connectPeer: camelCore.connectPeer,
    move_storage: camelCore.moveStorage,
    moveStorage: camelCore.moveStorage,
    pause_all_torrents: camelCore.pauseAllTorrents,
    pauseAllTorrents: camelCore.pauseAllTorrents,
    resume_all_torrents: camelCore.resumeAllTorrents,
    resumeAllTorrents: camelCore.resumeAllTorrents,
    resume_torrent: camelCore.resumeTorrent,
    resumeTorrent: camelCore.resumeTorrent,
    get_torrent_status: camelCore.getTorrentStatus,
    getTorrentStatus: camelCore.getTorrentStatus,
    get_torrents_status: camelCore.getTorrentsStatus,
    getTorrentsStatus: camelCore.getTorrentsStatus,
    get_filter_tree: camelCore.getFilterTree,
    getFilterTree: camelCore.getFilterTree,
    get_session_state: camelCore.getSessionState,
    getSessionState: camelCore.getSessionState,
    get_config: camelCore.getConfig,
    getConfig: camelCore.getConfig,
    get_config_value: camelCore.getConfigValue,
    getConfigValue: camelCore.getConfigValue,
    get_config_values: camelCore.getConfigValues,
    getConfigValues: camelCore.getConfigValues,
    set_config: camelCore.setConfig,
    setConfig: camelCore.setConfig,
    get_listen_port: camelCore.getListenPort,
    getListenPort: camelCore.getListenPort,
    get_num_connections: camelCore.getNumConnections,
    getNumConnections: camelCore.getNumConnections,
    get_available_plugins: camelCore.getAvailablePlugins,
    getAvailablePlugins: camelCore.getAvailablePlugins,
    get_enabled_plugins: camelCore.getEnabledPlugins,
    getEnabledPlugins: camelCore.getEnabledPlugins,
    enable_plugin: camelCore.enablePlugin,
    enablePlugin: camelCore.enablePlugin,
    disable_plugin: camelCore.disablePlugin,
    disablePlugin: camelCore.disablePlugin,
    force_recheck: camelCore.forceRecheck,
    forceRecheck: camelCore.forceRecheck,
    set_torrent_options: camelCore.setTorrentOptions,
    setTorrentOptions: camelCore.setTorrentOptions,
    set_torrent_trackers: camelCore.setTorrentTrackers,
    setTorrentTrackers: camelCore.setTorrentTrackers,
    get_path_size: camelCore.getPathSize,
    getPathSize: camelCore.getPathSize,
    create_torrent: camelCore.createTorrent,
    createTorrent: camelCore.createTorrent,
    upload_plugin: camelCore.uploadPlugin,
    uploadPlugin: camelCore.uploadPlugin,
    rescan_plugins: camelCore.rescanPlugins,
    rescanPlugins: camelCore.rescanPlugins,
    rename_files: camelCore.renameFiles,
    renameFiles: camelCore.renameFiles,
    rename_folder: camelCore.renameFolder,
    renameFolder: camelCore.renameFolder,
    queue_top: camelCore.queueTop,
    queueTop: camelCore.queueTop,
    queue_up: camelCore.queueUp,
    queueUp: camelCore.queueUp,
    queue_down: camelCore.queueDown,
    queueDown: camelCore.queueDown,
    queue_bottom: camelCore.queueBottom,
    queueBottom: camelCore.queueBottom,
    glob: camelCore.glob,
    test_listen_port: camelCore.testListenPort,
    testListenPort: camelCore.testListenPort,
    get_free_space: camelCore.getFreeSpace,
    getFreeSpace: camelCore.getFreeSpace,
    get_libtorrent_version: camelCore.getLibtorrentVersion,
    getLibtorrentVersion: camelCore.getLibtorrentVersion,
  };

  const daemon = {
    get_method_list: camelDaemon.getMethodList,
    getMethodList: camelDaemon.getMethodList,
    info: camelDaemon.info,
    shutdown: camelDaemon.shutdown,
    login: camelDaemon.login,
  };

  return {
    request,
    events,
    core,
    daemon,
  };
}
