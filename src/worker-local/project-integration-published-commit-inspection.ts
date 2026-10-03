import { realpath } from "node:fs/promises";

import {
  normalizeProjectRelativePath,
  type InspectedIntegrationCommit,
} from "@vioxen/subscription-runtime/worker-core";

type GitRead = (args: readonly string[], cwd: string) => Promise<{ readonly stdout: string }>;

export async function publishedIntegrationRemoteRepository(input: {
  readonly workspacePath: string;
  readonly remote: string;
  readonly git: GitRead;
}): Promise<string> {
  const workspacePath = await realpath(input.workspacePath);
  const url = (await input.git(["remote", "get-url", input.remote], workspacePath)).stdout.trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error("published_commit_adoption_github_remote_required");
  return match[1]!.toLowerCase();
}

export async function inspectPublishedIntegrationCommit(input: {
  readonly workspacePath: string;
  readonly commitSha: string;
  readonly git: GitRead;
}): Promise<InspectedIntegrationCommit> {
  if (!/^[a-f0-9]{40}$/.test(input.commitSha)) throw new Error("published_commit_sha_invalid");
  const workspacePath = await realpath(input.workspacePath);
  const type = (await input.git(["cat-file", "-t", input.commitSha], workspacePath)).stdout.trim();
  if (type !== "commit") throw new Error("published_commit_object_required");
  const object = (await input.git(["cat-file", "-p", input.commitSha], workspacePath)).stdout;
  const separator = object.indexOf("\n\n");
  if (separator < 0) throw new Error("published_commit_object_invalid");
  const headers = object.slice(0, separator).split("\n");
  const header = (name: string) => headers.filter((line) => line.startsWith(`${name} `)).map((line) => line.slice(name.length + 1));
  const tree = header("tree");
  const parents = header("parent");
  const authors = header("author");
  const committers = header("committer");
  if (tree.length !== 1 || authors.length !== 1 || committers.length !== 1 || parents.length !== 1 ||
      !/^[a-f0-9]{40}$/.test(tree[0]!) || !/^[a-f0-9]{40}$/.test(parents[0]!)) {
    throw new Error("published_commit_object_invalid");
  }
  const parseIdentity = (raw: string) => {
    const match = /^(.*) <([^<>]+)> \d+ [+-]\d{4}$/.exec(raw);
    if (!match) throw new Error("published_commit_identity_invalid");
    return { name: match[1]!, email: match[2]! };
  };
  const message = object.slice(separator + 2).replace(/\n$/, "");
  const files = (await input.git([
    "diff", "--name-only", "--no-renames", "-z", parents[0]!, input.commitSha, "--",
  ], workspacePath)).stdout.split("\0").filter(Boolean).map(normalizeProjectRelativePath).sort();
  return {
    commitSha: input.commitSha, tree: tree[0]!, parentCommits: parents,
    author: parseIdentity(authors[0]!), committer: parseIdentity(committers[0]!),
    message, files,
  };
}
