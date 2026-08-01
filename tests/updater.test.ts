import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.TG_TOKEN ??= 'test-token';
process.env.TG_GROUP_ID ??= '-1001234567890';
process.env.TG_OWNER_IDS ??= '123456789';
process.env.DATA_DIR ??= path.join(os.tmpdir(), `zalo-tg-updater-${process.pid}`);

const {
  checkUpstreamUpdate,
  formatUpdateNotification,
  parseGitHubCommit,
  parseUpstreamComparison,
} = await import('../src/updater.js');

test('manual update notification escapes commit and changelog text and caps entries', () => {
  const changelog = Array.from({ length: 12 }, (_, index) => `${index} feat: <change>`).join('\n');
  const text = formatUpdateNotification('<abc123>', changelog);
  assert.match(text, /&lt;abc123&gt;/);
  assert.doesNotMatch(text, /<change>/);
  assert.equal((text.match(/•/g) ?? []).length, 10);
});

test('upstream comparison uses the audited baseline and latest commit metadata', () => {
  assert.equal(parseUpstreamComparison({ ahead_by: 0 }), null);
  assert.deepEqual(parseUpstreamComparison({
    ahead_by: 2,
    commits: [
      { sha: '1111111aaaa', commit: { message: 'feat: first\n\nbody' } },
      { sha: '2222222bbbb', commit: { message: 'fix: second' } },
    ],
  }, 'abcdef0123456789abcdef0123456789abcdef01'), {
    commit: 'abcdef0',
    changelog: '2222222 fix: second\n1111111 feat: first',
  });
  assert.equal(
    parseGitHubCommit({ sha: 'abcdef0123456789abcdef0123456789abcdef01' }),
    'abcdef0123456789abcdef0123456789abcdef01',
  );
});

test('upstream check calls the public GitHub API without mutating Git', async () => {
  const requestedUrls: string[] = [];
  const result = await checkUpstreamUpdate((async (input: URL | RequestInfo) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify({
      sha: '155b6cc000000000000000000000000000000000',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
  assert.equal(result, null);
  assert.deepEqual(requestedUrls, [
    'https://api.github.com/repos/williamcachamwri/zalo-tg/commits/main',
  ]);
});

test('upstream check compares changelog only when main moved beyond the baseline', async () => {
  const responses = [
    { sha: 'abcdef0123456789abcdef0123456789abcdef01' },
    {
      ahead_by: 1,
      commits: [{ sha: 'abcdef012345', commit: { message: 'feat: newer behavior' } }],
    },
  ];
  const result = await checkUpstreamUpdate((async () => new Response(
    JSON.stringify(responses.shift()),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof fetch);
  assert.deepEqual(result, {
    commit: 'abcdef0',
    changelog: 'abcdef0 feat: newer behavior',
  });
});
