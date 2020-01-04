import {
  AwaitableRencodableData,
  ObjectAwaitableRencodable,
  ArrayAwaitableRencodable,
} from './Awaitable';
import { RencodableData, RencodableObject } from 'python-rencode';

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
export async function AllPromises(
  data: AwaitableRencodableData
): Promise<RencodableData> {
  // Resolve any promise or get raw data
  const dataResolved = await data;

  // Even if dataResolved is a function, null, or some other non RencodableData, let something else error
  if (!isObject(dataResolved)) return <RencodableData>dataResolved;

  if (Array.isArray(dataResolved)) {
    // If we're checking an array, recurse and resolve everything inside
    return Promise.all(
      (<ArrayAwaitableRencodable>dataResolved).map(AllPromises)
    );
  }

  // At this point we know we'll be returning some object
  const ret: RencodableObject = {};

  const keys = Object.keys(<ObjectAwaitableRencodable>dataResolved);
  for (let i = 0; i < keys.length; i++) {
    ret[keys[i]] = await AllPromises(
      (<ObjectAwaitableRencodable>dataResolved)[keys[i]]
    );
  }

  return ret;
}
