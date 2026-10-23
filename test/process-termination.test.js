import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { terminateChild } from '../scripts/initialize-lotus.mjs'

function fixture() {
  const killed = [], invoked = []
  const child = { pid: 12345, kill: signal => killed.push(signal) }
  const killer = new EventEmitter()
  killer.unref = () => {}
  const spawn = (...args) => { invoked.push(args); return killer }
  return {child, killer, spawn, killed, invoked}
}

test('Windows taskkill asynchronous error falls back once to the direct child handle', () => {
  const f = fixture()
  terminateChild(f.child, 'SIGKILL', {platform:'win32', spawn:f.spawn})
  assert.deepEqual(f.invoked[0], ['taskkill.exe', ['/PID', '12345', '/T', '/F'], {windowsHide:true, stdio:'ignore'}])
  f.killer.emit('error', new Error('restricted process-tree access'))
  f.killer.emit('exit', 1)
  assert.deepEqual(f.killed, ['SIGKILL'])
})

test('Windows taskkill nonzero exit falls back but a successful exit does not', () => {
  for (const code of [0, 1]) {
    const f = fixture()
    terminateChild(f.child, 'SIGTERM', {platform:'win32', spawn:f.spawn})
    f.killer.emit('exit', code)
    assert.deepEqual(f.killed, code === 0 ? [] : ['SIGTERM'])
  }
})

test('Windows taskkill synchronous launch failure falls back to the direct child handle', () => {
  const f = fixture()
  terminateChild(f.child, 'SIGKILL', {platform:'win32', spawn:() => { throw new Error('spawn failed') }})
  assert.deepEqual(f.killed, ['SIGKILL'])
})
