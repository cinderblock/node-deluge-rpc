export type SharedPromise<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e?: Error) => void;
};

export function SharedPromise<T = undefined>(): Readonly<SharedPromise<T>> {
  const ret = {} as SharedPromise<T>;
  ret.promise = new Promise<T>((resolve, reject) => {
    ret.resolve = resolve;
    ret.reject = reject;
  });
  return ret;
}
