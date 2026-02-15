# Authentication Guide

The agent uses Claude Code CLI in subscription mode (OAuth). Tokens are stored in `/data/claude/.claude/.credentials.json` on the server.

## Automatic Token Refresh

The app includes a background token refresh loop (`src/auth-refresh.ts`) that:
- Checks every 5 minutes if the token is close to expiry
- Refreshes via `POST https://platform.claude.com/v1/oauth/token` with `Content-Type: application/json`
- Also does a pre-flight check before every Claude CLI call

This should prevent most auth expiry issues.

## Manual Re-authentication

If the refresh token itself expires or becomes invalid, you need to do a manual OAuth flow.

### Step 1: Generate PKCE challenge

SSH into the server and run inside the container:

```bash
ssh root@YOUR_SERVER_IP
docker exec -e HOME=/data/claude <CONTAINER_ID> node -e '
const crypto = require("crypto");
const fs = require("fs");
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
const state = crypto.randomBytes(32).toString("base64url");
fs.writeFileSync("/tmp/oauth_verifier", verifier);
fs.writeFileSync("/tmp/oauth_state", state);
const url = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers&code_challenge=" + challenge + "&code_challenge_method=S256&state=" + state;
console.log(url);
'
```

### Step 2: Authorize

Open the printed URL in your browser and authorize. You'll be redirected to a page showing an auth code in the format:

```
<CODE>#<STATE>
```

### Step 3: Exchange the code

Immediately run (codes expire quickly):

```bash
docker exec -e HOME=/data/claude <CONTAINER_ID> node -e '
const fs = require("fs");
const verifier = fs.readFileSync("/tmp/oauth_verifier", "utf8").trim();
const state = fs.readFileSync("/tmp/oauth_state", "utf8").trim();
const code = "<PASTE_CODE_PART_BEFORE_HASH_HERE>";

async function exchange() {
  const resp = await fetch("https://platform.claude.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      code_verifier: verifier,
      state: state
    })
  });
  const data = await resp.json();
  if (data.access_token) {
    const creds = {
      claudeAiOauth: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || "",
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
        scopes: data.scope ? data.scope.split(" ") : ["user:inference","user:mcp_servers","user:profile","user:sessions:claude_code"],
        subscriptionType: "team",
        rateLimitTier: "default_claude_max_5x"
      }
    };
    fs.writeFileSync("/data/claude/.claude/.credentials.json", JSON.stringify(creds));
    console.log("SUCCESS - expires:", new Date(creds.claudeAiOauth.expiresAt).toISOString());
  } else {
    console.log("FAILED:", JSON.stringify(data));
  }
}
exchange();
'
```

### Step 4: Verify

```bash
docker exec -e HOME=/data/claude <CONTAINER_ID> claude auth status
docker exec -e HOME=/data/claude <CONTAINER_ID> claude -p "Say hi" --output-format json --allowedTools ""
```

## Key Details

| Item | Value |
|------|-------|
| OAuth Client ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| Token endpoint | `https://platform.claude.com/v1/oauth/token` |
| Authorize endpoint | `https://claude.ai/oauth/authorize` |
| Redirect URI | `https://platform.claude.com/oauth/code/callback` |
| Content-Type for token exchange | `application/json` (NOT form-urlencoded) |
| Credentials file | `/data/claude/.claude/.credentials.json` |
| Token exchange requires | `state` parameter (in addition to standard PKCE params) |

## Common Errors

- **"Your account does not have access to Claude"** — OAuth token expired. The auto-refresh should handle this, but if the refresh token is also dead, do the manual flow above.
- **"Invalid request format"** — Wrong Content-Type (must be `application/json`) or missing `state` parameter in token exchange.
- **Auth code expired** — Codes are short-lived. Complete Step 2 and Step 3 within ~60 seconds.
