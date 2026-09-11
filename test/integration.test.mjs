import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(import.meta.dirname, '..');
const fakeCodex = path.join(root, 'test/fixtures/fake-codex.sh');

async function connect() {
  await chmod(fakeCodex, 0o755);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'dist/index.js')],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

function parsed(result) {
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

test('advertises the agent-oriented tool set and checks the CLI', async t => {
  const { client } = await connect();
  t.after(() => client.close());
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name);
  for (const name of ['start_codex_job', 'resume_codex_job', 'read_codex_job', 'stop_codex_job', 'start_codex_session']) {
    assert.ok(names.includes(name), name);
  }
  const check = parsed(await client.callTool({ name: 'check_codex_cli', arguments: { codex_command: fakeCodex } }));
  assert.equal(check.available, true);
});

test('runs and incrementally polls an asynchronous job', async t => {
  const { client } = await connect();
  t.after(() => client.close());
  const started = parsed(await client.callTool({
    name: 'start_codex_job',
    arguments: { prompt: 'test', codex_command: fakeCodex, initial_read_ms: 0 },
  }));
  assert.equal(started.running, true);
  await new Promise(resolve => setTimeout(resolve, 300));
  const finished = parsed(await client.callTool({
    name: 'read_codex_job',
    arguments: { job_id: started.jobId, since_offset: started.nextOffset },
  }));
  assert.equal(finished.running, false);
  assert.equal(finished.threadId, 'test-thread');
  assert.match(finished.output, /item.completed/);
  const empty = parsed(await client.callTool({
    name: 'read_codex_job',
    arguments: { job_id: started.jobId, since_offset: finished.nextOffset },
  }));
  assert.equal(empty.output, '');

  const resumed = parsed(await client.callTool({
    name: 'resume_codex_job',
    arguments: { thread_id: finished.threadId, prompt: 'follow up', codex_command: fakeCodex, initial_read_ms: 0 },
  }));
  assert.equal(resumed.threadId, 'test-thread');
});

test('submits interactive input and supports incremental reads', async t => {
  const { client } = await connect();
  t.after(() => client.close());
  const started = parsed(await client.callTool({
    name: 'start_codex_session',
    arguments: { codex_command: fakeCodex, initial_read_ms: 100 },
  }));
  const sent = parsed(await client.callTool({
    name: 'send_codex_input',
    arguments: {
      session_id: started.sessionId,
      text: 'hello',
      read_after_ms: 150,
      since_offset: started.nextOffset,
    },
  }));
  assert.match(sent.output, /received:hello/);
  const read = parsed(await client.callTool({
    name: 'read_codex_session',
    arguments: { session_id: started.sessionId, since_offset: sent.nextOffset },
  }));
  assert.equal(read.output, '');
  await client.callTool({ name: 'stop_codex_session', arguments: { session_id: started.sessionId, force: true } });
});

test('times out a background job and reports that state', async t => {
  const { client } = await connect();
  t.after(() => client.close());
  const started = parsed(await client.callTool({
    name: 'start_codex_job',
    arguments: { prompt: 'timeout-test', codex_command: fakeCodex, timeout_ms: 1000, initial_read_ms: 0 },
  }));
  await new Promise(resolve => setTimeout(resolve, 1200));
  const timedOut = parsed(await client.callTool({
    name: 'read_codex_job',
    arguments: { job_id: started.jobId },
  }));
  assert.equal(timedOut.running, false);
  assert.equal(timedOut.timedOut, true);
  assert.notEqual(timedOut.exitSignal, undefined);
});
