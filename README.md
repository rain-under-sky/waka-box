<p align="center">
  <img width="400" src="https://user-images.githubusercontent.com/4658208/60469862-2e40bf00-9c2c-11e9-87f7-afe164648de4.png">
  <h3 align="center">waka-box</h3>
  <p align="center">Update a pinned gist to contain your weekly WakaTime stats</p>
</p>

---

> 📌✨ For more pinned-gist projects like this one, check out: https://github.com/matchai/awesome-pinned-gists

## Setup

### Prep work

1. Create a new public GitHub Gist (https://gist.github.com/)
1. Create a GitHub personal access token (classic) with the `gist` scope using the account that owns your gist. (https://github.com/settings/tokens/new)
1. Create a WakaTime account (https://wakatime.com/signup)
1. Get your personal WakaTime OAuth token (https://wakatime.com/oauth) with permission to read language statistics (`read_stats.languages`, or the broader `read_stats`). Plugin API keys are write-only and cannot read these statistics. Your activity does not need to be public for authenticated requests.

### Project setup

1. Fork this repo
1. Go to the repo **Settings > Secrets and variables > Actions**
1. Add the following environment variables:
   - **GIST_ID:** The ID portion from your gist url: `https://gist.github.com/matchai/`**`6d5f84419863089a167387da62dd7081`**.
   - **GH_TOKEN:** The GitHub token generated above.
   - **WAKATIME_API_KEY:** Your personal WakaTime **OAuth token**, not your plugin API key. The existing secret name is retained for compatibility; requests use Bearer authentication.

After updating secrets, manually run **Update gist with WakaTime stats** in the Actions tab. Check both the run logs and your gist's updated content. A completed update logs `Successfully updated gist with WakaTime statistics.` An empty week is explicitly logged and leaves the gist unchanged. Configuration, request, or invalid-response errors fail the action with a nonzero exit code; raw request headers and response bodies are not logged.

## Development

Use Node.js 24 or newer. To run locally, copy `sample.env` to `.env` and configure the three variables. Never commit tokens or `.env`. Running `node index.js` updates the configured gist.

```sh
npm ci
npm test
npm run build
```

Tests use simulated responses and do not need secrets or modify a real gist. Requests time out after 30 seconds. When a proxy is required, enable Node's environment proxy support with `NODE_USE_ENV_PROXY=1 node index.js`, configure `HTTPS_PROXY`/`HTTP_PROXY`, and ensure `NO_PROXY` does not bypass the target hosts. Never log credentials to diagnose network failures.

The action executes **`dist/index.js`**, not the source file. Always rebuild and commit `dist` with source changes. CI tests Node.js 24 and runs `npm run check:dist` to ensure the committed bundle is up to date.
