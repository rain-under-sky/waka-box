require("dotenv").config();
const { Octokit } = require("@octokit/rest");

const REQUEST_TIMEOUT_MS = 30000;
const STATS_URL =
  "https://api.wakatime.com/api/v1/users/current/stats/last_7_days";

class ActionError extends Error {
  constructor(stage, message, status) {
    super(message);
    this.stage = stage;
    this.status = status;
  }
}

function readConfig(env) {
  const required = ["GIST_ID", "GH_TOKEN", "WAKATIME_API_KEY"];
  const missing = required.filter(key => !env[key] || !env[key].trim());
  if (missing.length) {
    throw new ActionError(
      "Configuration",
      `Missing required environment variables: ${missing.join(", ")}.`
    );
  }
  return {
    gistId: env.GIST_ID.trim(),
    githubToken: env.GH_TOKEN.trim(),
    wakatimeToken: env.WAKATIME_API_KEY.trim()
  };
}

function requestError(stage, error, signal) {
  if (
    (signal && signal.aborted) ||
    (error && (error.name === "TimeoutError" || error.name === "AbortError"))
  ) {
    return new ActionError(stage, "Request timed out.");
  }
  // Never include raw error messages, headers or response bodies in logs.
  const status =
    error &&
    Number.isInteger(error.status) &&
    error.status >= 100 &&
    error.status <= 599
      ? error.status
      : undefined;
  return new ActionError(
    stage,
    "Request failed. Check credentials and access.",
    status
  );
}

async function getStats(token, fetchImpl, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let stats;
  try {
    const response = await fetchImpl(STATS_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      signal,
      redirect: "error"
    });
    if (!response.ok) {
      throw new ActionError(
        "WakaTime",
        "Unable to read stats. Check the OAuth token and read_stats.languages scope.",
        response.status
      );
    }
    stats = await response.json();
  } catch (error) {
    if (error instanceof ActionError) throw error;
    if (error instanceof SyntaxError) {
      throw new ActionError("WakaTime", "Response is not valid JSON.");
    }
    throw requestError("WakaTime", error, signal);
  }

  if (!stats || !stats.data || !Array.isArray(stats.data.languages)) {
    throw new ActionError(
      "WakaTime",
      "Response is missing language statistics."
    );
  }
  return stats;
}

async function main({
  env = process.env,
  fetchImpl = globalThis.fetch,
  createOctokit = options => new Octokit(options),
  log = console.log,
  timeoutMs = REQUEST_TIMEOUT_MS
} = {}) {
  const { gistId, githubToken, wakatimeToken } = readConfig(env);
  const stats = await getStats(wakatimeToken, fetchImpl, timeoutMs);
  const content = formatStats(stats);
  if (!content) {
    log("No language statistics for the last 7 days; leaving gist unchanged.");
    return;
  }
  const octokit = createOctokit({
    auth: githubToken,
    request: { fetch: fetchImpl },
    // Report failures once at the action boundary, without request metadata.
    log: { error: () => {} }
  });
  await updateGist(octokit, gistId, content, timeoutMs);
  log("Successfully updated gist with WakaTime statistics.");
}

function trimRightStr(str, len) {
  // Ellipsis takes 3 positions, so the index of substring is 0 to total length - 3.
  return str.length > len ? str.substring(0, len - 3) + "..." : str;
}

function formatStats(stats) {
  const lines = [];
  for (let i = 0; i < Math.min(stats.data.languages.length, 5); i++) {
    const data = stats.data.languages[i];
    if (
      !data ||
      typeof data.name !== "string" ||
      typeof data.text !== "string" ||
      !Number.isFinite(data.percent) ||
      data.percent < 0 ||
      data.percent > 100
    ) {
      throw new ActionError(
        "WakaTime",
        "Response contains invalid language statistics."
      );
    }
    const { name, percent, text: time } = data;

    const line = [
      trimRightStr(name, 10).padEnd(10),
      time.padEnd(14),
      generateBarChart(percent, 21),
      String(percent.toFixed(1)).padStart(5) + "%"
    ];

    lines.push(line.join(" "));
  }

  return lines.join("\n");
}

async function updateGist(octokit, gistId, content, timeoutMs) {
  let gist;
  const getSignal = AbortSignal.timeout(timeoutMs);
  try {
    gist = await octokit.gists.get({
      gist_id: gistId,
      request: { signal: getSignal, redirect: "error" }
    });
  } catch (error) {
    throw requestError("Get gist", error, getSignal);
  }
  const files = gist && gist.data && gist.data.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new ActionError("Get gist", "Response is missing gist files.");
  }
  // Get original filename to update that same file.
  const filename = Object.keys(files)[0];
  if (!filename) {
    throw new ActionError("Get gist", "Gist has no files to update.");
  }
  if (!files[filename] || typeof files[filename] !== "object") {
    throw new ActionError(
      "Get gist",
      "Response contains an invalid gist file."
    );
  }
  const updateSignal = AbortSignal.timeout(timeoutMs);
  try {
    await octokit.gists.update({
      gist_id: gistId,
      request: { signal: updateSignal, redirect: "error" },
      files: {
        [filename]: {
          filename: `📊 Weekly development breakdown`,
          content
        }
      }
    });
  } catch (error) {
    throw requestError("Update gist", error, updateSignal);
  }
}

function generateBarChart(percent, size) {
  const syms = "░▏▎▍▌▋▊▉█";

  const frac = Math.floor((size * 8 * percent) / 100);
  const barsFull = Math.floor(frac / 8);
  if (barsFull >= size) {
    return syms.substring(8, 9).repeat(size);
  }
  const semi = frac % 8;

  return [syms.substring(8, 9).repeat(barsFull), syms.substring(semi, semi + 1)]
    .join("")
    .padEnd(size, syms.substring(0, 1));
}

async function run(options, runtime = process) {
  try {
    await main(options);
  } catch (error) {
    const summary =
      error instanceof ActionError
        ? `${error.stage}${error.status ? ` (HTTP ${error.status})` : ""}: ${
            error.message
          }`
        : "Unexpected failure while updating WakaTime gist.";
    console.error(summary);
    runtime.exitCode = 1;
  }
}

if (require.main === module) {
  run();
}

module.exports = { main, run, formatStats, generateBarChart };
