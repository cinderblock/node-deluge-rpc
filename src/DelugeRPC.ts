'use strict';

import { EventEmitter } from 'events';
import { Socket } from 'net';
import { promisify } from 'util';
import { readFile } from 'fs';

import camelCaseKeys from 'camelcase-keys-deep';
import snakeCaseKeys from 'snakecase-keys';
import pako from 'pako';

import {
  encode,
  decode,
  RencodableData,
  RencodableObject,
  RencodableArray,
} from 'python-rencode';
import nextPowerOfTwo from 'smallest-power-of-two';

const readFilePromise = promisify(readFile);

function getDebug(d: boolean | ((...args: any[]) => void) | undefined) {
  return typeof d == 'function'
    ? d
    : d === true
    ? (...args: any[]) => console.log('DEBUG:', ...args)
    : () => {};
}

type Awaitable<T> = T | Promise<T>;
export type AwaitableRencodableData =
  | Awaitable<RencodableData>
  | ArrayAwaitableRencodable
  | ObjectAwaitableRencodable;

export interface ObjectAwaitableRencodable {
  [k: string]: AwaitableRencodableData;
  [k: number]: AwaitableRencodableData;
}
export interface ArrayAwaitableRencodable
  extends Array<AwaitableRencodableData> {}

export async function loadFile(file: string) {
  return (<Buffer>await readFilePromise(file)).toString('base64');
}

/**
 * Create an API attached to a specified socket
 *
 * @param socket Some extension of net.Socket
 * @param options hash of options for this connection
 * @returns A set of functions that match Deluge's API
 */
export default function DelugeRPC(
  socket: Socket,
  options: {
    /**
     * A function to call for debug events.
     * True makes a generic one that prints to terminal.
     * False does nothing
     */
    debug?: boolean | ((...args: any[]) => void);
    /**
     * Which Deluge protocol should we use
     *
     * Deluge ^1.0.0 uses version 0 (default)
     * Deluge ^2.0.0 uses version 1
     */
    protocolVersion?: 0 | 1;
    /**
     * Convert all responses from Deluge to camelCase
     *
     * Default subject to change. Currently true
     */
    camelCaseResponses?: boolean;
  } = {}
) {
  // Setup debug function
  const debug = getDebug(options.debug);
  // Default protocol version 0
  const protocolVersion = options.protocolVersion || 0;

  // Default true
  const camelCaseResponses = options.camelCaseResponses ?? true;

  // Internal receive buffer in case multi-part messages are received.
  let buffer = Buffer.allocUnsafe(0);
  let currentLength = 0;

  // When we get new data from the network, we need an easy way to append to the current buffer
  function appendToIncomingBuffer(buff: Buffer) {
    const newLength = currentLength + buff.length;
    // If there is not enough space in the current buffer to hold all the data we're receiving, make it bigger
    if (newLength > buffer.length) {
      const old = buffer;
      buffer = Buffer.allocUnsafe(nextPowerOfTwo(newLength));
      old.copy(buffer);
    }
    // Copy the new data onto current buffer at current length
    buff.copy(buffer, currentLength);
    currentLength = newLength;
  }

  // Once we process some data, we need a way to remove it from the current buffer
  function removeBufferBeginning(size: number) {
    // Buffer.copy() goes from left to right so won't overwrite itself
    buffer.copy(buffer, 0, size, currentLength);
    currentLength -= size;
  }

  type ResponseResolver = {
    /**
     * Handle error when decoding response
     */
    reject: (error?: Error) => void;
    /**
     * Handle decoded response
     */
    resolve: (
      response: { response: RencodableData } | { error: RencodableData }
    ) => void;
  };

  // Request/Response pairs to and from Deluge are matched with an integer index
  let nextRequestId = 0;

  const resolverIdLimit = 300;

  // Buffer of pending response handlers
  const resolvers: {
    [x: number]: ResponseResolver;
  } = {};

  /**
   * Generate an integer used to uniquely identify the next response to our request
   */
  function nextId() {
    const ret = nextRequestId++;
    // Trap to some smaller positive integer to prevent resolve array from blowing up in size
    if (nextRequestId >= resolverIdLimit) nextRequestId = 0;
    return ret;
  }

  /**
   * Get the resolve/reject pair saved by their unique ID
   * @param id deluge response ID
   */
  function getResolvers(id: number) {
    const ret = resolvers[id];
    delete resolvers[id];
    return ret;
  }

  // Event emitter to pass on asynchronous events (among others)
  const events = new EventEmitter();

  /**
   * Detect message and payload type and route it appropriately
   *
   * @param payload Decoded payload from server
   */
  function handlePayload(payload: RencodableData) {
    const RESPONSE = 1;
    const ERROR = 2;
    const EVENT = 3;

    debug('Decoded Data!');
    debug(payload);

    const [type, id, data] = <[number, number | string, RencodableData]>payload;

    if (type == RESPONSE) {
      getResolvers(<number>id).resolve({ response: data });
    } else if (type == ERROR) {
      getResolvers(<number>id).resolve({ error: data });
    } else if (type == EVENT) {
      events.emit('delugeEvent', { name: id, data });
    } else {
      events.emit('decodingError', 'Invalid payload type received:', type);
    }
  }

  // When we get some data from the socket connection to the server
  socket.on('data', data => {
    appendToIncomingBuffer(data);

    // Can't do anything if the current length is too short to even hold a type marker
    while (currentLength > 0) {
      // Extract header byte
      const header = buffer[0];

      // Detect common zlib header as format from Deluge ^1.0.0
      if (header == 0x78) {
        let payload;
        try {
          // Decode payload
          payload = decode(
            Buffer.from(pako.inflate(buffer.slice(0, currentLength)))
          );
          // Remove parsed data, only if decoding did not fail
          removeBufferBeginning(currentLength);
        } catch (err) {
          // This is expected if we're receiving a large chunk of data and it got chunked by the network.
          debug('Error inflating data. Expected for chunked large responses.');
          debug(err);
          // Don't continue. We're waiting for more data.
          break;
        }
        // Handle decoded payload
        handlePayload(payload);
        // Loop because we might have more data to parse
        continue;
      }

      // Deluge ^2.0.0 (under development)
      if (header == 1) {
        // Next 4 bytes are payload size. Can't do much without them.
        if (currentLength < 5) break;
        // Read payload size.
        const payloadLength = buffer.readInt32BE(1);
        // Compute total packet length
        const packetLength = 5 + payloadLength;
        // Make sure we have all the data we need to parse.
        if (currentLength < packetLength) break;

        // Extract the payload and decode it
        const payload = decode(
          Buffer.from(pako.inflate(buffer.slice(5, payloadLength)))
        );
        // Remove parsed data
        removeBufferBeginning(packetLength);
        // Handle decoded payload
        handlePayload(payload);
        // Loop because we might have more data to parse
        continue;
      }

      // Future version of Deluge?
      events.emit('decodingError', 'Invalid header received:', header);
      break;
    }
  });

  /**
   * Encode and send data via the Socket in a format that Deluge expects
   *
   * @param data Encodable data to be sent
   * @param cb Callback to call when data actually sent
   */
  function rawSend(data: RencodableData, cb: (err?: Error) => void) {
    // Encode the data as Deluge expects
    let buff = pako.deflate(encode(data));

    if (protocolVersion == 0) {
      // Don't need to do anything. Just raw send encoded buffer.
    } else if (protocolVersion == 1) {
      // TODO: Test this with deluge dev version
      const header = Buffer.allocUnsafe(5);
      // Add protocol version header
      header.writeUInt8(protocolVersion, 0);
      // And payload length
      header.writeUInt32BE(buff.length, 1);
      // Join the two
      buff = Buffer.concat([header, buff]);
    } else {
      // Trying to use future version?
      throw Error('Unknown protocol version!');
    }

    // Low level socket write
    socket.write(buff, cb);
  }

  // Check if data is an object we want to parse
  function isObject(x: any) {
    if (typeof x !== 'object') return false;
    if (x === null) return false;

    // Might as well keep these
    if (x instanceof RegExp) return false;
    if (x instanceof Error) return false;
    if (x instanceof Date) return false;

    return true;
  }

  // Resolve when all Promises deeply in objects or arrays resolve
  async function allPromises(
    data: AwaitableRencodableData
  ): Promise<RencodableData> {
    // Resolve any promise or get raw data
    const dataResolved = await data;

    // Even if dataResolved is a function, null, or some other non RencodableData, let something else error
    if (!isObject(dataResolved)) return <RencodableData>dataResolved;

    if (Array.isArray(dataResolved)) {
      // If we're checking an array, recurse and resolve everything inside
      return Promise.all(
        (<ArrayAwaitableRencodable>dataResolved).map(allPromises)
      );
    }

    // At this point we know we'll be returning some object
    const ret: RencodableObject = {};

    const keys = Object.keys(<ObjectAwaitableRencodable>dataResolved);
    for (let i = 0; i < keys.length; i++) {
      ret[keys[i]] = await allPromises(
        (<ObjectAwaitableRencodable>dataResolved)[keys[i]]
      );
    }

    return ret;
  }

  // Expected response of default API
  type SentDefault = null;
  type ResultDefault<T> = T;

  // Expected response of alternate API
  type SentAlternate = null | { error: Error };
  type ResultAlternate<T> = { error: [] | {} | string } | { response: T };

  // TODO: See if we can return Default or Alternate response types based on function arguments
  type Sent = SentDefault | SentAlternate;
  type Result<T> = ResultDefault<T> | ResultAlternate<T>;

  // TODO: T must be one of RencodableData
  type ResponseType<T> = {
    result: Promise<Result<T>>;
    sent: Promise<Sent>;
  };

  // Handle a response. cameCase it if needed and possible
  function parseResponse(data: RencodableData) {
    if (!camelCaseResponses) return data;
    // Try catch is easy way to handle
    try {
      return (camelCaseKeys as any)(data, { deep: true });
    } catch (e) {}
    return data;
  }

  /**
   * Encode and send a Deluge RPC message with Promised responses
   *
   * @param method Deluge RPC method name
   * @param args Any arguments to be passed to the RPC method
   * @param kwargs Any named arguments to be passed to the RPC method
   * @returns An object with two Promises. One for if the data was sent on the wire. The second if the response has been received.
   */
  function request(
    method: Awaitable<string>,
    args:
      | ArrayAwaitableRencodable
      | ObjectAwaitableRencodable
      | Awaitable<null> = [],
    kwargs: ObjectAwaitableRencodable | Awaitable<null> = {}
  ): ResponseType<RencodableData> {
    // Get next response ID
    const id = nextId();

    // Create the result promise that will be resolved when we receive the response from the server
    const result = new Promise<RencodableData>((resolve, reject) => {
      resolvers[id] = {
        resolve: (data: RencodableData) => resolve(parseResponse(data)),
        reject,
      };
    });

    // Create the sent promise that will be resolved when the message is sent on the wire.
    const sent = new Promise<Sent>(async (resolve, reject) => {
      // DEBATE: Should we also reject our result?
      // reject = (...args) => {getResolvers(id).reject(...args); reject(...args);};

      // TODO: confirm this works as intended
      socket.once('error', reject);

      let argsRes = (await allPromises(args)) || [];
      let kwargsRes = (await allPromises(kwargs)) || {};
      const methodRes = await allPromises(method);

      // Handle calls with no list arguments
      if (!Array.isArray(argsRes)) {
        kwargsRes = argsRes;
        argsRes = [];
      }

      try {
        rawSend([[id, methodRes, argsRes, kwargsRes]], () => {
          // Clean up after ourselves
          socket.removeListener('error', reject);
          resolve();
        });
      } catch (e) {
        // Probably an error resolving all of the passed arguments
        socket.removeListener('error', reject);
        reject(e);
      }
    });

    return { result, sent };
  }

  type FlatMap = { [x: string]: string };
  type AwaitableFlatMap = Awaitable<{ [x: string]: Awaitable<string> }>;

  type FileDump = string | Buffer;

  type TorrentOptions = FlatMap;

  /**
   * Helper function to convert a Buffer to a base64 encoded string as Deluge expects it.
   *
   * @param dump Buffer of file (or base64 encoded string)
   * @returns Promised base64 string
   */
  async function handleFiledump(dump: Awaitable<FileDump>) {
    const content = await dump;
    if (content instanceof Buffer) return content.toString('base64');
    return content;
  }

  async function handleOptions(options: AwaitableRencodableData) {
    const opts = await allPromises(options);
    if (typeof opts != 'object' || opts === null) return opts;
    return <RencodableObject | RencodableArray>(
      (snakeCaseKeys as any)(opts, { deep: true })
    );
  }

  // Main API
  const camelCore = {
    addTorrentFile: (
      filename: Awaitable<string>,
      filedump: Awaitable<FileDump>,
      torrentOptions: Awaitable<TorrentOptions | null>
    ) =>
      // TODO: Return type
      request('core.add_torrent_file', [
        filename,
        handleFiledump(filedump),
        handleOptions(torrentOptions),
      ]),

    addTorrentUrl: (
      url: Awaitable<string>,
      torrentOptions: Awaitable<TorrentOptions | null>,
      options: Awaitable<{ headers?: Awaitable<FlatMap> } | null>
    ) =>
      // TODO: Return type
      request(
        'core.add_torrent_url',
        [url, handleOptions(torrentOptions)],
        handleOptions(options as AwaitableRencodableData) as
          | ObjectAwaitableRencodable
          | Awaitable<null>
      ),

    addTorrentMagnet: (
      uri: Awaitable<string>,
      torrentOptions: Awaitable<TorrentOptions | null>
    ) =>
      // TODO: Return type
      request('core.add_torrent_magnet', [uri, handleOptions(torrentOptions)]),

    removeTorrent: (
      torrentId: Awaitable<string>,
      removeData: Awaitable<boolean>
    ) =>
      // TODO: Return type
      request('core.remove_torrent', [torrentId, removeData]),

    getSessionStatus: (keys: Awaitable<Awaitable<string>[]>) =>
      // TODO: Return type
      request('core.get_session_status', [keys] as ArrayAwaitableRencodable),

    // TODO: Return type
    getCacheStatus: () => request('core.get_cache_status'),

    forceReannounce: (torrentIds: Awaitable<Awaitable<string>[]>) =>
      // TODO: Return type
      request('core.force_reannounce', [
        torrentIds,
      ] as ArrayAwaitableRencodable),

    pauseTorrent: (torrentIds: Awaitable<Awaitable<string>[]>) =>
      // TODO: Return type
      request('core.pause_torrent', [torrentIds] as ArrayAwaitableRencodable),

    connectPeer: (
      torrentId: Awaitable<string>,
      ip: Awaitable<string>,
      port: Awaitable<number>
    ) =>
      // TODO: Return type
      request('core.connect_peer', [torrentId, ip, port]),

    moveStorage: (
      torrentIds: Awaitable<Awaitable<string>[]>,
      dest: Awaitable<string>
    ) =>
      // TODO: Return type
      request('core.move_storage', [
        torrentIds,
        dest,
      ] as ArrayAwaitableRencodable),

    pauseAllTorrents: () =>
      // TODO: Return type
      <ResponseType<null>>request('core.pause_all_torrents'),

    resumeAllTorrents: () =>
      // TODO: Return type
      <ResponseType<null>>request('core.resume_all_torrents'),

    resumeTorrent: (torrentIds: Awaitable<Awaitable<string>[]>) =>
      // TODO: Return type
      request('core.resume_torrent', [torrentIds] as ArrayAwaitableRencodable),

    getTorrentStatus: (
      torrentId: Awaitable<string>,
      keys: Awaitable<Awaitable<string>[]>,
      options: Awaitable<{ diff?: Awaitable<boolean> }>
    ) =>
      // TODO: Return type
      request(
        'core.get_torrent_status',
        [torrentId, keys] as ArrayAwaitableRencodable,
        handleOptions(options as AwaitableRencodableData) as
          | ObjectAwaitableRencodable
          | Awaitable<null>
      ),

    // TODO: Return type
    getTorrentsStatus: (
      filterDict: Awaitable<FlatMap>,
      keys: Awaitable<Awaitable<string>[]>,
      options: Awaitable<{ diff?: Awaitable<boolean> }>
    ) =>
      request(
        'core.get_torrents_status',
        [filterDict, keys] as ArrayAwaitableRencodable,
        handleOptions(options as AwaitableRencodableData) as
          | ObjectAwaitableRencodable
          | Awaitable<null>
      ),

    getFilterTree: (options: {
      showZeroHits?: Awaitable<boolean>;
      hideCats?: Awaitable<Awaitable<string>[]>;
    }) =>
      // TODO: Return type
      request(
        'core.get_filter_tree',
        handleOptions(options as AwaitableRencodableData) as
          | ObjectAwaitableRencodable
          | Awaitable<null>
      ),

    getSessionState: () =>
      request('core.get_session_state') as ResponseType<string[]>,

    // TODO: Return type
    getConfig: () => request('core.get_config'),

    getConfigValue: (key: Awaitable<string>) =>
      // TODO: Return type
      request('core.get_config_value', [key]),

    getConfigValues: (keys: Awaitable<Awaitable<string>[]>) =>
      // TODO: Return type
      request('core.get_config_values', [keys] as ArrayAwaitableRencodable),

    setConfig: (config: Awaitable<FlatMap>) =>
      // TODO: Return type
      request('core.set_config', [config]),

    getListenPort: () =>
      request('core.get_listen_port') as ResponseType<number>,

    getNumConnections: () =>
      request('core.get_num_connections') as ResponseType<number>,

    getAvailablePlugins: () =>
      request('core.get_available_plugins') as ResponseType<string[]>,

    getEnabledPlugins: () =>
      request('core.get_enabled_plugins') as ResponseType<string[]>,

    enablePlugin: (plugin: Awaitable<string>) =>
      request('core.enable_plugin', [plugin]) as ResponseType<boolean>,

    disablePlugin: (plugin: Awaitable<string>) =>
      request('core.disable_plugin', [plugin]) as ResponseType<boolean>,

    forceRecheck: (torrentIds: Awaitable<Awaitable<string>[]>) =>
      request('core.force_recheck', [
        torrentIds,
      ] as ArrayAwaitableRencodable) as ResponseType<boolean>,

    setTorrentOptions: (
      torrentIds: Awaitable<Awaitable<string>[]>,
      torrentOptions: Awaitable<TorrentOptions | null>
    ) =>
      // TODO: Return type
      request('core.set_torrent_options', [
        torrentIds,
        handleOptions(torrentOptions),
      ] as ArrayAwaitableRencodable),

    setTorrentTrackers: (
      torrentId: Awaitable<string>,
      trackers: { url: Awaitable<string>; tier: Awaitable<string> }[]
    ) =>
      // TODO: Return type
      request('core.set_torrent_trackers', [torrentId, trackers]),

    getPathSize: (path: Awaitable<string>) =>
      // TODO: Return type
      request('core.get_path_size', [path]),

    createTorrent: (
      path: Awaitable<string>,
      tracker: Awaitable<string>,
      pieceLength: Awaitable<number>,
      comment: Awaitable<string>,
      target: Awaitable<string>,
      // TODO: Check type
      webseeds: Awaitable<ArrayAwaitableRencodable>,
      priv: Awaitable<boolean>,
      createdBy: Awaitable<string>,
      // TODO: Check type
      trackers: AwaitableFlatMap,
      addToSession: Awaitable<boolean>
    ) =>
      // TODO: Return type
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
      ] as ArrayAwaitableRencodable),

    uploadPlugin: (
      filename: Awaitable<string>,
      filedump: Awaitable<FileDump>
    ) =>
      // TODO: Return type
      request('core.upload_plugin', [filename, handleFiledump(filedump)]),

    // TODO: Return types

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
    // TODO: Return types

    getMethodList: () => request('daemon.get_method_list'),
    info: () => request('daemon.info'),
    shutdown: () => request('daemon.shutdown'),
    login: (username: Awaitable<string>, password: Awaitable<string>) =>
      request('daemon.login', [username, password]),
  };

  // Final API with camelCase or snake_case
  // We could do this more programmatically but this helps the TypeScript Compiler more
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
