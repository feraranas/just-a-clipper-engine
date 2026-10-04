import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { request as httpRequest } from 'node:http';
import process from 'node:process';
import { URL } from 'node:url';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createJobStore } from './job-store.mjs';
import { createLocalRunner } from './local-runner.mjs';
import { runJobWorker } from './job-worker.mjs';
import { startMcpServer } from './server.mjs';

const scratch = [];
async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'audiogram-mcp-'));
  scratch.push(dir);
  return dir;
}
afterEach(async () => Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

test('job store deduplicates an active video and persists status across reopen', async () => {
  const dir = await tempDir();
  const filename = path.join(dir, 'jobs.sqlite');
  let store = createJobStore(filename);
  const first = await store.createOrGetJob({ videoId: 'abcdefghijk', sourceUrl: 'https://youtu.be/abcdefghijk' });
  const duplicate = await store.createOrGetJob({ videoId: 'abcdefghijk', sourceUrl: 'https://youtu.be/abcdefghijk' });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.jobId, first.job.jobId);
  await store.markRunning(first.job.jobId, 4321);
  await store.setResult(first.job.jobId, { status: 'complete', title: 'Talk', artifacts: ['out/treatments/a.mp4'] });
  store.close();
  store = createJobStore(filename);
  assert.equal((await store.getJob(first.job.jobId)).status, 'complete');
  store.close();
});

test('runner launches detached worker with argument array and reports queued status', async () => {
  const dir = await tempDir();
  const store = createJobStore(path.join(dir, 'jobs.sqlite'));
  const calls = [];
  const runner = createLocalRunner({
    jobStore: store, projectRoot: dir, workerPath: '/project/plugins/audiogram-helper/job-worker.mjs',
    spawnProcess: (...args) => { calls.push(args); return { pid: 1234, unref() {} }; },
    isProcessAlive: () => true,
  });
  const result = await runner.start({ url: 'https://youtu.be/abcdefghijk', videoId: 'abcdefghijk' });
  assert.equal(result.status, 'running');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['/project/plugins/audiogram-helper/job-worker.mjs', '--job-id', result.jobId, '--url', 'https://youtu.be/abcdefghijk']);
  assert.deepEqual(calls[0][2], { cwd: dir, detached: true, shell: false, stdio: 'ignore' });
  store.close();
});

test('worker parses the stable CLI contract and persists terminal state', async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, 'jobs.sqlite');
  const store = createJobStore(storePath);
  const { job } = await store.createOrGetJob({ videoId: 'abcdefghijk', sourceUrl: 'https://youtu.be/abcdefghijk' });
  await runJobWorker({ jobId: job.jobId, sourceUrl: job.sourceUrl, projectRoot: dir, jobStorePath: storePath,
    runCommand: async () => ({ stdout: JSON.stringify({ contractVersion: 1, status: 'no_clips', source: { videoId: 'abcdefghijk', title: 'Talk', url: 'https://youtu.be/abcdefghijk' }, artifactPaths: [] }), stderr: '' }) });
  assert.equal((await store.getJob(job.jobId)).status, 'no_clips');
  store.close();
});

test('worker records malformed CLI output as failed', async () => {
  const dir = await tempDir();
  const storePath = path.join(dir, 'jobs.sqlite');
  const store = createJobStore(storePath);
  const { job } = await store.createOrGetJob({ videoId: 'abcdefghijk', sourceUrl: 'https://youtu.be/abcdefghijk' });
  await runJobWorker({ jobId: job.jobId, sourceUrl: job.sourceUrl, projectRoot: dir, jobStorePath: storePath,
    runCommand: async () => ({ stdout: 'not json', stderr: '' }) });
  assert.equal((await store.getJob(job.jobId)).status, 'failed');
  store.close();
});

test('worker records command failure and nonzero exit as failed', async (t) => {
  for (const commandError of [new Error('spawn failed'), Object.assign(new Error('CLI exited'), { code: 1 })]) {
    await t.test(commandError.message, async () => {
      const dir = await tempDir();
      const storePath = path.join(dir, 'jobs.sqlite');
      const store = createJobStore(storePath);
      const { job } = await store.createOrGetJob({ videoId: 'abcdefghijk', sourceUrl: 'https://youtu.be/abcdefghijk' });
      await runJobWorker({ jobId: job.jobId, sourceUrl: job.sourceUrl, projectRoot: dir, jobStorePath: storePath,
        runCommand: async () => { throw commandError; } });
      assert.equal((await store.getJob(job.jobId)).status, 'failed');
      store.close();
    });
  }
});

test('runner marks a stale running job failed rather than claiming it is complete', async () => {
  const dir = await tempDir();
  const store = createJobStore(path.join(dir, 'jobs.sqlite'));
  const { job } = await store.createOrGetJob({ videoId: 'abcdefghijk', sourceUrl: 'https://youtu.be/abcdefghijk' });
  store.markRunning(job.jobId, 9876);
  const runner = createLocalRunner({ jobStore: store, projectRoot: dir, isProcessAlive: () => false });
  const status = await runner.getStatus(job.jobId);
  assert.equal(status.status, 'failed');
  assert.deepEqual(status.artifacts, []);
  store.close();
});

test('MCP rejects unsupported URLs before runner dispatch and exposes create/status tools', async () => {
  const calls = [];
  const runner = { start: async (input) => { calls.push(input); return { jobId: 'job-1', status: 'queued' }; }, getStatus: async () => ({ jobId: 'job-1', status: 'queued' }) };
  const server = await startMcpServer({ projectRoot: process.cwd(), runner, port: 0 });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['create_audiogram', 'get_audiogram_status']);
    const invalid = await client.callTool({ name: 'create_audiogram', arguments: { url: 'https://example.com/video' } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 0);
    const accepted = await client.callTool({ name: 'create_audiogram', arguments: { url: 'https://youtu.be/abcdefghijk' } });
    assert.equal(accepted.structuredContent.status, 'queued');
    const statusId = '88f72107-f36c-4eac-990d-44e64dc6a4cc';
    runner.getStatus = async () => ({ jobId: statusId, status: 'running', artifacts: [] });
    const status = await client.callTool({ name: 'get_audiogram_status', arguments: { jobId: statusId } });
    assert.equal(status.structuredContent.jobId, statusId);
  } finally {
    await client.close();
    await server.close();
  }
});

test('server binds loopback and rejects hostile Host headers', async () => {
  const runner = { start: async () => ({ jobId: randomUUID(), status: 'queued' }), getStatus: async () => null };
  const server = await startMcpServer({ projectRoot: process.cwd(), runner, port: 0 });
  try {
    assert.equal(server.address.address, '127.0.0.1');
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(server.url, { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' } }, (response) => resolve(response));
      request.on('error', reject);
      request.end('{}');
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await server.close();
  }
});

test('server rejects malformed JSON without passing it to the MCP handler', async () => {
  const runner = { start: async () => assert.fail('malformed request dispatched'), getStatus: async () => null };
  const server = await startMcpServer({ projectRoot: process.cwd(), runner, port: 0 });
  try {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(server.url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => resolve(response));
      request.on('error', reject);
      request.end('{not-json');
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await server.close();
  }
});

test('result artifact paths must be existing nonempty mp4 files under treatments', async () => {
  const dir = await tempDir();
  const treatmentDir = path.join(dir, 'out', 'treatments');
  await mkdir(treatmentDir, { recursive: true });
  await writeFile(path.join(treatmentDir, 'clip.mp4'), Buffer.from([0, 0, 0, 1]));
  const store = createJobStore(path.join(dir, 'jobs.sqlite'));
  const { job } = await store.createOrGetJob({ videoId: 'abcdefghijk', sourceUrl: 'https://youtu.be/abcdefghijk' });
  const runner = createLocalRunner({ jobStore: store, projectRoot: dir, spawnProcess: () => ({ pid: 321, unref() {} }) });
  await store.setResult(job.jobId, { status: 'complete', title: 'Talk', artifacts: ['out/treatments/clip.mp4'] });
  assert.equal((await runner.getStatus(job.jobId)).artifacts[0], 'out/treatments/clip.mp4');
  await store.setResult(job.jobId, { status: 'complete', title: 'Talk', artifacts: ['out/treatments/../../secret.mp4'] });
  assert.equal((await runner.getStatus(job.jobId)).status, 'failed');
  await writeFile(path.join(treatmentDir, 'empty.mp4'), Buffer.alloc(0));
  await store.setResult(job.jobId, { status: 'complete', title: 'Talk', artifacts: ['out/treatments/empty.mp4'] });
  assert.equal((await runner.getStatus(job.jobId)).status, 'failed');
  await store.setResult(job.jobId, { status: 'complete', title: 'Talk', artifacts: ['out/treatments/missing.mp4'] });
  assert.equal((await runner.getStatus(job.jobId)).status, 'failed');
  store.close();
});
