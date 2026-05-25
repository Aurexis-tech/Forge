// Server-only GitHub push.
//
// Creates a PRIVATE repo and pushes every build_file as a SINGLE initial
// commit via the Git Data API (blobs → tree → commit → ref). The token is
// only ever held in memory inside this module; it never gets logged or
// returned to a client.
//
// Why Git Data API rather than the contents-API one-file-at-a-time:
// - One commit, not N
// - Atomic from the user's point of view — either the whole tree is on
//   `main` or nothing is
// - Cleaner history

import { Octokit } from '@octokit/rest';
import type { BuildFile } from '@/lib/types';
import { deriveRepoName } from './github-name';

export { deriveRepoName };

export class GitHubPushError extends Error {
  readonly status?: number;
  readonly cause?: unknown;
  constructor(message: string, opts?: { status?: number; cause?: unknown }) {
    super(message);
    this.name = 'GitHubPushError';
    this.status = opts?.status;
    this.cause = opts?.cause;
  }
}

export interface GitHubPushInput {
  token: string;
  // Display name of the project; used to derive the repo name.
  projectName: string;
  // The owner the user authenticated as (used for uniqueness checks).
  ownerLogin: string;
  files: BuildFile[];
}

export interface GitHubPushOutput {
  repo_url: string;
  repo_name: string;
  owner: string;
  commit_sha: string;
  default_branch: string;
  files_pushed: number;
}

const MAX_FILES = 500; // sanity cap so a runaway plan can't fan out forever
const COMMIT_MESSAGE = 'Initial commit from Aurexis Forge';
const DEFAULT_BRANCH = 'main';

export async function pushBuildToGitHub(
  input: GitHubPushInput,
): Promise<GitHubPushOutput> {
  if (input.files.length === 0) {
    throw new GitHubPushError('build has no files to push');
  }
  if (input.files.length > MAX_FILES) {
    throw new GitHubPushError(
      'build has ' + input.files.length + ' files; refusing to push > ' + MAX_FILES,
    );
  }

  const octokit = new Octokit({
    auth: input.token,
    userAgent: 'aurexis-forge',
  });

  // --- 1. Find an available repo name -------------------------------------
  const base = deriveRepoName(input.projectName);
  const repoName = await findAvailableRepoName(octokit, input.ownerLogin, base);

  // --- 2. Create the private repo -----------------------------------------
  let repo;
  try {
    repo = await octokit.rest.repos.createForAuthenticatedUser({
      name: repoName,
      private: true,
      auto_init: false,
      description: 'Forged by Aurexis Forge',
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    });
  } catch (err) {
    throw wrap(err, 'failed to create repo ' + repoName);
  }

  if (!repo.data.private) {
    // GitHub MAY ignore `private:true` on accounts under certain restrictions.
    // If that ever happens, treat it as a hard failure rather than silently
    // pushing to a public repo.
    throw new GitHubPushError(
      'GitHub created the repo as public despite the private flag; aborting push',
    );
  }
  const owner = repo.data.owner.login;

  try {
    // --- 3. Blobs --------------------------------------------------------
    const blobs: Array<{ path: string; sha: string }> = [];
    for (const file of input.files) {
      const blob = await octokit.rest.git.createBlob({
        owner,
        repo: repoName,
        content: Buffer.from(file.content, 'utf8').toString('base64'),
        encoding: 'base64',
      });
      blobs.push({ path: file.path, sha: blob.data.sha });
    }

    // --- 4. Tree ---------------------------------------------------------
    const tree = await octokit.rest.git.createTree({
      owner,
      repo: repoName,
      tree: blobs.map((b) => ({
        path: b.path,
        mode: '100644',
        type: 'blob',
        sha: b.sha,
      })),
    });

    // --- 5. Commit -------------------------------------------------------
    const commit = await octokit.rest.git.createCommit({
      owner,
      repo: repoName,
      message: COMMIT_MESSAGE,
      tree: tree.data.sha,
      parents: [],
    });

    // --- 6. Point main at the commit ------------------------------------
    await octokit.rest.git.createRef({
      owner,
      repo: repoName,
      ref: 'refs/heads/' + DEFAULT_BRANCH,
      sha: commit.data.sha,
    });

    return {
      repo_url: repo.data.html_url,
      repo_name: repoName,
      owner,
      commit_sha: commit.data.sha,
      default_branch: DEFAULT_BRANCH,
      files_pushed: input.files.length,
    };
  } catch (err) {
    throw wrap(err, 'failed to push initial commit to ' + owner + '/' + repoName);
  }
}

// --- Helpers ---------------------------------------------------------------

async function findAvailableRepoName(
  octokit: Octokit,
  owner: string,
  base: string,
): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : base + '-' + (i + 1);
    try {
      await octokit.rest.repos.get({ owner, repo: candidate });
      // Exists — try the next suffix.
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return candidate;
      throw wrap(err, 'failed to check repo name availability');
    }
  }
  throw new GitHubPushError('could not find an available repo name after 50 attempts');
}

function wrap(err: unknown, prefix: string): GitHubPushError {
  const status = (err as { status?: number }).status;
  const msg = err instanceof Error ? err.message : String(err);
  return new GitHubPushError(prefix + ': ' + msg, { status, cause: err });
}
