import {
  createHostedSubscriptionPreparationOwner, prepareHostedSubscriptionConsumer,
  type CodexSubscriptionPreparationInput, type CodexSubscriptionPreparationOwner,
  type CodexSubscriptionPreparationView,
} from "@vioxen/subscription-runtime/provider-codex";

/** Retain privately before calling prepare. Pure validation never launches a provider. */
export function createCodexSubscriptionPreparationOwner(input: CodexSubscriptionPreparationInput): CodexSubscriptionPreparationOwner {
  return createHostedSubscriptionPreparationOwner(input);
}
/** Concrete filesystem preparation only. The public view contains no launch resources. */
export function prepareCodexSubscriptionConsumer(input: {
  readonly preparationOwner: CodexSubscriptionPreparationOwner;
}): Promise<CodexSubscriptionPreparationView> {
  return prepareHostedSubscriptionConsumer(input.preparationOwner);
}
