import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickModel } from '../../extension/lib/models.js';

test('un modelo elegido a mano se respeta siempre', () => {
  assert.equal(pickModel('tiny', { webgpu: true, vendor: 'apple' }), 'tiny');
  assert.equal(pickModel('small', { webgpu: false, vendor: '' }), 'small');
});

test('en automático, una gráfica potente usa el modelo preciso', () => {
  assert.equal(pickModel('auto', { webgpu: true, vendor: 'apple' }), 'small');
  assert.equal(pickModel('auto', { webgpu: true, vendor: 'NVIDIA' }), 'small');
  assert.equal(pickModel('auto', { webgpu: true, vendor: 'amd' }), 'small');
});

test('en automático, una gráfica integrada o desconocida usa el equilibrado', () => {
  assert.equal(pickModel('auto', { webgpu: true, vendor: 'intel' }), 'base');
  assert.equal(pickModel('auto', { webgpu: true, vendor: '' }), 'base');
});

test('en automático, sin WebGPU se usa el equilibrado', () => {
  assert.equal(pickModel('auto', { webgpu: false, vendor: 'apple' }), 'base');
});

test('un valor desconocido se trata como automático', () => {
  assert.equal(pickModel(undefined, { webgpu: true, vendor: 'apple' }), 'small');
});
