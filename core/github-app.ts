/**
 * GitHub App Authentication Engine (T5.2).
 * Handles GitHub App JWT generation (RS256), installation resolution,
 * and minting short-lived repository installation access tokens.
 */

import crypto from "node:crypto";

export interface GitHubAppCredentials {
  appId: string;
  privateKeyPem: string;
  installationId?: string;
}

export interface MintTokenOptions {
  appId: string;
  privateKeyPem: string;
  installationId?: string;
  repositoryName?: string;
  fetchFn?: typeof fetch;
}

export interface GitHubInstallationToken {
  token: string;
  expiresAt: string;
  permissions: Record<string, string>;
  repositorySelection?: string;
}

/**
 * Creates a signed JWT for GitHub App authentication (valid for 10 minutes).
 */
export function createGitHubAppJwt(
  appId: string,
  privateKeyPem: string,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iat: nowEpochSeconds - 60, // 60s in the past to allow for clock drift
    exp: nowEpochSeconds + 600, // 10 minutes max expiration
    iss: appId,
  };

  const encodeBase64Url = (obj: Record<string, unknown>): string => {
    return Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  };

  const headerB64 = encodeBase64Url(header);
  const payloadB64 = encodeBase64Url(payload);
  const signInput = `${headerB64}.${payloadB64}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signInput);
  const signature = signer.sign(privateKeyPem, "base64url");

  return `${signInput}.${signature}`;
}

/**
 * Mints an installation access token for a given GitHub repository or installation.
 */
export async function mintGitHubInstallationToken(
  options: MintTokenOptions,
): Promise<GitHubInstallationToken> {
  const fetchImpl = options.fetchFn || fetch;
  const jwt = createGitHubAppJwt(options.appId, options.privateKeyPem);

  let installationId = options.installationId;

  // If installationId not provided, resolve it by repository
  if (!installationId && options.repositoryName) {
    const repoRes = await fetchImpl(
      `https://api.github.com/repos/${options.repositoryName}/installation`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "pi-cloud-agents",
        },
      },
    );

    if (!repoRes.ok) {
      throw new Error(
        `Failed to resolve GitHub App installation for repo '${options.repositoryName}': HTTP ${repoRes.status}`,
      );
    }

    const repoData = (await repoRes.json()) as { id?: number };
    if (!repoData.id) {
      throw new Error("Invalid GitHub API response: installation ID not found.");
    }
    installationId = String(repoData.id);
  }

  if (!installationId) {
    throw new Error("Cannot mint installation token without installationId or repositoryName.");
  }

  const tokenRes = await fetchImpl(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "pi-cloud-agents",
      },
      body: JSON.stringify(
        options.repositoryName
          ? {
              repositories: [options.repositoryName.split("/")[1] || options.repositoryName],
            }
          : {},
      ),
    },
  );

  if (!tokenRes.ok) {
    throw new Error(`Failed to mint GitHub App installation access token: HTTP ${tokenRes.status}`);
  }

  const tokenData = (await tokenRes.json()) as {
    token: string;
    expires_at: string;
    permissions?: Record<string, string>;
    repository_selection?: string;
  };

  return {
    token: tokenData.token,
    expiresAt: tokenData.expires_at,
    permissions: tokenData.permissions || {},
    repositorySelection: tokenData.repository_selection,
  };
}
