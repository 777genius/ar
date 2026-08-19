import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

export function buildLogicalThreadContinuationRequests(input) {
  const first = input.createRequest({
    executionId: "goal-round-1",
    runId: `${input.runIdPrefix}-round-1`,
    prompt: [
      `Remember this opaque context token for later logical-thread rounds: ${input.firstToken}`,
      `Also remember this separate long-horizon token: ${input.longHorizonToken}`,
      "Keep both tokens only in conversation context. Do not write either token into any file in this round.",
      "Edit only round-one.txt so it contains exactly ready followed by one newline.",
      "Verify context.txt still contains exactly unset followed by one newline.",
      "Verify round-three.txt still contains exactly unset followed by one newline.",
      "After the exact verification succeeds, mark the active Goal complete before the final summary.",
    ].join("\n"),
  });
  const second = input.createRequest({
    executionId: "goal-round-2",
    runId: `${input.runIdPrefix}-round-2`,
    prompt: [
      "Continue the same logical thread.",
      "Recall the first opaque context token supplied in the previous round; it is intentionally not repeated here.",
      "Edit only context.txt so it contains that exact token followed by one newline.",
      `Remember this new opaque token for the next round: ${input.secondToken}`,
      "Keep the new token only in conversation context in this round.",
      "Do not modify round-one.txt, round-three.txt, or any other file.",
      "After the exact verification succeeds, mark the active Goal complete before the final summary.",
    ].join("\n"),
  });
  const third = input.createRequest({
    executionId: "goal-round-3",
    runId: `${input.runIdPrefix}-round-3`,
    prompt: [
      "Continue the same logical thread.",
      "Recall all three opaque context tokens supplied across the two previous rounds; none is repeated here.",
      "Edit only round-three.txt so its lines contain, in order, the first-round primary token, the first-round long-horizon token, and the second-round token, with a final newline.",
      "Do not modify round-one.txt, context.txt, or any other file.",
      "After the exact verification succeeds, mark the active Goal complete before the final summary.",
    ].join("\n"),
  });
  return { first, second, third };
}

export async function runLogicalThreadContinuationScenario(input) {
  const canonicalRequests = buildLogicalThreadContinuationRequests(input);
  const { first: firstRequest, second: secondRequest, third: thirdRequest } =
    input.requests ?? canonicalRequests;
  assert.deepEqual(
    { first: firstRequest, second: secondRequest, third: thirdRequest },
    canonicalRequests,
    "logical-thread requests must preserve exact round content and order",
  );
  for (const request of [secondRequest, thirdRequest]) {
    assert.deepEqual(firstRequest.task.execution, request.task.execution);
    assert.deepEqual(firstRequest.task.controls, request.task.controls);
  }

  let restartCount = 0;
  const restart = async (options) => {
    await input.restart(options);
    restartCount += 1;
  };
  const invocationCount = () => input.providerInvocationCount();

  const first = await input.run(firstRequest);
  input.assertCompleted(first, input.outcomes.startedFresh, "round one");
  assert.equal(await input.readWorkspaceFile("round-one.txt"), "ready\n");
  assert.equal(await input.readWorkspaceFile("context.txt"), "unset\n");
  assert.equal(await input.readWorkspaceFile("round-three.txt"), "unset\n");
  assert.equal(invocationCount(), 1);
  const firstRoundSnapshot = await input.readWorkspaceSnapshot();
  let forbiddenTokensAbsentFromWorkspaceSnapshots = [
    input.firstToken,
    input.longHorizonToken,
    input.secondToken,
  ].every((token) => !firstRoundSnapshot.includes(token));

  await restart({ replayOnly: true });
  const beforeFirstReplay = invocationCount();
  const firstReplay = await input.run(firstRequest);
  const exactReplayChecks = [isDeepStrictEqual(firstReplay, first)];
  let exactReplayProviderSideEffects = invocationCount() - beforeFirstReplay;
  assert.equal(await input.readWorkspaceSnapshot(), firstRoundSnapshot);

  await restart();
  const second = await input.run(secondRequest);
  input.assertCompleted(second, input.outcomes.continued, "round two");
  const exactContextRecallChecks = [
    await input.readWorkspaceFile("context.txt") === `${input.firstToken}\n`,
  ];
  assert.equal(await input.readWorkspaceFile("round-three.txt"), "unset\n");
  assert.equal(invocationCount(), 2);
  const secondRoundSnapshot = await input.readWorkspaceSnapshot();
  forbiddenTokensAbsentFromWorkspaceSnapshots &&=
    [input.longHorizonToken, input.secondToken].every(
      (token) => !secondRoundSnapshot.includes(token),
    );
  const longHorizonTokenAbsentFromRoundTwoOutput =
    !input.resultOutputText(second).includes(input.longHorizonToken);

  await restart({ replayOnly: true });
  const beforeSecondReplay = invocationCount();
  const secondReplay = await input.run(secondRequest);
  exactReplayChecks.push(isDeepStrictEqual(secondReplay, second));
  exactReplayProviderSideEffects += invocationCount() - beforeSecondReplay;
  assert.equal(await input.readWorkspaceSnapshot(), secondRoundSnapshot);

  await restart();
  const third = await input.run(thirdRequest);
  input.assertCompleted(third, input.outcomes.continued, "round three");
  exactContextRecallChecks.push(
    await input.readWorkspaceFile("round-three.txt") ===
      `${input.firstToken}\n${input.longHorizonToken}\n${input.secondToken}\n`,
  );
  assert.equal(invocationCount(), 3);

  await restart({ replayOnly: true });
  const beforeThirdReplay = invocationCount();
  const thirdReplay = await input.run(thirdRequest);
  exactReplayChecks.push(isDeepStrictEqual(thirdReplay, third));
  exactReplayProviderSideEffects += invocationCount() - beforeThirdReplay;

  await input.writeWorkspaceFile("round-three.txt", "tampered\n");
  const staleReplay = await input.run(thirdRequest);
  const staleWorkspaceFailedClosed = input.matchesStaleFailure(staleReplay) &&
    invocationCount() === beforeThirdReplay;
  await input.writeWorkspaceFile(
    "round-three.txt",
    `${input.firstToken}\n${input.longHorizonToken}\n${input.secondToken}\n`,
  );
  const restoredReplay = await input.run(thirdRequest);
  const workspaceBoundaryPreserved =
    await input.observeFinalWorkspaceBoundary();

  return {
    requests: { first: firstRequest, second: secondRequest, third: thirdRequest },
    results: { first, second, third },
    exactContextRecallChecks,
    restartCount,
    exactReplayChecks,
    exactReplayProviderSideEffects,
    restoredEffectRecovered: isDeepStrictEqual(restoredReplay, third) &&
      invocationCount() === beforeThirdReplay,
    staleWorkspaceFailedClosed,
    forbiddenTokensAbsentFromWorkspaceSnapshots,
    longHorizonTokenAbsentFromRoundTwoOutput,
    workspaceBoundaryPreserved,
  };
}
