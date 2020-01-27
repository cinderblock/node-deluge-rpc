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

import { SharedPromise } from './utils/SharedPromise';
import { AllPromises } from './utils/AllPromises';

import {
  Awaitable,
  AwaitableRencodableData,
  ObjectAwaitableRencodable,
  ArrayAwaitableRencodable,
} from './utils/Awaitable';

export {
  Awaitable,
  AwaitableRencodableData,
  ObjectAwaitableRencodable,
  ArrayAwaitableRencodable,
} from './utils/Awaitable';

const readFilePromise = promisify(readFile);

function getDebug(d: boolean | ((...args: any[]) => void) | undefined) {
  return typeof d == 'function'
    ? d
    : d === true
    ? (...args: any[]) => console.log('DEBUG:', ...args)
    : () => {};
}

export async function loadFile(file: string) {
  return (<Buffer>await readFilePromise(file)).toString('base64');
}

export type ErrorResultV0 = { error: RencodableData; extra: RencodableData[] };

export type ErrorResultV1 = {
  error: string;
  message: string;
  traceback: string;
};

export type ErrorResult = ErrorResultV0 | ErrorResultV1;

export type SuccessResult<
  RPCResponse extends RencodableData = RencodableData
> = { value: RPCResponse };

export function isRPCError<RPCResponse extends RencodableData = RencodableData>(
  result: SuccessResult<RPCResponse> | ErrorResult,
): result is ErrorResult {
  return !!(result as ErrorResult).error;
}

export function isRPCErrorV1(error: ErrorResult): error is ErrorResult {
  return !!(error as ErrorResultV1).message;
}

/**
 * @future Timeout might be added as a response type
 */
export type RequestResult<
  RPCResponse extends RencodableData = RencodableData
> = SuccessResult<RPCResponse> | ErrorResult;

/**
 * Deluge ^1.0.0 uses version 0 (default)
 * Deluge ^2.0.0 uses version 1
 */
export type ProtocolVersion = 0 | 1;

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
    protocolVersion?: ProtocolVersion;
    /**
     * Convert all responses from Deluge to camelCase
     *
     * Default subject to change. Currently true
     */
    camelCaseResponses?: boolean;
  } = {},
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
     *
     * @future timeout handling?
     */
    reject: (error?: Error) => void;
    /**
     * Handle decoded response
     */
    resolve: (response: RequestResult) => void;
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

    if (!Array.isArray(payload)) {
      events.emit('decodingError', 'Invalid payload received:', payload);
      return;
    }

    const type = payload.shift();

    if (type == RESPONSE) {
      const [requestId, data] = payload as [number, RencodableData];

      getResolvers(requestId).resolve({ value: parseResponse(data) });
    } else if (type == ERROR) {
      if (protocolVersion === 0) {
        const [requestId, error, ...extra] = payload as [number, string];

        // The API says data is just the exception type but I think it includes all of it
        getResolvers(requestId).resolve({ error: parseResponse(error), extra });
      } else if (protocolVersion === 1) {
        const [id, exceptionType, exceptionMsg, traceback] = payload as [
          number,
          string,
          string,
          string,
        ];

        getResolvers(id).resolve({
          error: exceptionType,
          message: exceptionMsg,
          traceback,
        });
      }
    } else if (type == EVENT) {
      const [name, data] = payload as [string, string];
      events.emit('delugeEvent', { name, data: parseResponse(data) });
    } else {
      events.emit('decodingError', 'Invalid payload type received:', type);
    }
  }

  // When we get some data from the socket connection to the server
  socket.on('data', data => {
    appendToIncomingBuffer(data);

    // We automatically detect which version we're talking to upon any response because messages have predictable headers

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
            Buffer.from(pako.inflate(buffer.slice(0, currentLength))),
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
          Buffer.from(pako.inflate(buffer.slice(5, payloadLength))),
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
  function rawSend(
    data: RencodableData,
    cb: (err?: Error) => void,
    overrideVersion?: 0 | 1,
  ) {
    // Encode the data as Deluge expects
    let buff = pako.deflate(encode(data));

    if (overrideVersion === undefined) overrideVersion = protocolVersion;

    if (overrideVersion == 0) {
      // Don't need to do anything. Just raw send encoded buffer.
    } else if (overrideVersion == 1) {
      // TODO: Test this with deluge dev version
      const header = Buffer.allocUnsafe(5);
      // Add protocol version header
      header.writeUInt8(overrideVersion, 0);
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

  // Expected response of default API
  type RequestSent = void;

  // TODO: T must be one of RencodableData
  type Request<T extends RencodableData> = {
    result: Promise<RequestResult<T>>;
    sent: Promise<RequestSent>;
  };

  // Handle a response. cameCase it if needed and possible
  function parseResponse(data: RencodableData): RencodableData {
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
  function request<T extends RencodableData = RencodableData>(
    method: Awaitable<string>,
    args:
      | ArrayAwaitableRencodable
      | ObjectAwaitableRencodable
      | Awaitable<null> = [],
    kwargs: ObjectAwaitableRencodable | Awaitable<null> = {},
    protocolVersion?: ProtocolVersion,
  ): Request<T> {
    // Get next response ID
    const id = nextId();

    // Create the result promise that will be resolved when we receive the response from the server
    const result = new Promise<RequestResult<T>>((resolve, reject) => {
      resolvers[id] = {
        resolve: resolve as () => RequestResult<RencodableData>,
        reject,
      };
    });

    // Create the sent promise that will be resolved when the message is sent on the wire.
    const sent = new Promise<RequestSent>(async (resolve, reject) => {
      // DEBATE: Should we also reject our result?
      // reject = (...args) => {getResolvers(id).reject(...args); reject(...args);};

      // TODO: confirm this works as intended
      socket.once('error', reject);

      let argsRes = (await AllPromises(args)) || [];
      let kwargsRes = (await AllPromises(kwargs)) || {};
      const methodRes = await AllPromises(method);

      // Handle calls with no list arguments
      if (!Array.isArray(argsRes)) {
        kwargsRes = argsRes;
        argsRes = [];
      }

      try {
        rawSend(
          [[id, methodRes, argsRes, kwargsRes]],
          () => {
            // Clean up after ourselves
            socket.removeListener('error', reject);
            resolve();
          },
          protocolVersion,
        );
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
    const opts = await AllPromises(options);
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
      torrentOptions: Awaitable<TorrentOptions | null> = null,
    ) =>
      // TODO: Return type
      request('core.add_torrent_file', [
        filename,
        handleFiledump(filedump),
        handleOptions(torrentOptions),
      ]),

    addTorrentUrl: (
      url: Awaitable<string>,
      torrentOptions: Awaitable<TorrentOptions | null> = null,
      options: Awaitable<{ headers?: Awaitable<FlatMap> } | null> = null,
    ) =>
      // TODO: Return type
      request(
        'core.add_torrent_url',
        [url, handleOptions(torrentOptions)],
        handleOptions(options as AwaitableRencodableData) as
          | ObjectAwaitableRencodable
          | Awaitable<null>,
      ),

    addTorrentMagnet: (
      uri: Awaitable<string>,
      torrentOptions: Awaitable<TorrentOptions | null> = null,
    ) =>
      // TODO: Return type
      request('core.add_torrent_magnet', [uri, handleOptions(torrentOptions)]),

    removeTorrent: (
      torrentId: Awaitable<string>,
      removeData: Awaitable<boolean>,
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
      port: Awaitable<number>,
    ) =>
      // TODO: Return type
      request('core.connect_peer', [torrentId, ip, port]),

    moveStorage: (
      torrentIds: Awaitable<Awaitable<string>[]>,
      dest: Awaitable<string>,
    ) =>
      // TODO: Return type
      request('core.move_storage', [
        torrentIds,
        dest,
      ] as ArrayAwaitableRencodable),

    pauseAllTorrents: () =>
      // TODO: Return type
      <Request<null>>request('core.pause_all_torrents'),

    resumeAllTorrents: () =>
      // TODO: Return type
      <Request<null>>request('core.resume_all_torrents'),

    resumeTorrent: (torrentIds: Awaitable<Awaitable<string>[]>) =>
      // TODO: Return type
      request('core.resume_torrent', [torrentIds] as ArrayAwaitableRencodable),

    getTorrentStatus: (
      torrentId: Awaitable<string>,
      keys: Awaitable<Awaitable<string>[]>,
      options: Awaitable<{ diff?: Awaitable<boolean> }>,
    ) =>
      // TODO: Return type
      request(
        'core.get_torrent_status',
        [torrentId, keys] as ArrayAwaitableRencodable,
        handleOptions(options as AwaitableRencodableData) as
          | ObjectAwaitableRencodable
          | Awaitable<null>,
      ),

    // TODO: Return type
    getTorrentsStatus: (
      filterDict: Awaitable<FlatMap>,
      keys: Awaitable<Awaitable<string>[]>,
      options: Awaitable<{ diff?: Awaitable<boolean> }>,
    ) =>
      request(
        'core.get_torrents_status',
        [filterDict, keys] as ArrayAwaitableRencodable,
        handleOptions(options as AwaitableRencodableData) as
          | ObjectAwaitableRencodable
          | Awaitable<null>,
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
          | Awaitable<null>,
      ),

    getSessionState: () =>
      request('core.get_session_state') as Request<string[]>,

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

    getListenPort: () => request('core.get_listen_port') as Request<number>,

    getNumConnections: () =>
      request('core.get_num_connections') as Request<number>,

    getAvailablePlugins: () =>
      request('core.get_available_plugins') as Request<string[]>,

    getEnabledPlugins: () =>
      request('core.get_enabled_plugins') as Request<string[]>,

    enablePlugin: (plugin: Awaitable<string>) =>
      request('core.enable_plugin', [plugin]) as Request<boolean>,

    disablePlugin: (plugin: Awaitable<string>) =>
      request('core.disable_plugin', [plugin]) as Request<boolean>,

    forceRecheck: (torrentIds: Awaitable<Awaitable<string>[]>) =>
      request('core.force_recheck', [
        torrentIds,
      ] as ArrayAwaitableRencodable) as Request<boolean>,

    setTorrentOptions: (
      torrentIds: Awaitable<Awaitable<string>[]>,
      torrentOptions: Awaitable<TorrentOptions | null> = null,
    ) =>
      // TODO: Return type
      request('core.set_torrent_options', [
        torrentIds,
        handleOptions(torrentOptions),
      ] as ArrayAwaitableRencodable),

    setTorrentTrackers: (
      torrentId: Awaitable<string>,
      trackers: { url: Awaitable<string>; tier: Awaitable<string> }[],
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
      addToSession: Awaitable<boolean>,
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
      filedump: Awaitable<FileDump>,
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
      request(
        'daemon.login',
        [username, password],
        // Deluge 2.0 needs this to be non-null. 1.0 doesn't care.
        { client_version: 'deluge-rpc-socket' },
      ),
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

  function detectProtocolVersion(): Request<ProtocolVersion> {
    // This will result in an authentication error on v0 and be ignored on v1
    const { result: r0, sent: sent0 } = request<string>(
      'daemon.info',
      null,
      null,
      0,
    );

    // This will result in success on v1 and be ignored on v0
    const { result: r1, sent: sent1 } = request<string>(
      'daemon.info',
      null,
      null,
      1,
    );

    const sent = Promise.all([sent0, sent1]).then(() => {});

    const result = Promise.race<Promise<RequestResult<ProtocolVersion>>>([
      r0.then(() => ({ value: 0 })),
      r1.then(() => ({ value: 1 })),
    ]);

    return { sent, result };
  }

  return {
    request,
    events,
    core,
    daemon,
    detectProtocolVersion,
  };
}
