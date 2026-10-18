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

// Allow router mocks.
// eslint-disable-next-line no-undef
jest.mock('next/router', () => require('next-router-mock'));
