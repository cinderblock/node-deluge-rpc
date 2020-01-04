import { RencodableData } from 'python-rencode';

export type Awaitable<T> = T | Promise<T>;

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
