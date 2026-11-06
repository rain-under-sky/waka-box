const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { main, run, formatStats, generateBarChart } = require("../index");

const env = {
  GIST_ID: "offline-gist",
  GH_TOKEN: "github-secret-for-testing",
  WAKATIME_API_KEY: "wakatime-secret-for-testing"
};
const language = { name: "JavaScript", text: "1 hr", percent: 50 };
const stats = { data: { languages: [language] } };
const gist = { files: { "original.txt": {} } };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function fixture(
  responses = [() => json(stats), () => json(gist), () => json({})]
) {
  const calls = [];
  const messages = [];
  return {
    calls,
    messages,
    options: {
      env: { ...env },
      log: message => messages.push(message),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        const response = responses[calls.length - 1];
        assert.ok(response, "Unexpected network request");
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.redirect, "error");
        return response(options);
      }
    }
  };
}

test("OAuth stats and authenticated gist read/update retain the display format", async () => {
  const f = fixture();
  await main(f.options);
  assert.equal(f.calls.length, 3);
  assert.equal(
    f.calls[0].url,
    "https://api.wakatime.com/api/v1/users/current/stats/last_7_days"
  );
  assert.equal(
    f.calls[0].options.headers.Authorization,
    `Bearer ${env.WAKATIME_API_KEY}`
  );
  assert.equal(f.calls[1].url, `https://api.github.com/gists/${env.GIST_ID}`);
  assert.equal(
    f.calls[1].options.headers.authorization,
    `token ${env.GH_TOKEN}`
  );
  assert.equal(f.calls[1].options.method, "GET");
  assert.equal(f.calls[2].options.method, "PATCH");
  assert.deepEqual(JSON.parse(f.calls[2].options.body), {
    files: {
      "original.txt": {
        filename: "📊 Weekly development breakdown",
        content: "JavaScript 1 hr           ██████████▌░░░░░░░░░░  50.0%"
      }
    }
  });
  assert.deepEqual(f.messages, [
    "Successfully updated gist with WakaTime statistics."
  ]);
});

test("keep the first five languages in API order and truncate long names", () => {
  const languages = Array.from({ length: 6 }, (_, i) => ({
    ...language,
    name: i === 0 ? "VeryLongLanguage" : `Language${i}`
  }));
  const lines = formatStats({ data: { languages } }).split("\n");
  assert.equal(lines.length, 5);
  assert.ok(lines[0].startsWith("VeryLon... "));
  assert.ok(lines[4].startsWith("Language4  "));
  assert.equal(generateBarChart(0, 21), "░".repeat(21));
  assert.equal(generateBarChart(100, 21), "█".repeat(21));
});

test("empty statistics leave gist untouched and explicitly log the skip", async () => {
  const f = fixture([() => json({ data: { languages: [] } })]);
  await main(f.options);
  assert.equal(f.calls.length, 1);
  assert.match(f.messages[0], /leaving gist unchanged/);
});

test("all required settings are validated before any request", async t => {
  for (const key of Object.keys(env)) {
    for (const value of [undefined, "", "  "]) {
      await t.test(`${key}: ${String(value)}`, async () => {
        const f = fixture([]);
        f.options.env[key] = value;
        await assert.rejects(main(f.options), error => {
          assert.equal(error.stage, "Configuration");
          assert.ok(error.message.includes(key));
          return true;
        });
        assert.equal(f.calls.length, 0);
      });
    }
  }
});

test("HTTP failures stop the flow without attempting subsequent requests", async t => {
  for (const [stage, failingIndex, status] of [
    ["WakaTime", 0, 401],
    ["WakaTime", 0, 403],
    ["WakaTime", 0, 429],
    ["WakaTime", 0, 500],
    ["Get gist", 1, 401],
    ["Get gist", 1, 404],
    ["Update gist", 2, 403],
    ["Update gist", 2, 500]
  ]) {
    await t.test(`${stage}: ${status}`, async () => {
      const responses = [() => json(stats), () => json(gist), () => json({})];
      responses[failingIndex] = () =>
        json({ message: "untrusted server detail" }, status);
      const f = fixture(responses);
      await assert.rejects(main(f.options), error => {
        assert.equal(error.stage, stage);
        assert.equal(error.status, status);
        assert.ok(!error.message.includes("untrusted"));
        return true;
      });
      assert.equal(f.calls.length, failingIndex + 1);
      assert.equal(f.messages.length, 0);
    });
  }
});

test("malformed WakaTime responses fail without touching gist", async t => {
  const invalid = [
    null,
    {},
    { data: {} },
    { data: { languages: {} } },
    ...[
      null,
      {},
      { ...language, percent: "50" },
      { ...language, percent: -1 },
      { ...language, percent: 101 },
      { ...language, name: null },
      { ...language, text: null }
    ].map(item => ({ data: { languages: [item] } }))
  ];
  for (const [i, response] of invalid.entries()) {
    await t.test(`response ${i}`, async () => {
      const f = fixture([() => json(response)]);
      await assert.rejects(main(f.options), { stage: "WakaTime" });
      assert.equal(f.calls.length, 1);
    });
  }
  const f = fixture([() => new Response("not JSON")]);
  await assert.rejects(main(f.options), /not valid JSON/);
  assert.equal(f.calls.length, 1);
  for (const percent of [NaN, Infinity, -Infinity]) {
    assert.throws(() =>
      formatStats({ data: { languages: [{ ...language, percent }] } })
    );
  }
});

test("empty or malformed gist files never trigger a PATCH", async t => {
  for (const response of [
    null,
    {},
    { files: null },
    { files: [] },
    { files: "bad" },
    { files: {} },
    { files: { "original.txt": null } }
  ]) {
    await t.test(JSON.stringify(response), async () => {
      const f = fixture([() => json(stats), () => json(response)]);
      await assert.rejects(main(f.options), { stage: "Get gist" });
      assert.equal(f.calls.length, 2);
    });
  }
});

test("every endpoint has a working abort deadline", async t => {
  for (const [stage, index] of [
    ["WakaTime", 0],
    ["Get gist", 1],
    ["Update gist", 2]
  ]) {
    await t.test(stage, async () => {
      const responses = [() => json(stats), () => json(gist), () => json({})];
      // A referenced timer lets AbortSignal.timeout fire in an otherwise idle test process.
      responses[index] = options =>
        delay(1000, null, { signal: options.signal });
      const f = fixture(responses);
      f.options.timeoutMs = 10;
      await assert.rejects(main(f.options), error => {
        assert.equal(error.stage, stage);
        assert.equal(error.message, "Request timed out.");
        return true;
      });
      assert.equal(f.calls.length, index + 1);
    });
  }
});

test("network errors are sanitized and set a nonzero exit code", async t => {
  for (const [stage, index] of [
    ["WakaTime", 0],
    ["Get gist", 1],
    ["Update gist", 2]
  ]) {
    await t.test(stage, async () => {
      const responses = [() => json(stats), () => json(gist), () => json({})];
      responses[index] = () => {
        throw new Error(
          `private server body Authorization: ${env.GH_TOKEN} ${env.WAKATIME_API_KEY}`
        );
      };
      const f = fixture(responses);
      const messages = [];
      t.mock.method(console, "error", message => messages.push(message));
      const runtime = {};
      await run(f.options, runtime);
      assert.equal(runtime.exitCode, 1);
      assert.equal(messages.length, 1);
      assert.ok(messages[0].startsWith(stage));
      assert.ok(!messages[0].includes("private"));
      assert.ok(!messages[0].includes(env.GH_TOKEN));
      assert.ok(!messages[0].includes(env.WAKATIME_API_KEY));
      assert.equal(f.calls.length, index + 1);
    });
  }
});

test("unexpected errors fail safely without printing untrusted details", async t => {
  const f = fixture();
  f.options.createOctokit = () => {
    throw new Error(env.GH_TOKEN);
  };
  const messages = [];
  t.mock.method(console, "error", message => messages.push(message));
  const runtime = {};
  await run(f.options, runtime);
  assert.equal(runtime.exitCode, 1);
  assert.deepEqual(messages, [
    "Unexpected failure while updating WakaTime gist."
  ]);
  assert.equal(f.calls.length, 1);
});

test("source and committed action bundle enforce the same CLI behavior", async t => {
  const root = path.resolve(__dirname, "..");
  for (const entry of ["index.js", "dist/index.js"]) {
    for (const scenario of [
      "success",
      "missing",
      "waka403",
      "get401",
      "update403",
      "empty"
    ]) {
      await t.test(`${entry}: ${scenario}`, () => {
        const result = spawnSync(
          process.execPath,
          [
            "--trace-deprecation",
            "--throw-deprecation",
            "--require",
            "./test-support/mock-network.cjs",
            entry
          ],
          {
            cwd: root,
            env: { ...process.env, ...env, WAKA_BOX_TEST_SCENARIO: scenario },
            encoding: "utf8",
            timeout: 10000
          }
        );
        assert.ifError(result.error);
        const success = scenario === "success" || scenario === "empty";
        assert.equal(result.status, success ? 0 : 1, result.stderr);
        if (scenario === "success")
          assert.match(result.stdout, /Successfully updated gist/);
        if (scenario === "empty")
          assert.match(result.stdout, /leaving gist unchanged/);
        if (!success) assert.ok(result.stderr.length > 0);
        if (scenario === "waka403" || scenario === "update403")
          assert.match(result.stderr, /HTTP 403/);
        if (scenario === "get401") assert.match(result.stderr, /HTTP 401/);
        assert.doesNotMatch(
          result.stderr,
          /DeprecationWarning|TypeError|private server body/
        );
        assert.ok(!result.stderr.includes(env.GH_TOKEN));
        assert.ok(!result.stderr.includes(env.WAKATIME_API_KEY));
      });
    }
  }
});
