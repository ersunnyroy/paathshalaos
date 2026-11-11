/**
 * `s3rver` ships no types. Declared here rather than pulled from
 * DefinitelyTyped because only the suite uses it and only these four members:
 * an in-process S3 server for the storage tests to sign against.
 */
declare module 's3rver' {
  interface S3rverOptions {
    port?: number;
    address?: string;
    silent?: boolean;
    directory: string;
    configureBuckets?: Array<{ name: string; configs: string[] }>;
  }
  export default class S3rver {
    constructor(options: S3rverOptions);
    run(): Promise<{ address: string; port: number }>;
    close(): Promise<void>;
  }
}
