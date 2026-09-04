'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isWslEnvironment } = require('../src/platform/windowsDraftCapture');

test('detects WSL from environment variables', () => {
  assert.equal(isWslEnvironment({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    procVersion: '',
  }), true);
});

test('detects WSL from proc version', () => {
  assert.equal(isWslEnvironment({
    platform: 'linux',
    env: {},
    procVersion: 'Linux version 6.6.87.2-microsoft-standard-WSL2',
  }), true);
});

test('does not treat ordinary Linux as WSL', () => {
  assert.equal(isWslEnvironment({
    platform: 'linux',
    env: {},
    procVersion: 'Linux version 6.8.0-generic',
  }), false);
});
