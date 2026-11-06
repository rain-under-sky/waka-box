// Preload for CLI tests: no outbound network requests are allowed.
const assert = require("node:assert/strict");
const scenario = process.env.WAKA_BOX_TEST_SCENARIO;
if (scenario === "missing") process.env.GH_TOKEN = "";
let requests = 0;

for (const protocol of ["node:http", "node:https"]) {
  require(protocol).request = () => {
    throw new Error("Unexpected outbound request in offline CLI test");
  };
}

globalThis.fetch = async (url, options) => {
  requests++;
  assert.ok(options.signal instanceof AbortSignal);
  const waka = url.startsWith("https://api.wakatime.com/");
  const github = url.startsWith("https://api.github.com/gists/");
  assert.ok(waka || github);
  const failed =
    (waka && scenario === "waka403") ||
    (github && options.method === "GET" && scenario === "get401") ||
    (github && options.method === "PATCH" && scenario === "update403");
  const data = failed
    ? {
        message: `private server body ${process.env.GH_TOKEN} ${process.env.WAKATIME_API_KEY}`
      }
    : waka
    ? {
        data: {
          languages:
            scenario === "empty"
              ? []
              : [{ name: "JavaScript", text: "1 hr", percent: 50 }]
        }
      }
    : { files: { "original.txt": {} } };
  return new Response(JSON.stringify(data), {
    status: failed ? (scenario === "get401" ? 401 : 403) : 200,
    headers: { "content-type": "application/json" }
  });
};

process.on("beforeExit", () => {
  const expected = {
    success: 3,
    missing: 0,
    waka403: 1,
    get401: 2,
    update403: 3,
    empty: 1
  };
  assert.equal(requests, expected[scenario]);
});
