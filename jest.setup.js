import '@testing-library/jest-dom/extend-expect';

// AUDIT-R5 P2: jsdom 没有 ReadableStream，用 Node 的 web streams polyfill（供 downstream.test.ts）
// eslint-disable-next-line @typescript-eslint/no-var-requires, no-undef
const { ReadableStream: NodeReadableStream } = require('stream/web');
// eslint-disable-next-line @typescript-eslint/no-var-requires, no-undef
const { TextEncoder: NodeTextEncoder, TextDecoder: NodeTextDecoder } = require('util');
// eslint-disable-next-line no-undef
if (typeof globalThis.ReadableStream === 'undefined') {
  // eslint-disable-next-line no-undef
  globalThis.ReadableStream = NodeReadableStream;
}
// eslint-disable-next-line no-undef
if (typeof globalThis.TextEncoder === 'undefined') {
  // eslint-disable-next-line no-undef
  globalThis.TextEncoder = NodeTextEncoder;
}
// eslint-disable-next-line no-undef
if (typeof globalThis.TextDecoder === 'undefined') {
  // eslint-disable-next-line no-undef
  globalThis.TextDecoder = NodeTextDecoder;
}

// undici 8 (from 8.x) references Blob / File / MessagePort as bare globals at
// module load (lib/web/webidl/index.js). Jest's `node` test environment does
// not expose them, so any `@jest-environment node` suite importing undici
// crashes with `ReferenceError: Blob is not defined`. Polyfill from Node
// builtins (jsdom suites already have them; the guards are no-ops there).
// eslint-disable-next-line @typescript-eslint/no-var-requires, no-undef
const { Blob: NodeBlob, File: NodeFile } = require('buffer');
// eslint-disable-next-line @typescript-eslint/no-var-requires, no-undef
const { MessagePort: NodeMessagePort } = require('worker_threads');
// eslint-disable-next-line no-undef
if (typeof globalThis.Blob === 'undefined') {
  // eslint-disable-next-line no-undef
  globalThis.Blob = NodeBlob;
}
// eslint-disable-next-line no-undef
if (typeof globalThis.File === 'undefined') {
  // eslint-disable-next-line no-undef
  globalThis.File = NodeFile;
}
// eslint-disable-next-line no-undef
if (typeof globalThis.MessagePort === 'undefined') {
  // eslint-disable-next-line no-undef
  globalThis.MessagePort = NodeMessagePort;
}
// undici 8's websocket module also references DOMException as a bare global
// at load (lib/web/websocket/stream/websocketerror.js); same treatment.
// Node exposes DOMException only as a real global (not on any builtin
// module), so Jest's `node` sandbox cannot require it — define a minimal
// polyfill class instead (name/message suffice for undici's load-time
// subclass check and for the abort-error paths the tests exercise).
// eslint-disable-next-line no-undef
if (typeof globalThis.DOMException === 'undefined') {
  // eslint-disable-next-line no-undef
  globalThis.DOMException = class DOMException extends Error {
    constructor(message = '', name = 'Error') {
      super(message);
      this.name = name;
    }
  };
}

// Allow router mocks.
// eslint-disable-next-line no-undef
jest.mock('next/router', () => require('next-router-mock'));
