import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'fs';
import { execSync } from 'child_process';

const MAX_DIFF_CHARS = 8000;
const MAX_README_CHARS = 6000;

const SYSTEM_PROMPT = `You are a technical documentation assistant. Your job is to review a git diff and decide whether the project's README needs updating.

Only suggest README updates for user-facing changes, including:
- New CLI flags or commands
- New environment variables
- New configuration options
- New API endpoints
- Changed installation steps
- New features that users interact with directly

Do NOT suggest updates for:
- Internal refactors
- Bug fixes
- Test changes
- CI/CD changes
- Internal-only code changes
- Code style or formatting changes

Respond with JSON only — no markdown, no explanation outside the JSON object:
{
  "shouldUpdate": boolean,
  "updatedReadme": string,
  "reason": string,
  "changes": string[]
}

If shouldUpdate is false, updatedReadme should be an empty string and changes should be an empty array.
If shouldUpdate is true, updatedReadme must be the full updated README content (not a diff), and changes must be a concise list of what was added or changed.`;

interface ClaudeResponse {
  shouldUpdate: boolean;
  updatedReadme: string;
  reason: string;
  changes: string[];
}

interface AnthropicMessage {
  content: Array<{ type: string; text: string }>;
}

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function truncate(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[${label} truncated]`;
}

function parseJsonResponse(text: string): ClaudeResponse {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  return JSON.parse(stripped) as ClaudeResponse;
}

function gitExec(cmd: string): void {
  execSync(cmd, { cwd: process.cwd(), stdio: 'pipe' });
}

function gitOutput(cmd: string): string {
  return execSync(cmd, { cwd: process.cwd() }).toString().trim();
}

function configureGit(): void {
  gitExec("git config user.name 'dokku-bot'");
  gitExec("git config user.email 'dokku-bot@users.noreply.github.com'");
}

type Octokit = ReturnType<typeof github.getOctokit>;

async function postPRComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `<!-- dokku -->\n${body}`,
  });
}

async function run(): Promise<void> {
  const anthropicApiKey = core.getInput('anthropic-api-key', { required: true });
  const githubToken = core.getInput('github-token', { required: true });
  const mode = core.getInput('mode', { required: true });
  const diffFile = core.getInput('diff-file') || 'diff.txt';
  const readmePath = core.getInput('readme-path') || 'README.md';
  const prNumberRaw = core.getInput('pr-number');
  const baseBranch = core.getInput('base-branch') || 'main';

  const octokit = github.getOctokit(githubToken);
  const { owner, repo } = github.context.repo;
  const prNumber = prNumberRaw ? parseInt(prNumberRaw, 10) : null;

  let diff: string;
  if (mode === 'audit') {
    core.info('audit mode: diffing entire history against HEAD');
    const firstCommit = gitOutput('git rev-list --max-parents=0 HEAD');
    diff = gitOutput(
      `git diff ${firstCommit} HEAD -- '*.ts' '*.js' '*.py' '*.go' '*.rs' ':!**/*.test.*' ':!**/tests/**' ':!.github/**'`
    );
  } else {
    diff = readFileSafe(diffFile);
  }

  let readme = readFileSafe(readmePath);

  if (!diff.trim()) {
    core.info('no source changes, skipping');
    return;
  }

  diff = truncate(diff, MAX_DIFF_CHARS, 'diff truncated');
  readme = truncate(readme, MAX_README_CHARS, 'README truncated');

  let parsed: ClaudeResponse;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Here is the current README:\n\n${readme}\n\nHere is the git diff:\n\n${diff}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as AnthropicMessage;
    const rawText = data.content[0].text;
    parsed = parseJsonResponse(rawText);
  } catch (err) {
    core.warning(`dokku: failed to get response from Anthropic API — ${(err as Error).message}`);
    return;
  }

  const { shouldUpdate, updatedReadme, reason, changes } = parsed;

  if (!shouldUpdate) {
    if (mode === 'pr' && prNumber !== null) {
      await postPRComment(octokit, owner, repo, prNumber, `no README changes needed — ${reason}`);
    }
    core.info(`no README changes needed — ${reason}`);
    return;
  }

  if (mode === 'pr') {
    if (prNumber === null) {
      core.warning('dokku: pr mode requires pr-number input');
      return;
    }

    fs.writeFileSync(readmePath, updatedReadme, 'utf8');

    configureGit();
    gitExec(`git add ${readmePath}`);
    gitExec(`git commit -m "docs: update README via dokku"`);
    gitExec('git push');

    const changesList = changes.map(c => `- ${c}`).join('\n');
    await postPRComment(
      octokit,
      owner,
      repo,
      prNumber,
      `README updated with the following changes:\n\n${changesList}`
    );

    core.info('README updated and committed to PR branch');
  } else if (mode === 'open-pr' || mode === 'audit') {
    const sha = process.env.GITHUB_SHA ?? 'unknown';
    const branchName = `dokku/patch-${sha.slice(0, 7)}`;

    gitExec(`git checkout -b ${branchName}`);

    fs.writeFileSync(readmePath, updatedReadme, 'utf8');

    configureGit();
    gitExec(`git add ${readmePath}`);
    gitExec(`git commit -m "docs: update README via dokku"`);
    gitExec(`git push origin ${branchName}`);

    const changesList = changes.map(c => `- ${c}`).join('\n');
    const prBody = `<!-- dokku -->\nAutomated README sync by dokku.\n\n**Changes:**\n\n${changesList}`;

    await octokit.rest.pulls.create({
      owner,
      repo,
      title: 'docs: README sync',
      body: prBody,
      head: branchName,
      base: baseBranch,
    });

    core.info(`README updated — opened PR from ${branchName} into ${baseBranch}`);
  } else {
    core.warning(`dokku: unknown mode "${mode}", expected "pr", "open-pr", or "audit"`);
  }
}

run().catch(err => {
  core.warning(`dokku: unexpected error — ${(err as Error).message}`);
});
